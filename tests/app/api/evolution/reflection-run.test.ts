/**
 * Reflection run — the SHORT-LIVED unit (v0.38 §5; the v0.34 resident shell
 * retired: no mailbox drain, no idle/agenda clocks, no handoff chain).
 *
 * The workflow runtime primitives (createHook / setAttributes /
 * getWorkflowMetadata / getWritable) and the runtime API (getRun) are
 * mocked; the runtime registry read (getWorld) is mocked; the reflection
 * unit (hq-agent.ts's handleBrief) and the status store are stubbed — the
 * store stub simulates the real cursor rule (§4.2). reflection-steps.ts
 * runs for REAL with its world-read legs on an in-memory fake. No real
 * durable run is executed — that is the live verification's job.
 *
 * Pins: claim (no conflict → run); conflict + healthy holder → 撞车即退;
 * conflict + zombie → takeover (cancel + 留痕 + re-claim); conflict +
 * terminal holder → treated as unowned, re-claimed; the work loop (有活跑
 * 一轮 → 立即再查， backlog drained lap by lap); 无活即退 (retire at the
 * empty lap, token disposed); the failed-round cursor discipline.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  order: [] as string[],
  /** the claim behavior: null = free token; else the conflicting runId */
  conflict: null as null | { runId: string },
  /** getConflict may consume a sequence (re-claim after a takeover) */
  conflicts: null as null | Array<{ runId: string } | null>,
  /** the holder's registry state (readRunClaim) */
  holder: null as null | { status: string; ageMs: number | null },
  cancel: vi.fn(async (runId: string) => {
    h.order.push(`cancel:${runId}`);
    return true;
  }),
  dispose: vi.fn(() => {
    h.order.push("dispose");
  }),
  lastClaim: null as null | { runId: string },
  attributes: {} as Record<string, string>,
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
  world: {
    cursor: null as string | null,
    lastEvolution: null as string | null,
    slices: [] as Array<{ rel: string; closedBy?: string }>,
    agenda: "",
  },
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
}));

vi.mock("workflow", () => ({
  createHook: () => ({
    getConflict: async () => {
      const c =
        h.conflicts && h.conflicts.length > 0 ? h.conflicts.shift()! : h.conflict;
      h.lastClaim = c; // the registry reports THIS holder while it lives
      return c;
    },
    dispose: h.dispose,
  }),
  setAttributes: async (attrs: Record<string, string>) => {
    Object.assign(h.attributes, attrs);
    h.order.push(`attrs:${Object.keys(attrs).join(",")}`);
  },
  getWorkflowMetadata: () => ({ workflowRunId: "run-1" }),
  getWritable: () => ({
    getWriter: () => ({
      write: async (_chunk: unknown) => {},
      releaseLock: () => {},
    }),
  }),
}));

vi.mock("workflow/api", () => ({
  getRun: (runId: string) => ({
    cancel: () => h.cancel(runId),
  }),
}));

vi.mock("workflow/runtime", () => ({
  getWorld: async () => ({
    runs: {
      list: async () => {
        const current = h.lastClaim;
        return {
          data: [
            h.holder && current
              ? {
                  runId: current.runId,
                  status: h.holder.status,
                  attributes: h.holder.ageMs !== null
                    ? { startedAt: new Date(Date.now() - h.holder.ageMs).toISOString() }
                    : {},
                }
              : null,
          ].filter(Boolean),
        };
      },
    },
  }),
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

vi.mock("@/lib/episodic/timeline/enumerate", () => ({
  enumerateSliceIds: vi.fn(async () => h.world.slices.map((s) => s.rel)),
}));
vi.mock("@/lib/episodic/timeline/store", () => ({
  sliceEntryFromDisk: vi.fn(async (rel: string) => {
    const s = h.world.slices.find((x) => x.rel === rel);
    if (!s) return null;
    return s.closedBy ? { closed_by: s.closedBy } : {};
  }),
}));
vi.mock("@/lib/episodic/io-helpers", () => ({
  fsReadFile: vi.fn(async (path: string) => {
    if (path === "memory/self/agenda.md") return h.world.agenda;
    throw new Error(`ENOENT: ${path}`);
  }),
}));

import { reflectionRun } from "@/app/api/evolution/reflection-run";

beforeEach(() => {
  vi.clearAllMocks();
  h.order.length = 0;
  h.conflict = null;
  h.conflicts = null;
  h.holder = null;
  h.lastClaim = null;
  h.attributes = {};
  h.world.cursor = null;
  h.world.lastEvolution = null;
  h.world.slices = [];
  h.world.agenda = "";
  h.handleBrief.mockImplementation(async () => {
    h.order.push("handleBrief");
    return { actions: [], note: "idle — nothing substantive" };
  });
});

describe("reflectionRun — the short-lived unit (v0.38 §5)", () => {
  it("free token + empty world → 无活即退: started → idle exit → dispose, 0 rounds", async () => {
    const outcome = await reflectionRun();

    expect(outcome).toEqual({ kind: "retired", rounds: 0 });
    expect(h.order).toEqual(["attrs:startedAt", "runStarted", "idleExit", "dispose"]);
    // NO clock, NO mailbox wait — the run exited off the world read alone.
  });

  it("free token + sealed slice → ONE round, cursor advances, immediate re-loop, then retire", async () => {
    h.world.slices = [{ rel: "2026/10/04/0131", closedBy: "idle_gap" }];

    const outcome = await reflectionRun();

    expect(outcome).toEqual({ kind: "retired", rounds: 1 });
    expect(h.order.filter((o) => o === "handleBrief")).toHaveLength(1);
    expect(h.order.filter((o) => o === "settle")).toHaveLength(1);
    // the second (empty) lap re-read the world and retired — backlog drained
    expect(h.order).toEqual([
      "attrs:startedAt",
      "runStarted",
      "roundBegan",
      "handleBrief",
      "settle",
      "idleExit",
      "dispose",
    ]);
    expect(h.world.cursor).toBe("2026-10-04-0131");
  });

  it("a failed round holds the cursor (§4.2) and the loop continues — then retires", async () => {
    h.world.slices = [
      { rel: "2026/10/04/0131", closedBy: "idle_gap" },
      { rel: "2026/10/04/0200", closedBy: "idle_gap" },
    ];
    let calls = 0;
    h.handleBrief.mockImplementation(async () => {
      h.order.push("handleBrief");
      calls += 1;
      // first round fails (cursor holds); second round succeeds
      return calls === 1
        ? { actions: [], note: "", error: "model exploded" }
        : { actions: ["research/x/index.md"], note: "recovered" };
    });

    const outcome = await reflectionRun();

    expect(outcome).toEqual({ kind: "retired", rounds: 2 });
    // both slices settled: cursor at the furthest, failed round held nothing
    expect(h.world.cursor).toBe("2026-10-04-0200");
  });

  it("conflict + a HEALTHY holder (alive, within the takeover threshold) → 撞车即退, no cancel", async () => {
    h.conflict = { runId: "holder-1" };
    h.holder = { status: "running", ageMs: 3 * 60_000 }; // 3 min < 15 min

    const outcome = await reflectionRun();

    expect(outcome).toEqual({ kind: "dedupedTo", runId: "holder-1" });
    expect(h.cancel).not.toHaveBeenCalled();
    // the unclaimed hook is disposed on the way out (idempotent-guarded)
    expect(h.order).toEqual(["dispose"]);
  });

  it("conflict + a ZOMBIE (alive past the threshold) → cancel + 留痕 + re-claim + run", async () => {
    h.conflicts = [{ runId: "zombie-1" }, null]; // first claim conflicts, re-claim free
    h.holder = { status: "running", ageMs: 20 * 60_000 }; // 20 min > 15 min

    const outcome = await reflectionRun();

    expect(outcome).toEqual({ kind: "retired", rounds: 0 });
    expect(h.cancel).toHaveBeenCalledWith("zombie-1");
    expect(h.attributes.tookOver).toBe("zombie-1");
    expect(h.order).toEqual([
      "cancel:zombie-1",
      "attrs:tookOver",
      "attrs:startedAt",
      "runStarted",
      "idleExit",
      "dispose",
    ]);
  });

  it("conflict + a TERMINAL holder → treated as unowned, re-claimed, run proceeds", async () => {
    h.conflicts = [{ runId: "dead-1" }, null];
    h.holder = { status: "completed", ageMs: null };

    const outcome = await reflectionRun();

    expect(outcome).toEqual({ kind: "retired", rounds: 0 });
    expect(h.cancel).not.toHaveBeenCalled(); // dead holders are never cancelled
    expect(h.order).toEqual(["attrs:startedAt", "runStarted", "idleExit", "dispose"]);
  });
});
