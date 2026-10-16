/**
 * Reflection run — the reflection unit's resident shell (v0.34 常驻形态
 * R1 + R2 的 world/gate).
 *
 * The workflow runtime primitives (createHook / sleep / getWritable /
 * getWorkflowMetadata) and the runtime API (resumeHook / start) are mocked;
 * the reflection unit (hq-agent.ts's handleBrief) and the status store are
 * stubbed. reflection-steps.ts runs for REAL — only its impure read legs
 * (the slice enumeration, the slice-head reads, the agenda read, the
 * hq.json read) are mocked through an in-memory fake world, and the store
 * stub SIMULATES the real store's cursor rule (§4.2): a clean, non-
 * superseded round advances the cursor to `seen`, a failed or superseded
 * round holds it. No real durable run is executed — that is the main
 * agent's live verification.
 *
 * Pins: conflict → handoff-then-exit (order); the R2 lap loop (取世界 →
 * lapHasWork → 有活才跑轮 → 立即再查，积压由循环本身消化); the agenda clock
 * arm (三路阻塞赛跑的第三条腿); per-round immediate settlement off the
 * DOCKET (the cursor target is the scope's furthest slice, not the bell);
 * the failed/superseded cursor discipline; the round latch (roundActive);
 * the world-read failure degrading to an idle lap (never a dead run); the
 * idle exit at a lap boundary (NO successor); and the reading frame carrying
 * the round's scope slices.
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
    async (_docket: unknown): Promise<{
      actions: string[];
      note: string;
      error?: string;
      disposition?: "completed" | "superseded";
      evolved?: boolean;
    }> => {
      h.order.push("handleBrief");
      return { actions: [], note: "idle — nothing substantive" };
    },
  ),
  /** the fake world the mocked read legs serve */
  world: {
    /** the on-disk cursor (hq.json lastSeen.sliceId) */
    cursor: null as string | null,
    lastEvolution: null as string | null,
    /** enumerated slice dirs, "YYYY/MM/DD/HHMM" rel paths + their close cause */
    slices: [] as Array<{ rel: string; closedBy?: string }>,
    /** raw memory/self/agenda.md content */
    agenda: "",
  },
  /** when true, the slice enumeration blows up — the world-read failure leg */
  enumerateFails: false,
  /** when > 0, each mocked workflow sleep advances the (fakeable) clock by
   *  this many ms before resolving — drives the agenda-clock test past the
   *  due date without waiting real time */
  advanceOnSleep: 0,
  recordRunStarted: vi.fn(async (_runId?: string) => {
    h.order.push("runStarted");
  }),
  recordRoundBegan: vi.fn(async () => {
    h.order.push("roundBegan");
  }),
  /** Simulates the REAL store's §4.2 rule: a clean, non-superseded round
   *  advances the cursor to `seen`; failed and superseded rounds hold it. */
  recordRoundSettled: vi.fn(async (round: Record<string, unknown>) => {
    h.order.push("settle");
    const seen = round.seen as { sliceId?: string } | undefined;
    const err = typeof round.error === "string" ? round.error : undefined;
    if (!err && round.disposition !== "superseded" && seen?.sliceId) {
      h.world.cursor = seen.sliceId;
    }
  }),
  recordIdleExit: vi.fn(async (_result: { rounds: number }) => {
    h.order.push("idleExit");
  }),
  /** loadReflectionWorld's pointer leg — the fake on-disk hq.json */
  readHQStatus: vi.fn(async () => ({
    runId: null,
    runStartedAt: null,
    runStatus: null,
    briefsHandled: 0,
    lastError: null,
    lastDispatchAt: null,
    lastBriefPreview: null,
    recentWrites: [],
    lastNote: null,
    lastSeen: h.world.cursor ? { sliceId: h.world.cursor } : null,
    roundActive: null,
    lastEvolution: h.world.lastEvolution
      ? { date: h.world.lastEvolution, at: "t" }
      : null,
    lastSuperseded: null,
  })),
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
    new Promise((resolve) =>
      setTimeout(() => {
        // test hook: a sleep may advance the fake clock (agenda-clock arm)
        if (h.advanceOnSleep > 0) vi.setSystemTime(Date.now() + h.advanceOnSleep);
        resolve(undefined);
      }, Math.min(ms, 5)),
    ),
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
  recordReflectionRoundBegan: h.recordRoundBegan,
  recordReflectionRoundSettled: h.recordRoundSettled,
  recordReflectionRunIdleExit: h.recordIdleExit,
  readHQStatus: h.readHQStatus,
}));

// The world-read legs (reflection-steps.ts's dynamic imports).
vi.mock("@/lib/episodic/timeline/enumerate", () => ({
  enumerateSliceIds: vi.fn(async () => {
    if (h.enumerateFails) throw new Error("enumeration backend down");
    return h.world.slices.map((s) => s.rel);
  }),
}));
vi.mock("@/lib/episodic/timeline/store", () => ({
  sliceEntryFromDisk: vi.fn(async (rel: string) => {
    const s = h.world.slices.find((x) => x.rel === rel);
    if (!s) return null;
    // the step only reads closed_by (absent = still ACTIVE)
    return s.closedBy ? { closed_by: s.closedBy } : {};
  }),
}));
vi.mock("@/lib/episodic/io-helpers", () => ({
  fsReadFile: vi.fn(async (path: string) => {
    if (path === "memory/self/agenda.md") return h.world.agenda;
    throw new Error(`ENOENT: ${path}`);
  }),
}));

import {
  reflectionRun,
  REFLECTION_TOKEN,
  furthestWakePointer,
  type ReflectionWakePayload,
} from "@/app/api/evolution/reflection-run";
import { loadReflectionWorld } from "@/app/api/evolution/reflection-steps";
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
          // default: pends forever — a clock arm of the race wins
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

/** The docket argument the shell hands the unit (the tested fields). */
interface DocketArg {
  date: string;
  cursor: string | null;
  scope: Array<{ sliceId: string; closedBy: string }>;
  agendaDue: Array<{ due: string; text: string }>;
  evolutionDue: boolean;
  evolutionReasons: string[];
  [key: string]: unknown;
}

/** The docket of the Nth handleBrief call — fails the test if absent. */
function briefDocket(call: number): DocketArg {
  const docket = h.handleBrief.mock.calls[call]?.[0] as DocketArg | undefined;
  if (!docket) throw new Error(`handleBrief call ${call} missing`);
  return docket;
}

/** The default world: ONE sealed boundary slice past a fresh cursor. */
function defaultWorld(): void {
  h.world = {
    cursor: null,
    lastEvolution: null,
    slices: [{ rel: "2026/10/04/0131", closedBy: "idle_gap" }],
    agenda: "",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.order.length = 0;
  h.frames.length = 0;
  h.behavior = { conflict: null, queue: [] };
  h.enumerateFails = false;
  h.advanceOnSleep = 0;
  defaultWorld();
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
    // the fallen-back run owns the status pointer like any claiming run
    expect(h.order.slice(0, 3)).toEqual(["handoff", "runStarted", "roundBegan"]);
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

describe("reflectionRun — the R2 lap loop (世界 → gate → 有活才跑轮)", () => {
  it("claims, runs ONE round off the world's scope, then blocks and idle-exits — settle → dispose → return, no successor", async () => {
    const outcome = await reflectionRun(WAKE);
    expect(outcome).toEqual({ kind: "retired", rounds: 1 });
    // The round latch closes at the round's first beat, clears at the settle.
    expect(h.order).toEqual([
      "runStarted",
      "roundBegan",
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
    // the second lap re-read the world, found the cursor already past the
    // only slice, and blocked WITHOUT another model call
    expect(h.handleBrief).toHaveBeenCalledTimes(1);
  });

  it("the unit is handed the DOCKET: this round's sealed slices (id + close cause), the cursor, and the lap's user-clock date", async () => {
    await reflectionRun({ ...WAKE, date: "2026-10-04" });
    expect(h.handleBrief).toHaveBeenCalledTimes(1);
    const docket = briefDocket(0);
    expect(docket).toMatchObject({
      date: "2026-10-04",
      cursor: null,
      scope: [{ sliceId: "2026-10-04-0131", closedBy: "idle_gap" }],
      agendaDue: [],
    });
    // a boundary close in scope fires the evolution beat (§3.4-1), and a
    // never-evolved unit is daily-overdue (§3.4-2)
    expect(docket.evolutionDue).toBe(true);
    expect(docket.evolutionReasons).toContain("conversation_boundary");
    expect(docket.evolutionReasons).toContain("daily_rollover");
  });

  it("a payload.date rides through as the lap's date stamp (the field's local clock, not UTC)", async () => {
    await reflectionRun({ ...WAKE, date: "2026-10-03" });
    expect(briefDocket(0)).toMatchObject({ date: "2026-10-03" });
  });

  it("a bare wake ({}) laps on the UTC date — no payload, no cursor, no special casing", async () => {
    await reflectionRun({});
    expect(h.handleBrief).toHaveBeenCalledTimes(1);
    expect(briefDocket(0).date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("N bells ≠ N rounds — and the scope, not the mailbox, is the material: three bells, ONE round over all three sealed slices", async () => {
    h.world.slices = [
      { rel: "2026/10/04/0131", closedBy: "idle_gap" },
      { rel: "2026/10/04/0140", closedBy: "time_cap" },
      { rel: "2026/10/04/0205", closedBy: "idle_gap" },
    ];
    const b: ReflectionWakePayload = { sliceId: "2026-10-04-0140", date: "2026-10-04" };
    const c: ReflectionWakePayload = { sliceId: "2026-10-04-0205" };
    h.behavior = { conflict: null, queue: [b, c] };
    // the run-starting wake carries the field's local date (the delivery
    // path's buildReflectionWakePayload); the two QUEUED bells only reach
    // the inbox at the first block — doorbells, never material
    const outcome = await reflectionRun({ ...WAKE, date: "2026-10-04" });
    // one round answered for ALL the sealed slices past the cursor; the two
    // queued bells only woke two more mechanical re-reads (each saw a clean
    // world and blocked again — 空转合法, §3.1)
    expect(outcome).toMatchObject({ kind: "retired", rounds: 1 });
    expect(h.handleBrief).toHaveBeenCalledTimes(1);
    expect(briefDocket(0)).toMatchObject({
      date: "2026-10-04",
      scope: [
        { sliceId: "2026-10-04-0131", closedBy: "idle_gap" },
        { sliceId: "2026-10-04-0140", closedBy: "time_cap" },
        { sliceId: "2026-10-04-0205", closedBy: "idle_gap" },
      ],
    });
    // the cursor target is the scope's FURTHEST slice, from the settle
    expect(h.recordRoundSettled).toHaveBeenCalledTimes(1);
    expect(h.recordRoundSettled).toHaveBeenCalledWith(
      expect.objectContaining({
        actions: [],
        note: "idle — nothing substantive",
        seen: { sliceId: "2026-10-04-0205" },
        date: "2026-10-04",
      }),
    );
    expect(h.recordIdleExit).toHaveBeenCalledWith({ rounds: 1 });
  });

  it("the backlog drains lap by lap: six sealed slices, a 5-slice scope cap → TWO rounds, the cursor walking forward between them", async () => {
    h.world.slices = ["0100", "0131", "0200", "0230", "0300", "0330"].map((hm) => ({
      rel: `2026/10/04/${hm}`,
      closedBy: "time_cap",
    }));
    const outcome = await reflectionRun(WAKE);
    expect(outcome).toMatchObject({ kind: "retired", rounds: 2 });
    expect(h.handleBrief).toHaveBeenCalledTimes(2);
    // lap 1: the oldest five; lap 2: the remainder the cursor left behind
    expect(briefDocket(0).scope.map((s) => s.sliceId))
      .toEqual([
        "2026-10-04-0100",
        "2026-10-04-0131",
        "2026-10-04-0200",
        "2026-10-04-0230",
        "2026-10-04-0300",
      ]);
    expect(briefDocket(1).scope.map((s) => s.sliceId))
      .toEqual(["2026-10-04-0330"]);
    expect(h.recordRoundSettled).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ seen: { sliceId: "2026-10-04-0300" } }),
    );
    expect(h.recordRoundSettled).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ seen: { sliceId: "2026-10-04-0330" } }),
    );
  });

  it("a FAILED round does NOT kill the unit — the cursor holds, the loop re-plans from the same edge, and the next round converges (§3.1/§4.2)", async () => {
    h.handleBrief
      .mockResolvedValueOnce({
        actions: ["memory/research/x/index.md"],
        note: "",
        error: "no default model configured",
      })
      .mockResolvedValueOnce({ actions: [], note: "idle — nothing substantive" });
    const outcome = await reflectionRun(WAKE);
    expect(outcome).toMatchObject({ kind: "retired", rounds: 2 });
    // the failed round settles with its error AND its landed writes, naming
    // the cursor target — the STORE is what holds the cursor (§4.2)
    expect(h.recordRoundSettled).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        actions: ["memory/research/x/index.md"],
        error: "no default model configured",
        seen: { sliceId: "2026-10-04-0131" },
      }),
    );
    // the simulated store held the cursor → lap 2 re-read the SAME scope…
    expect(h.handleBrief).toHaveBeenNthCalledWith(2, expect.objectContaining({
      scope: [{ sliceId: "2026-10-04-0131", closedBy: "idle_gap" }],
    }));
    // …and the redo converged: the clean round advanced the cursor
    expect(h.recordRoundSettled).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ seen: { sliceId: "2026-10-04-0131" } }),
    );
    // the failed beat carries the landed paths too
    const failed = h.frames.find(
      (f) => (f.data as { kind: string }).kind === "failed",
    );
    expect(failed?.data).toMatchObject({
      error: "no default model configured",
      paths: ["memory/research/x/index.md"],
    });
  });

  it("a SUPERSEDED round holds the cursor like a failure, reports its landed writes, and rides the disposition into the settle (§5.4)", async () => {
    h.handleBrief
      .mockResolvedValueOnce({
        actions: ["memory/research/y/index.md"],
        note: "superseded: 又封了一片，本轮前提作废；这笔已落盘。",
        disposition: "superseded" as const,
      })
      .mockResolvedValueOnce({ actions: [], note: "idle — nothing substantive" });
    const outcome = await reflectionRun(WAKE);
    expect(outcome).toMatchObject({ kind: "retired", rounds: 2 });
    expect(h.recordRoundSettled).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        actions: ["memory/research/y/index.md"],
        note: "superseded: 又封了一片，本轮前提作废；这笔已落盘。",
        disposition: "superseded",
        seen: { sliceId: "2026-10-04-0131" },
      }),
    );
    // the cursor held → the next lap re-planned from the same edge
    expect(h.handleBrief).toHaveBeenCalledTimes(2);
  });

  it("a round that ran an evolution pass rides `evolved` into the settle (the pointer's lastEvolution stamp, §4.2)", async () => {
    h.handleBrief.mockResolvedValueOnce({
      actions: [],
      note: "card pass ran; model unchanged.",
      evolved: true,
    });
    await reflectionRun(WAKE);
    expect(h.recordRoundSettled).toHaveBeenCalledWith(
      expect.objectContaining({ evolved: true, date: expect.any(String) }),
    );
  });

  it("a world-read failure laps IDLE: no model call, no settle, no round frame — the unit blocks and exits clean (§3.1: 读失败 = 空转 lap, 绝不抛)", async () => {
    h.enumerateFails = true;
    const outcome = await reflectionRun(WAKE);
    expect(outcome).toEqual({ kind: "retired", rounds: 0 });
    expect(h.handleBrief).not.toHaveBeenCalled();
    expect(h.recordRoundSettled).not.toHaveBeenCalled();
    expect(h.order).toEqual(["runStarted", "idleExit", "dispose"]);
    // the mechanical idle leaves no trace either (机械层的空转也不留痕)
    expect(h.frames.map((f) => (f.data as { kind: string }).kind)).toEqual([
      "started",
      "finished",
    ]);
  });
});

describe("reflectionRun — the agenda clock (§6.2)", () => {
  it("a future-due agenda item arms the third race leg; the clock wake delivers the due item INTO the next round", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-10-04T12:00:00.000Z"));
      h.world = {
        cursor: "2026-10-04-0205",
        lastEvolution: null,
        slices: [], // nothing past the cursor — the agenda is the only work
        agenda: "- [due: 2026-10-05] 复查 hypotheses/厄尔尼诺（据片 2026-10-04-0131）\n",
      };
      // every mocked sleep advances the fake clock a day — the block's
      // agenda arm fires immediately in test time, but the NEXT world read
      // already sees the due date arrived
      h.advanceOnSleep = 24 * 60 * 60 * 1000;
      h.handleBrief.mockImplementationOnce(async () => {
        h.order.push("handleBrief");
        h.world.agenda = ""; // the unit consumes the item
        return { actions: [], note: "复查完成，无新料。" };
      });
      const outcome = await reflectionRun();
      expect(outcome).toMatchObject({ kind: "retired", rounds: 1 });
      // the clock-woken lap delivered the due item with the round…
      expect(h.handleBrief).toHaveBeenCalledTimes(1);
      expect(briefDocket(0)).toMatchObject({
        date: "2026-10-05",
        scope: [],
        agendaDue: [
          { due: "2026-10-05", text: "复查 hypotheses/厄尔尼诺（据片 2026-10-04-0131）" },
        ],
        evolutionDue: true, // §3.4-3: a due agenda fires the beat
        evolutionReasons: ["agenda_due"],
      });
      // …and with the item consumed the next lap blocked to the idle exit
      expect(h.recordIdleExit).toHaveBeenCalledWith({ rounds: 1 });
    } finally {
      vi.useRealTimers();
    }
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

  it("the reading frame carries the round's scope (§4.3-4) — the panel's 「开始核对 N 片」", async () => {
    await reflectionRun(WAKE);
    expect(kinds()).toEqual(["started", "reading", "idle", "finished"]);
    const reading = h.frames[1].data as { sliceId?: string; slices?: string[] };
    expect(reading.slices).toEqual(["2026-10-04-0131"]);
    // single-slice compat: the sliceId field rides too
    expect(reading.sliceId).toBe("2026-10-04-0131");
    // the unit's own account rides the idle frame
    const idle = h.frames[2].data as { note?: string };
    expect(idle.note).toBe("idle — nothing substantive");
    const finished = h.frames[3].data as { status?: string; handled?: number };
    expect(finished).toMatchObject({ status: "idle", handled: 1 });
  });

  it("a multi-slice round's reading frame names every slice it answers for", async () => {
    h.world.slices = [
      { rel: "2026/10/04/0131", closedBy: "idle_gap" },
      { rel: "2026/10/04/0205", closedBy: "idle_gap" },
    ];
    await reflectionRun(WAKE);
    const reading = h.frames.find((f) => (f.data as { kind: string }).kind === "reading");
    expect((reading?.data as { slices?: string[] }).slices).toEqual([
      "2026-10-04-0131",
      "2026-10-04-0205",
    ]);
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

  it("a backlog generation repeats the round beats before the idle-exit finish", async () => {
    // One slice at the first read; a second seals between the laps — the
    // loop's immediate re-check catches it as the next round's material.
    h.world.slices = [{ rel: "2026/10/04/0131", closedBy: "idle_gap" }];
    h.recordRoundSettled.mockImplementationOnce(async (round: Record<string, unknown>) => {
      h.order.push("settle");
      h.world.slices = [
        { rel: "2026/10/04/0131", closedBy: "idle_gap" },
        { rel: "2026/10/04/0205", closedBy: "idle_gap" },
      ];
      const seen = round.seen as { sliceId?: string } | undefined;
      if (seen?.sliceId) h.world.cursor = seen.sliceId;
    });
    const outcome = await reflectionRun(WAKE);
    expect(outcome).toMatchObject({ kind: "retired", rounds: 2 });
    expect(kinds()).toEqual([
      "started",
      "reading", "idle",
      "reading", "idle",
      "finished",
    ]);
  });
});

describe("loadReflectionWorld — the world read itself (§3.3)", () => {
  it("assembles the docket from the pointer, the enumeration (cursor bound + 门上界), and the agenda", async () => {
    h.world = {
      cursor: "2026-10-04-0100",
      lastEvolution: "2026-10-03",
      slices: [
        { rel: "2026/10/04/0100", closedBy: "time_cap" }, // at the cursor — excluded
        { rel: "2026/10/04/0131", closedBy: "idle_gap" },
        { rel: "2026/10/04/0205", closedBy: "time_cap" },
        { rel: "2026/10/04/0300" }, // still ACTIVE — no closed_by, no scope
      ],
      agenda:
        "- [due: 2026-10-04] 复查 hypotheses/厄尔尼诺（据片 2026-10-04-0131）\n- [due: 2026-10-06] 复核 search SOP（据片 2026-10-04-0131）\n",
    };
    const docket = await loadReflectionWorld("2026-10-04");
    expect(docket).toMatchObject({
      date: "2026-10-04",
      cursor: "2026-10-04-0100",
      scope: [
        { sliceId: "2026-10-04-0131", closedBy: "idle_gap" },
        { sliceId: "2026-10-04-0205", closedBy: "time_cap" },
      ],
      agendaDue: [
        { due: "2026-10-04", text: "复查 hypotheses/厄尔尼诺（据片 2026-10-04-0131）" },
      ],
    });
    // the ACTIVE slice and the at-cursor slice stayed out of the scope
    expect(docket.scope.find((s) => s.sliceId === "2026-10-04-0300")).toBeUndefined();
    // the future item is not due but arms the clock: ms until its midnight
    expect(docket.agendaWakeMs).not.toBeNull();
    expect(docket.agendaWakeMs as unknown as number).toBeGreaterThan(0);
    // boundary in scope → conversation_boundary; last evolution yesterday →
    // daily_rollover; a due item → agenda_due (§3.4, all three reasons)
    expect(docket.evolutionDue).toBe(true);
    expect(docket.evolutionReasons).toEqual([
      "conversation_boundary",
      "daily_rollover",
      "agenda_due",
    ]);
  });

  it("a dead read leg degrades its half of the docket, never the whole lap — and never throws", async () => {
    h.enumerateFails = true;
    h.world.agenda = "- [due: 2020-01-01] 旧项（据片 2026-10-04-0131）\n";
    const docket = await loadReflectionWorld("2026-10-04");
    // the enumeration died → no scope…
    expect(docket.scope).toEqual([]);
    // …but the agenda leg still read: its item is due and would wake a round
    expect(docket.agendaDue).toEqual([
      { due: "2020-01-01", text: "旧项（据片 2026-10-04-0131）" },
    ]);
    expect(docket.agendaWakeMs).toBeNull(); // nothing due in the future
  });
});

describe("furthestWakePointer — collapse a drained mailbox into ONE lap date", () => {
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
