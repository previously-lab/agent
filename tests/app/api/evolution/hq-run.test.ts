/**
 * HQ run — the field↔HQ communication shell (v0.21 §4, P2).
 *
 * The workflow runtime primitives (createHook / sleep) and the runtime API
 * (resumeHook) are mocked; `executeBoundaryRun` is stubbed. No real durable
 * run is executed — that is the main agent's live verification.
 *
 * Pins: conflict → handoff-then-exit (order), idle-grace exit, multi-brief
 * loop, and the P2 bridge's pointer extraction.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  /** call-order log: handoff must precede run resolution */
  order: [] as string[],
  resumeHook: vi.fn(async () => {
    h.order.push("handoff");
    return { runId: "run-primary" };
  }),
  executeBoundaryRun: vi.fn(async () => ({ ran: true, written: [], cardChanged: false })),
  /** per-test hook behavior, installed by makeHook */
  behavior: null as null | {
    conflict: { runId: string } | null;
    queue: unknown[];
    pend: boolean;
  },
}));

vi.mock("workflow", () => ({
  createHook: () => makeHook(),
  sleep: (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5))),
}));

vi.mock("workflow/api", () => ({
  resumeHook: h.resumeHook,
}));

vi.mock("@/app/api/evolution/background-steps", () => ({
  executeBoundaryRun: h.executeBoundaryRun,
}));

import { hqRun, HQ_TOKEN, type HQBriefPayload } from "@/app/api/evolution/hq-run";

interface FakeHook {
  token?: string;
  getConflict: () => Promise<{ runId: string } | null>;
  [Symbol.asyncIterator]: () => AsyncIterator<unknown>;
  dispose: () => void;
  disposed?: boolean;
}

function makeHook(): FakeHook {
  const behavior = h.behavior ?? { conflict: null, queue: [], pend: true };
  return {
    getConflict: async () => behavior.conflict,
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
  h.behavior = { conflict: null, queue: [], pend: true };
});

describe("hqRun — claim and conflict", () => {
  it("no conflict → claims the token and processes the initial brief", async () => {
    const outcome = await hqRun(BRIEF);
    expect(outcome).toEqual({ kind: "claimed", handled: 1 });
    // P2 bridge: the slice id mentioned in the prose is the pointer
    expect(h.executeBoundaryRun).toHaveBeenCalledWith({
      sliceId: "2026-10-04-0131",
      date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    });
    expect(h.resumeHook).not.toHaveBeenCalled();
  });

  it("no pointer in the brief → falls back to the replyToken's slice id", async () => {
    await hqRun({ brief: "没有指针的简报。", replyToken: BRIEF.replyToken });
    expect(h.executeBoundaryRun).toHaveBeenCalledWith({
      sliceId: "2026-10-04-0131",
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
    // a deduped rival does no HQ work itself
    expect(h.executeBoundaryRun).not.toHaveBeenCalled();
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
    expect(h.executeBoundaryRun).toHaveBeenCalledTimes(2);
  });
});
