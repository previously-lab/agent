/**
 * Reflection run — the reflection unit's resident shell (v0.34 常驻形态 R1).
 *
 * The workflow runtime primitives (createHook / sleep / getWritable /
 * getWorkflowMetadata) and the runtime API (resumeHook / start) are mocked;
 * the reflection unit (hq-agent.ts's handleBrief) and the status store are
 * stubbed. reflection-steps.ts runs for REAL — only its impure edges are
 * mocked. No real durable run is executed — that is the main agent's live
 * verification.
 *
 * Pins: conflict → handoff-then-exit (order), the resident loop (ONE round
 * per lap off the drained mailbox's FURTHEST pointer — N bells ≠ N rounds),
 * per-round immediate settlement (the D2 finish-time batching retired), the
 * idle exit at a lap boundary (the 60-minute visit grace wins the blocking
 * race → settle {idle} → dispose → return; NO successor — the next bell's
 * delivery fallback starts the next generation off the on-disk cursor), and
 * the wake's pointer going to the unit VERBATIM ({sliceId?} + the date
 * stamp — no semantic payload, no turnId, §2.2).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  /** call-order log: handoff/idle-exit/dispose ordering matters */
  order: [] as string[],
  /** the data-hq-activity chunks written into the run's stream */
  frames: [] as Array<{ type: string; id: string; data: unknown }>,
  resumeHook: vi.fn(async () => {
    // Conflict handoffs (REFLECTION_TOKEN) join the order log.
    h.order.push("handoff");
    return { runId: "run-primary" };
  }),
  /** workflow/api start() — the RUN itself must never call it (no successor
   *  relay; fresh generations belong to the delivery path's fallback) */
  start: vi.fn(async () => ({ runId: "start-must-not-be-called" })),
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
  recordRoundSettled: vi.fn(async (_round: Record<string, unknown>) => {
    h.order.push("settle");
  }),
  recordIdleExit: vi.fn(async (_result: { rounds: number }) => {
    h.order.push("idleExit");
  }),
  /** per-test hook behavior, installed by makeHook */
  behavior: null as null | {
    conflict: { runId: string } | null;
    /** when set, getConflict() consumes this sequence instead of `conflict` */
    conflicts?: Array<{ runId: string } | null>;
    queue: unknown[];
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
  start: h.start,
}));

vi.mock("@/app/api/evolution/hq-agent", () => ({
  handleBrief: h.handleBrief,
}));

vi.mock("@/app/api/evolution/hq-status-store", () => ({
  recordHQRunStarted: h.recordRunStarted,
  recordReflectionRoundSettled: h.recordRoundSettled,
  recordReflectionRunIdleExit: h.recordIdleExit,
}));

import {
  reflectionRun,
  REFLECTION_TOKEN,
  furthestWakePointer,
  type ReflectionWakePayload,
} from "@/app/api/evolution/reflection-run";
import { HookNotFoundError } from "workflow/errors";

interface FakeHook {
  token?: string;
  getConflict: () => Promise<{ runId: string } | null>;
  [Symbol.asyncIterator]: () => AsyncIterator<unknown>;
  dispose: () => void;
  disposed?: boolean;
}

function makeHook(): FakeHook {
  const behavior = h.behavior ?? { conflict: null, queue: [] };
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
          // default: pends forever — a sleep arm of the race wins
          return new Promise(() => {});
        },
        return: () => Promise.resolve({ value: undefined, done: true }),
      };
    },
    dispose() {
      h.order.push("dispose");
      this.disposed = true;
    },
  };
}

const WAKE: ReflectionWakePayload = { sliceId: "2026-10-04-0131" };

beforeEach(() => {
  vi.clearAllMocks();
  h.order.length = 0;
  h.frames.length = 0;
  h.behavior = { conflict: null, queue: [] };
});

describe("reflectionRun — claim and conflict", () => {
  it("conflict → hands the wake to the PRIMARY first, then exits deduped", async () => {
    h.behavior = { conflict: { runId: "run-primary" }, queue: [] };
    const outcome = await reflectionRun(WAKE);
    expect(outcome).toEqual({ kind: "dedupedTo", runId: "run-primary" });
    // the wake was forwarded BEFORE the run resolved (handoff-then-exit)
    expect(h.resumeHook).toHaveBeenCalledTimes(1);
    expect(h.resumeHook).toHaveBeenCalledWith(REFLECTION_TOKEN, WAKE);
    // handoff-then-exit; the trailing dispose is the rival releasing its own
    // hook registration (the outer finally covers every exit)
    expect(h.order).toEqual(["handoff", "dispose"]);
    // a deduped rival does no reflection work itself — and never touches the
    // status pointer, which the PRIMARY's run owns
    expect(h.handleBrief).not.toHaveBeenCalled();
    expect(h.recordRunStarted).not.toHaveBeenCalled();
    expect(h.recordIdleExit).not.toHaveBeenCalled();
    // its stream is dead on arrival — nobody attaches to it
    expect(h.frames).toEqual([]);
  });

  it("conflict but NO wake → yields without any handoff (nothing to hand over)", async () => {
    h.behavior = { conflict: { runId: "run-primary" }, queue: [] };
    const outcome = await reflectionRun();
    expect(outcome).toEqual({ kind: "dedupedTo", runId: "run-primary" });
    expect(h.resumeHook).not.toHaveBeenCalled();
    expect(h.handleBrief).not.toHaveBeenCalled();
  });

  it("handoff lost to a finished primary (HookNotFoundError), no new primary → the run CLAIMS and processes the wake itself", async () => {
    // The primary finished inside the handoff window: resumeHook finds no
    // hook, and the bounded re-check finds no new conflict — the wake must
    // NOT die silently.
    h.behavior = {
      conflict: { runId: "run-primary" },
      conflicts: [{ runId: "run-primary" }, null],
      queue: [],
    };
    h.resumeHook.mockImplementationOnce(async () => {
      h.order.push("handoff");
      throw new HookNotFoundError(REFLECTION_TOKEN);
    });
    const outcome = await reflectionRun(WAKE);
    expect(outcome).toMatchObject({ kind: "retired", rounds: 1 });
    expect(h.resumeHook).toHaveBeenCalledTimes(1);
    expect(h.handleBrief).toHaveBeenCalledTimes(1);
    expect(h.handleBrief).toHaveBeenCalledWith({
      date: expect.any(String),
      sliceId: "2026-10-04-0131",
    });
    // the fallen-back run owns the status pointer like any claiming run
    expect(h.order.slice(0, 3)).toEqual(["handoff", "runStarted", "handleBrief"]);
  });

  it("handoff lost but a NEW primary claimed meanwhile → re-handoff, then deduped exit", async () => {
    h.behavior = {
      conflict: { runId: "run-primary" },
      conflicts: [{ runId: "run-primary" }, { runId: "run-primary-2" }],
      queue: [],
    };
    h.resumeHook.mockImplementationOnce(async () => {
      h.order.push("handoff");
      throw new HookNotFoundError(REFLECTION_TOKEN);
    });
    const outcome = await reflectionRun(WAKE);
    expect(outcome).toEqual({ kind: "dedupedTo", runId: "run-primary-2" });
    expect(h.resumeHook).toHaveBeenCalledTimes(2);
    expect(h.handleBrief).not.toHaveBeenCalled();
  });
});

describe("reflectionRun — the resident loop", () => {
  it("claims, runs ONE round off the wake's pointer verbatim, then EXITS when the visit's idle grace elapses (mailbox quiet)", async () => {
    const outcome = await reflectionRun(WAKE);
    expect(outcome).toEqual({ kind: "retired", rounds: 1 });
    // §2.2: NO semantic payload at all — the pointer rides verbatim (no
    // turnId anymore); the date is the UTC-stamp fallback (no payload.date).
    expect(h.handleBrief).toHaveBeenCalledTimes(1);
    expect(h.handleBrief).toHaveBeenCalledWith({
      date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      sliceId: "2026-10-04-0131",
    });
    // No REFLECTION_TOKEN handoff — a claiming run works its own wake.
    expect(h.order).not.toContain("handoff");
  });

  it("the idle exit is settle → dispose → return, in that order — and NO successor is started (寿命 = 一次访问)", async () => {
    await reflectionRun(WAKE);
    expect(h.order).toEqual([
      "runStarted",
      "handleBrief",
      "settle",
      "idleExit",
      "dispose",
    ]);
    // no successor relay: fresh generations belong to the delivery path's
    // start-fallback (reflection-wake.ts), never to the exiting run
    expect(h.start).not.toHaveBeenCalled();
    // the claiming run's OWN durable id rode the start mark (never a dispatch's)
    expect(h.recordRunStarted).toHaveBeenCalledWith("run-1");
    expect(h.recordIdleExit).toHaveBeenCalledWith({ rounds: 1 });
  });

  it("N bells ≠ N rounds: a lap drains the mailbox and runs ONE round off the FURTHEST pointer", async () => {
    const b: ReflectionWakePayload = { sliceId: "2026-10-04-0140", date: "2026-10-04" };
    const c: ReflectionWakePayload = { sliceId: "2026-10-04-0205" };
    h.behavior = { conflict: null, queue: [b, c] };
    const outcome = await reflectionRun(WAKE);
    // three bells (initial + two queued), TWO rounds
    expect(outcome).toMatchObject({ kind: "retired", rounds: 2 });
    expect(h.handleBrief).toHaveBeenCalledTimes(2);
    // lap 2 collapsed b+c: the furthest slice wins, its missing date falls
    // back to the last dated wake
    expect(h.handleBrief).toHaveBeenNthCalledWith(2, {
      date: "2026-10-04",
      sliceId: "2026-10-04-0205",
    });
    // every round settled immediately, with its own lap's cursor
    expect(h.recordRoundSettled).toHaveBeenCalledTimes(2);
    expect(h.recordRoundSettled).toHaveBeenNthCalledWith(1, {
      actions: [],
      note: "idle — nothing substantive",
      seen: { sliceId: "2026-10-04-0131" },
    });
    expect(h.recordRoundSettled).toHaveBeenNthCalledWith(2, {
      actions: [],
      note: "idle — nothing substantive",
      seen: { sliceId: "2026-10-04-0205" },
    });
    expect(h.recordIdleExit).toHaveBeenCalledWith({ rounds: 2 });
  });

  it("a bare wake ({}) hands over only the date stamp — nothing named, so no cursor rides the settle", async () => {
    const outcome = await reflectionRun({});
    expect(outcome).toMatchObject({ kind: "retired", rounds: 1 });
    expect(h.handleBrief).toHaveBeenCalledWith({
      date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    });
    const settled = h.recordRoundSettled.mock.calls[0][0];
    expect("seen" in settled).toBe(false);
  });

  it("a payload.date rides through as the round's date stamp (the field's local clock, not UTC)", async () => {
    await reflectionRun({ ...WAKE, date: "2026-10-03" });
    expect(h.handleBrief).toHaveBeenCalledWith({
      date: "2026-10-03",
      sliceId: "2026-10-04-0131",
    });
  });

  it("a FAILED round does NOT kill the unit — the settle records the failure honestly and the loop continues (§3.1)", async () => {
    const second: ReflectionWakePayload = { sliceId: "2026-10-04-0205" };
    h.behavior = { conflict: null, queue: [second] };
    h.handleBrief
      .mockResolvedValueOnce({
        actions: ["memory/research/x/index.md"],
        note: "",
        error: "no default model configured",
      })
      .mockResolvedValueOnce({ actions: [], note: "idle — nothing substantive" });
    const outcome = await reflectionRun(WAKE);
    expect(outcome).toMatchObject({ kind: "retired", rounds: 2 });
    // the failed round settles with its error AND its landed writes (a cut
    // report does not erase the flush that preceded it)
    expect(h.recordRoundSettled).toHaveBeenNthCalledWith(1, {
      actions: ["memory/research/x/index.md"],
      error: "no default model configured",
      seen: { sliceId: "2026-10-04-0131" },
    });
    expect(h.recordRoundSettled).toHaveBeenNthCalledWith(2, {
      actions: [],
      note: "idle — nothing substantive",
      seen: { sliceId: "2026-10-04-0205" },
    });
    // the failed beat carries the landed paths too
    const failed = h.frames.find(
      (f) => (f.data as { kind: string }).kind === "failed",
    );
    expect(failed?.data).toMatchObject({
      error: "no default model configured",
      paths: ["memory/research/x/index.md"],
    });
  });
});

describe("reflectionRun — the activity frames (the pod's live feed)", () => {
  /** The frame kinds in stream order. */
  const kinds = () => h.frames.map((f) => (f.data as { kind: string }).kind);

  it("every chunk is a data-hq-activity frame with a unique id", async () => {
    await reflectionRun(WAKE);
    expect(h.frames.length).toBeGreaterThan(0);
    for (const f of h.frames) expect(f.type).toBe("data-hq-activity");
    expect(new Set(h.frames.map((f) => f.id)).size).toBe(h.frames.length);
  });

  it("an idle lap beats: started → reading → idle(note) → finished(idle)", async () => {
    await reflectionRun(WAKE);
    expect(kinds()).toEqual(["started", "reading", "idle", "finished"]);
    const reading = h.frames[1].data as { sliceId?: string };
    expect(reading.sliceId).toBe("2026-10-04-0131");
    // the unit's own account rides the idle frame
    const idle = h.frames[2].data as { note?: string };
    expect(idle.note).toBe("idle — nothing substantive");
    const finished = h.frames[3].data as { status?: string; handled?: number };
    expect(finished).toMatchObject({ status: "idle", handled: 1 });
  });

  it("a writing lap beats wrote(paths + note)", async () => {
    h.handleBrief.mockResolvedValueOnce({
      actions: ["memory/research/screen-vendor/index.md"],
      note: "核对切片后写下一个案件。",
    });
    await reflectionRun(WAKE);
    expect(kinds()).toEqual(["started", "reading", "wrote", "finished"]);
    expect(h.frames[2].data).toMatchObject({
      paths: ["memory/research/screen-vendor/index.md"],
      note: "核对切片后写下一个案件。",
    });
    expect(h.frames[3].data).toMatchObject({ status: "idle", handled: 1 });
  });

  it("a multi-lap generation repeats the round beats before the idle-exit finish", async () => {
    const second: ReflectionWakePayload = { sliceId: "2026-10-04-0205" };
    h.behavior = { conflict: null, queue: [second] };
    await reflectionRun(WAKE);
    expect(kinds()).toEqual([
      "started",
      "reading", "idle",
      "reading", "idle",
      "finished",
    ]);
  });
});

describe("furthestWakePointer — collapse a drained mailbox into ONE lap pointer", () => {
  it("no wakes name nothing", () => {
    expect(furthestWakePointer([])).toEqual({});
    expect(furthestWakePointer([{}, { date: "2026-10-04" }])).toEqual({
      date: "2026-10-04",
    });
  });

  it("the string-max slice id wins (slice ids sort chronologically)", () => {
    expect(
      furthestWakePointer([
        { sliceId: "2026-10-04-0205" },
        { sliceId: "2026-10-04-0131" },
      ]),
    ).toEqual({ sliceId: "2026-10-04-0205" });
  });

  it("the date rides the furthest slice's wake, falling back to the LAST dated wake", () => {
    expect(
      furthestWakePointer([
        { sliceId: "2026-10-04-0131", date: "2026-10-04" },
        { sliceId: "2026-10-04-0205", date: "2026-10-05" },
      ]),
    ).toEqual({ sliceId: "2026-10-04-0205", date: "2026-10-05" });
    // the furthest wake is bare → the last dated wake supplies the date
    expect(
      furthestWakePointer([
        { sliceId: "2026-10-04-0131", date: "2026-10-04" },
        { sliceId: "2026-10-04-0205" },
      ]),
    ).toEqual({ sliceId: "2026-10-04-0205", date: "2026-10-04" });
  });
});
