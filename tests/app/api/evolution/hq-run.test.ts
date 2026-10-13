/**
 * HQ run — the reflection unit's shell (v0.21 §4, P4b; v0.30 §2 机械铃).
 *
 * The workflow runtime primitives (createHook / sleep) and the runtime API
 * (resumeHook) are mocked; the reflection unit (hq-agent.ts's handleBrief) is
 * stubbed. No real durable run is executed — that is the main agent's live
 * verification.
 *
 * Pins: conflict → handoff-then-exit (order), idle-grace exit, multi-wake
 * loop, and the v0.30 handoff shape — the wake's pointer goes to the unit
 * VERBATIM ({sliceId?, turnId?}; there is NO semantic payload), with the date
 * stamp as the only shell-owned fact (the record is the channel, §2.2).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  /** call-order log: handoff must precede run resolution */
  order: [] as string[],
  /** the data-hq-activity chunks written into the run's stream */
  frames: [] as Array<{ type: string; id: string; data: unknown }>,
  resumeHook: vi.fn(async () => {
    // Conflict handoffs (HQ_TOKEN) join the order log.
    h.order.push("handoff");
    return { runId: "run-primary" };
  }),
  handleBrief: vi.fn(
    async (): Promise<{ actions: string[]; note: string; error?: string }> => {
      h.order.push("handleBrief");
      return { actions: [], note: "idle — nothing substantive" };
    },
  ),
  /** the hq.json status pointer — mocked so tests never touch real memory/ */
  recordRunStarted: vi.fn(async (_runId?: string) => {
    h.order.push("runStarted");
  }),
  recordBriefOutcome: vi.fn(async () => {}),
  recordRunFinished: vi.fn(async () => {
    h.order.push("runFinished");
  }),
  /** per-test hook behavior, installed by makeHook */
  behavior: null as null | {
    conflict: { runId: string } | null;
    /** when set, getConflict() consumes this sequence instead of `conflict` */
    conflicts?: Array<{ runId: string } | null>;
    queue: unknown[];
    pend: boolean;
  },
}));

vi.mock("workflow", () => ({
  createHook: () => makeHook(),
  sleep: (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5))),
  // the run's durable id, read inside the claiming run's step
  getWorkflowMetadata: () => ({ workflowRunId: "run-1" }),
  // the run stream's writable — frames land in h.frames
  getWritable: () => ({
    getWriter: () => ({
      write: async (chunk: { type: string; id: string; data: unknown }) => {
        h.frames.push(chunk);
      },
      releaseLock: () => {},
    }),
  }),
}));

vi.mock("workflow/api", () => ({
  resumeHook: h.resumeHook,
}));

vi.mock("@/app/api/evolution/hq-agent", () => ({
  handleBrief: h.handleBrief,
}));

vi.mock("@/app/api/evolution/hq-status-store", () => ({
  recordHQRunStarted: h.recordRunStarted,
  recordHQBriefOutcome: h.recordBriefOutcome,
  recordHQRunFinished: h.recordRunFinished,
}));

import { hqRun, HQ_TOKEN, type ReflectionWakePayload } from "@/app/api/evolution/hq-run";
import { HookNotFoundError } from "workflow/errors";

interface FakeHook {
  token?: string;
  getConflict: () => Promise<{ runId: string } | null>;
  [Symbol.asyncIterator]: () => AsyncIterator<unknown>;
  dispose: () => void;
  disposed?: boolean;
}

function makeHook(): FakeHook {
  const behavior = h.behavior ?? { conflict: null, queue: [], pend: true };
  const conflicts = behavior.conflicts ? [...behavior.conflicts] : null;
  return {
    getConflict: async () =>
      conflicts && conflicts.length > 0 ? conflicts.shift()! : behavior.conflict,
    [Symbol.asyncIterator]: () => {
      let i = 0;
      return {
        next: () => {
          if (i < behavior.queue.length) {
            const value = behavior.queue[i];
            i += 1;
            return Promise.resolve({ value, done: false });
          }
          // default: pends forever — the sleep arm of the race wins
          return new Promise(() => {});
        },
        return: () => Promise.resolve({ value: undefined, done: true }),
      };
    },
    dispose() {
      this.disposed = true;
    },
  };
}

const WAKE: ReflectionWakePayload = {
  sliceId: "2026-10-04-0131",
  turnId: "turn-1",
};

beforeEach(() => {
  vi.clearAllMocks();
  h.order.length = 0;
  h.frames.length = 0;
  h.behavior = { conflict: null, queue: [], pend: true };
});

describe("hqRun — claim and conflict", () => {
  it("no conflict → claims the token and hands the wake's pointer to the unit verbatim", async () => {
    const outcome = await hqRun(WAKE);
    expect(outcome).toEqual({ kind: "claimed", handled: 1 });
    // v0.30 §2.2: NO semantic payload at all — the pointer rides verbatim;
    // the date is the UTC-stamp fallback (this wake carried no payload.date).
    expect(h.handleBrief).toHaveBeenCalledTimes(1);
    expect(h.handleBrief).toHaveBeenCalledWith({
      date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      sliceId: "2026-10-04-0131",
      turnId: "turn-1",
    });
    // No HQ_TOKEN handoff — a claiming run works its own wake.
    expect(h.order).not.toContain("handoff");
  });

  it("the status pointer follows the claim: running at start, settled at finish", async () => {
    await hqRun(WAKE);
    expect(h.recordRunStarted).toHaveBeenCalledTimes(1);
    // the run's OWN durable id rides the start mark (never a dispatch's say-so)
    expect(h.recordRunStarted).toHaveBeenCalledWith("run-1");
    expect(h.recordBriefOutcome).toHaveBeenCalledWith({ actions: [] });
    expect(h.recordRunFinished).toHaveBeenCalledTimes(1);
    expect(h.recordRunFinished).toHaveBeenCalledWith({
      handled: 1,
      wrote: false,
      errored: false,
    });
    // started precedes finished
    expect(h.order).toEqual(["runStarted", "handleBrief", "runFinished"]);
  });

  it("a wake whose round wrote settles the run as wrote; a failed round as errored", async () => {
    h.handleBrief.mockResolvedValueOnce({
      actions: ["memory/people/user/index.md"],
      note: "wrote the user model",
    });
    await hqRun(WAKE);
    expect(h.recordBriefOutcome).toHaveBeenCalledWith({
      actions: ["memory/people/user/index.md"],
    });
    expect(h.recordRunFinished).toHaveBeenCalledWith({
      handled: 1,
      wrote: true,
      errored: false,
    });

    vi.clearAllMocks();
    h.order.length = 0;
    h.handleBrief.mockResolvedValueOnce({
      actions: [],
      note: "",
      error: "no default model configured",
    });
    await hqRun(WAKE);
    expect(h.recordRunFinished).toHaveBeenCalledWith({
      handled: 1,
      wrote: false,
      errored: true,
      error: "no default model configured",
    });
  });

  it("an exception escaping the loop still settles the pointer — failed, with the exception's own message", async () => {
    h.handleBrief.mockRejectedValueOnce(new Error("sub-agent blew up"));
    await expect(hqRun(WAKE)).rejects.toThrow("sub-agent blew up");
    expect(h.recordRunFinished).toHaveBeenCalledWith({
      handled: 0,
      wrote: false,
      errored: true,
      error: "sub-agent blew up",
    });
  });

  it("a payload.date rides through as the round's date stamp (the field's local clock, not UTC)", async () => {
    await hqRun({ ...WAKE, date: "2026-10-03" });
    expect(h.handleBrief).toHaveBeenCalledWith({
      date: "2026-10-03",
      sliceId: "2026-10-04-0131",
      turnId: "turn-1",
    });
  });

  it("a bare wake ({}) hands over only the date stamp — the unit re-reads from its own pointers", async () => {
    // The cancel route holds only a runId, so its wake names nothing (§2.1).
    await hqRun({});
    expect(h.handleBrief).toHaveBeenCalledWith({
      date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    });
  });

  it("a wake naming only a turn still rides verbatim — no sliceId is invented", async () => {
    await hqRun({ turnId: "turn-9" });
    expect(h.handleBrief).toHaveBeenCalledWith({
      date: expect.any(String),
      turnId: "turn-9",
    });
  });

  it("conflict → hands the wake to the PRIMARY first, then exits deduped", async () => {
    h.behavior = { conflict: { runId: "run-primary" }, queue: [], pend: true };
    const outcome = await hqRun(WAKE);
    expect(outcome).toEqual({ kind: "dedupedTo", runId: "run-primary" });
    // the wake was forwarded BEFORE the run resolved (handoff-then-exit)
    expect(h.resumeHook).toHaveBeenCalledTimes(1);
    expect(h.resumeHook).toHaveBeenCalledWith(HQ_TOKEN, WAKE);
    expect(h.order).toEqual(["handoff"]);
    // a deduped rival does no HQ work itself — and never touches the status
    // pointer, which the PRIMARY's run owns
    expect(h.handleBrief).not.toHaveBeenCalled();
    expect(h.recordRunStarted).not.toHaveBeenCalled();
    expect(h.recordRunFinished).not.toHaveBeenCalled();
  });

  it("handoff lost to a finished primary (HookNotFoundError), no new primary → the run CLAIMS and processes the wake itself", async () => {
    // The primary finished inside the handoff window: resumeHook finds no
    // hook, and the bounded re-check finds no new conflict — the wake must
    // NOT die silently.
    h.behavior = {
      conflict: { runId: "run-primary" },
      conflicts: [{ runId: "run-primary" }, null],
      queue: [],
      pend: true,
    };
    h.resumeHook.mockRejectedValueOnce(new HookNotFoundError(HQ_TOKEN));
    const outcome = await hqRun(WAKE);
    expect(outcome).toEqual({ kind: "claimed", handled: 1 });
    // one resumeHook call: the lost handoff (there is no field return anymore)
    expect(h.resumeHook).toHaveBeenCalledTimes(1);
    expect(h.handleBrief).toHaveBeenCalledTimes(1);
    expect(h.handleBrief).toHaveBeenCalledWith({
      date: expect.any(String),
      sliceId: "2026-10-04-0131",
      turnId: "turn-1",
    });
    // the fallen-back run owns the status pointer like any claiming run
    expect(h.order).toEqual(["runStarted", "handleBrief", "runFinished"]);
  });

  it("handoff lost but a NEW primary claimed meanwhile → re-handoff, then deduped exit", async () => {
    h.behavior = {
      conflict: { runId: "run-primary" },
      conflicts: [{ runId: "run-primary" }, { runId: "run-primary-2" }],
      queue: [],
      pend: true,
    };
    h.resumeHook.mockRejectedValueOnce(new HookNotFoundError(HQ_TOKEN));
    const outcome = await hqRun(WAKE);
    expect(outcome).toEqual({ kind: "dedupedTo", runId: "run-primary-2" });
    expect(h.resumeHook).toHaveBeenCalledTimes(2);
    expect(h.handleBrief).not.toHaveBeenCalled();
  });
});

describe("hqRun — the work loop", () => {
  it("idle grace expiring ends the run (sleep arm wins the race)", async () => {
    const outcome = await hqRun(WAKE);
    expect(outcome).toEqual({ kind: "claimed", handled: 1 });
  });

  it("a queued wake arrives before the grace → handled, then idle exit", async () => {
    const second: ReflectionWakePayload = { sliceId: "2026-10-04-0131", turnId: "turn-2" };
    h.behavior = { conflict: null, queue: [second], pend: true };
    const outcome = await hqRun(WAKE);
    expect(outcome).toEqual({ kind: "claimed", handled: 2 });
    expect(h.handleBrief).toHaveBeenCalledTimes(2);
    // each wake keeps its OWN pointer
    expect(h.handleBrief).toHaveBeenNthCalledWith(2, {
      date: expect.any(String),
      sliceId: "2026-10-04-0131",
      turnId: "turn-2",
    });
    // the finish mark carries the run's definitive count across BOTH wakes
    expect(h.recordBriefOutcome).toHaveBeenCalledTimes(2);
    expect(h.recordRunFinished).toHaveBeenCalledWith({
      handled: 2,
      wrote: false,
      errored: false,
    });
  });
});

describe("hqRun — the activity frames (the pod's live feed)", () => {
  /** The frame kinds in stream order. */
  const kinds = () => h.frames.map((f) => (f.data as { kind: string }).kind);

  it("every chunk is a data-hq-activity frame with a unique id", async () => {
    await hqRun(WAKE);
    expect(h.frames.length).toBeGreaterThan(0);
    for (const f of h.frames) expect(f.type).toBe("data-hq-activity");
    expect(new Set(h.frames.map((f) => f.id)).size).toBe(h.frames.length);
  });

  it("an idle run beats: started → reading → idle(note) → finished(idle)", async () => {
    await hqRun(WAKE);
    expect(kinds()).toEqual(["started", "reading", "idle", "finished"]);
    const reading = h.frames[1].data as { sliceId?: string };
    expect(reading.sliceId).toBe("2026-10-04-0131");
    // HQ's own account rides the idle frame — the veto's short reason lives here
    const idle = h.frames[2].data as { note?: string };
    expect(idle.note).toBe("idle — nothing substantive");
    const finished = h.frames[3].data as { status?: string; handled?: number };
    expect(finished).toMatchObject({ status: "idle", handled: 1 });
  });

  it("a writing run beats wrote(paths + note) and settles completed", async () => {
    h.handleBrief.mockResolvedValueOnce({
      actions: ["memory/research/screen-vendor/index.md"],
      note: "核对切片后写下一个案件。",
    });
    await hqRun(WAKE);
    expect(kinds()).toEqual(["started", "reading", "wrote", "finished"]);
    expect(h.frames[2].data).toMatchObject({
      paths: ["memory/research/screen-vendor/index.md"],
      note: "核对切片后写下一个案件。",
    });
    expect(h.frames[3].data).toMatchObject({ status: "completed", handled: 1 });
  });

  it("a failed round beats failed(error) and the run settles failed", async () => {
    h.handleBrief.mockResolvedValueOnce({
      actions: [],
      note: "",
      error: "no default model configured",
    });
    await hqRun(WAKE);
    expect(kinds()).toEqual(["started", "reading", "failed", "finished"]);
    expect(h.frames[2].data).toMatchObject({
      error: "no default model configured",
    });
    expect(h.frames[3].data).toMatchObject({ status: "failed", handled: 1 });
  });

  it("a multi-wake run repeats the round beats; a deduped rival emits NOTHING", async () => {
    const second: ReflectionWakePayload = { sliceId: "2026-10-04-0131", turnId: "turn-2" };
    h.behavior = { conflict: null, queue: [second], pend: true };
    await hqRun(WAKE);
    expect(kinds()).toEqual([
      "started",
      "reading", "idle",
      "reading", "idle",
      "finished",
    ]);

    vi.clearAllMocks();
    h.frames.length = 0;
    h.behavior = { conflict: { runId: "run-primary" }, queue: [], pend: true };
    await hqRun(WAKE);
    // the rival's stream is dead on arrival — nobody attaches to it
    expect(h.frames).toEqual([]);
  });
});
