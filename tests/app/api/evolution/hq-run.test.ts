/**
 * HQ run — the field↔HQ communication shell (v0.21 §4, P4b).
 *
 * The workflow runtime primitives (createHook / sleep) and the runtime API
 * (resumeHook) are mocked; the HQ agent (hq-agent.ts's handleBrief) is
 * stubbed. No real durable run is executed — that is the main agent's live
 * verification.
 *
 * Pins: conflict → handoff-then-exit (order), idle-grace exit, multi-brief
 * loop, and the P4b handoff shape — the brief prose goes to the HQ agent
 * VERBATIM (no pointer extraction in the shell), with the date stamp and the
 * replyToken's slice pointer as the only shell-owned facts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  /** call-order log: handoff must precede run resolution */
  order: [] as string[],
  /** the data-hq-activity chunks written into the run's stream */
  frames: [] as Array<{ type: string; id: string; data: unknown }>,
  /** field returns (回程): resumeHook calls whose token is NOT HQ_TOKEN */
  fieldReturns: [] as Array<{ token: string; value: unknown }>,
  resumeHook: vi.fn(async (token: string, value?: unknown) => {
    // Claim/handoff calls (HQ_TOKEN) join the order log; the field return
    // rides after the round and is tracked apart from that ordering.
    if (token === HQ_TOKEN) {
      h.order.push("handoff");
    } else {
      h.fieldReturns.push({ token, value });
    }
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

import { hqRun, HQ_TOKEN, type HQBriefPayload } from "@/app/api/evolution/hq-run";
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

const BRIEF: HQBriefPayload = {
  brief: "现场：用户提到 2026-10-04-0131 里谈过的屏幕供应商，观察：值得跟进。",
  replyToken: "field:2026-10-04-0131:2026-10-04T01:31:00.000Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  h.order.length = 0;
  h.frames.length = 0;
  h.fieldReturns.length = 0;
  h.behavior = { conflict: null, queue: [], pend: true };
});

describe("hqRun — claim and conflict", () => {
  it("no conflict → claims the token and hands the initial brief to the HQ agent verbatim", async () => {
    const outcome = await hqRun(BRIEF);
    expect(outcome).toEqual({ kind: "claimed", handled: 1 });
    // P4b: NO pointer extraction in the shell — the prose rides verbatim;
    // the slice pointer comes from the mechanical replyToken, the date is
    // the UTC stamp (the same clock slice ids are named by).
    expect(h.handleBrief).toHaveBeenCalledTimes(1);
    expect(h.handleBrief).toHaveBeenCalledWith({
      brief: BRIEF.brief,
      date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      sliceId: "2026-10-04-0131",
    });
    // No HQ_TOKEN handoff — but the round's note rode back on the brief's
    // replyToken (§4 回程, best-effort: this mock's hook is always there).
    expect(h.order).not.toContain("handoff");
    expect(h.fieldReturns).toEqual([
      { token: BRIEF.replyToken, value: "idle — nothing substantive" },
    ]);
  });

  it("the status pointer follows the claim: running at start, settled at finish", async () => {
    await hqRun(BRIEF);
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

  it("a brief that landed writes settles the run as wrote; a failed brief as errored", async () => {
    h.handleBrief.mockResolvedValueOnce({
      actions: ["memory/people/user/index.md"],
      note: "wrote the user model",
    });
    await hqRun(BRIEF);
    expect(h.recordBriefOutcome).toHaveBeenCalledWith({
      actions: ["memory/people/user/index.md"],
    });
    expect(h.recordRunFinished).toHaveBeenCalledWith({
      handled: 1,
      wrote: true,
      errored: false,
    });
    // a successful round's note rides back to the field
    expect(h.fieldReturns).toEqual([
      { token: BRIEF.replyToken, value: "wrote the user model" },
    ]);

    vi.clearAllMocks();
    h.order.length = 0;
    h.fieldReturns.length = 0;
    h.handleBrief.mockResolvedValueOnce({
      actions: [],
      note: "",
      error: "no default model configured",
    });
    await hqRun(BRIEF);
    expect(h.recordRunFinished).toHaveBeenCalledWith({
      handled: 1,
      wrote: false,
      errored: true,
    });
    // a failed round has nothing to say — no field return
    expect(h.fieldReturns).toEqual([]);
  });

  it("a payload.date rides through as the round's date stamp (the field's local clock, not UTC)", async () => {
    await hqRun({ ...BRIEF, date: "2026-10-03" });
    expect(h.handleBrief).toHaveBeenCalledWith({
      brief: BRIEF.brief,
      date: "2026-10-03",
      sliceId: "2026-10-04-0131",
    });
  });

  it("a replyToken without a slice id → sliceId omitted (the brief prose is still whole)", async () => {
    await hqRun({ brief: "没有指针的简报。", replyToken: "field::2026-10-04T01:31:00.000Z" });
    expect(h.handleBrief).toHaveBeenCalledWith({
      brief: "没有指针的简报。",
      date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    });
  });

  it("a non-field replyToken → no slice pointer, brief still handed over", async () => {
    await hqRun({ brief: "外来 token。", replyToken: "something-else" });
    expect(h.handleBrief).toHaveBeenCalledWith({
      brief: "外来 token。",
      date: expect.any(String),
    });
  });

  it("conflict → hands the brief to the PRIMARY first, then exits deduped", async () => {
    h.behavior = { conflict: { runId: "run-primary" }, queue: [], pend: true };
    const outcome = await hqRun(BRIEF);
    expect(outcome).toEqual({ kind: "dedupedTo", runId: "run-primary" });
    // the brief was forwarded BEFORE the run resolved (handoff-then-exit)
    expect(h.resumeHook).toHaveBeenCalledTimes(1);
    expect(h.resumeHook).toHaveBeenCalledWith(HQ_TOKEN, BRIEF);
    expect(h.order).toEqual(["handoff"]);
    // a deduped rival does no HQ work itself — and never touches the status
    // pointer, which the PRIMARY's run owns
    expect(h.handleBrief).not.toHaveBeenCalled();
    expect(h.recordRunStarted).not.toHaveBeenCalled();
    expect(h.recordRunFinished).not.toHaveBeenCalled();
  });

  it("handoff lost to a finished primary (HookNotFoundError), no new primary → the run CLAIMS and processes the brief itself", async () => {
    // The primary finished inside the handoff window: resumeHook finds no
    // hook, and the bounded re-check finds no new conflict — the brief must
    // NOT die silently.
    h.behavior = {
      conflict: { runId: "run-primary" },
      conflicts: [{ runId: "run-primary" }, null],
      queue: [],
      pend: true,
    };
    h.resumeHook.mockRejectedValueOnce(new HookNotFoundError(HQ_TOKEN));
    const outcome = await hqRun(BRIEF);
    expect(outcome).toEqual({ kind: "claimed", handled: 1 });
    // two resumeHook calls: the lost handoff, then the round's field return
    expect(h.resumeHook).toHaveBeenCalledTimes(2);
    expect(h.handleBrief).toHaveBeenCalledTimes(1);
    expect(h.handleBrief).toHaveBeenCalledWith({
      brief: BRIEF.brief,
      date: expect.any(String),
      sliceId: "2026-10-04-0131",
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
    const outcome = await hqRun(BRIEF);
    expect(outcome).toEqual({ kind: "dedupedTo", runId: "run-primary-2" });
    expect(h.resumeHook).toHaveBeenCalledTimes(2);
    expect(h.handleBrief).not.toHaveBeenCalled();
  });
});

describe("hqRun — the field return (v0.21 §4 回程, bonus not channel)", () => {
  it("a gone field hook (HookNotFoundError) passes silently — the round still settles", async () => {
    // The field's hook registers only when its turn run suspends on the
    // closing peek — an early/late HQ shout misses it, and that is normal.
    h.resumeHook.mockRejectedValueOnce(new HookNotFoundError(BRIEF.replyToken));
    const outcome = await hqRun(BRIEF);
    expect(outcome).toEqual({ kind: "claimed", handled: 1 });
    expect(h.resumeHook).toHaveBeenCalledTimes(1);
    expect(h.resumeHook).toHaveBeenCalledWith(BRIEF.replyToken, "idle — nothing substantive");
    // the run was not dragged down by the missed return
    expect(h.recordRunFinished).toHaveBeenCalledWith({
      handled: 1,
      wrote: false,
      errored: false,
    });
  });

  it("any OTHER return failure is warned and swallowed, never thrown", async () => {
    h.resumeHook.mockRejectedValueOnce(new Error("world store down"));
    const outcome = await hqRun(BRIEF);
    expect(outcome).toEqual({ kind: "claimed", handled: 1 });
    expect(h.recordRunFinished).toHaveBeenCalledWith({
      handled: 1,
      wrote: false,
      errored: false,
    });
  });

  it("an empty note (a veto with nothing to say) does NOT call back", async () => {
    h.handleBrief.mockResolvedValueOnce({ actions: [], note: "" });
    const outcome = await hqRun(BRIEF);
    expect(outcome).toEqual({ kind: "claimed", handled: 1 });
    expect(h.resumeHook).not.toHaveBeenCalled();
  });

  it("a multi-brief run returns each round's note on its OWN replyToken", async () => {
    const second: HQBriefPayload = {
      brief: "又一条，同片 2026-10-04-0131。",
      replyToken: "field:2026-10-04-0131:2026-10-04T01:35:00.000Z",
    };
    h.behavior = { conflict: null, queue: [second], pend: true };
    h.handleBrief
      .mockResolvedValueOnce({ actions: [], note: "第一轮陈述。" })
      .mockResolvedValueOnce({ actions: [], note: "第二轮陈述。" });
    const outcome = await hqRun(BRIEF);
    expect(outcome).toEqual({ kind: "claimed", handled: 2 });
    expect(h.fieldReturns).toEqual([
      { token: BRIEF.replyToken, value: "第一轮陈述。" },
      { token: second.replyToken, value: "第二轮陈述。" },
    ]);
  });
});

describe("hqRun — the work loop", () => {
  it("idle grace expiring ends the run (sleep arm wins the race)", async () => {
    const outcome = await hqRun(BRIEF);
    expect(outcome).toEqual({ kind: "claimed", handled: 1 });
  });

  it("a queued brief arrives before the grace → handled, then idle exit", async () => {
    const second: HQBriefPayload = { brief: "又一条，同片 2026-10-04-0131。", replyToken: BRIEF.replyToken };
    h.behavior = { conflict: null, queue: [second], pend: true };
    const outcome = await hqRun(BRIEF);
    expect(outcome).toEqual({ kind: "claimed", handled: 2 });
    expect(h.handleBrief).toHaveBeenCalledTimes(2);
    // each brief keeps its OWN prose and token-derived pointer
    expect(h.handleBrief).toHaveBeenNthCalledWith(2, {
      brief: second.brief,
      date: expect.any(String),
      sliceId: "2026-10-04-0131",
    });
    // the finish mark carries the run's definitive count across BOTH briefs
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
    await hqRun(BRIEF);
    expect(h.frames.length).toBeGreaterThan(0);
    for (const f of h.frames) expect(f.type).toBe("data-hq-activity");
    expect(new Set(h.frames.map((f) => f.id)).size).toBe(h.frames.length);
  });

  it("an idle run beats: started → reading → idle(note) → finished(idle)", async () => {
    await hqRun(BRIEF);
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
    await hqRun(BRIEF);
    expect(kinds()).toEqual(["started", "reading", "wrote", "finished"]);
    expect(h.frames[2].data).toMatchObject({
      paths: ["memory/research/screen-vendor/index.md"],
      note: "核对切片后写下一个案件。",
    });
    expect(h.frames[3].data).toMatchObject({ status: "completed", handled: 1 });
  });

  it("a failed brief beats failed(error) and the run settles failed", async () => {
    h.handleBrief.mockResolvedValueOnce({
      actions: [],
      note: "",
      error: "no default model configured",
    });
    await hqRun(BRIEF);
    expect(kinds()).toEqual(["started", "reading", "failed", "finished"]);
    expect(h.frames[2].data).toMatchObject({
      error: "no default model configured",
    });
    expect(h.frames[3].data).toMatchObject({ status: "failed", handled: 1 });
  });

  it("a multi-brief run repeats the round beats; a deduped rival emits NOTHING", async () => {
    const second: HQBriefPayload = { brief: "又一条。", replyToken: BRIEF.replyToken };
    h.behavior = { conflict: null, queue: [second], pend: true };
    await hqRun(BRIEF);
    expect(kinds()).toEqual([
      "started",
      "reading", "idle",
      "reading", "idle",
      "finished",
    ]);

    vi.clearAllMocks();
    h.frames.length = 0;
    h.behavior = { conflict: { runId: "run-primary" }, queue: [], pend: true };
    await hqRun(BRIEF);
    // the rival's stream is dead on arrival — nobody attaches to it
    expect(h.frames).toEqual([]);
  });
});
