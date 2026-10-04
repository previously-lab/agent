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
  resumeHook: vi.fn(async () => {
    h.order.push("handoff");
    return { runId: "run-primary" };
  }),
  handleBrief: vi.fn(async () => {
    h.order.push("handleBrief");
    return { actions: [], note: "idle — nothing substantive" };
  }),
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

vi.mock("@/app/api/evolution/hq-agent", () => ({
  handleBrief: h.handleBrief,
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
    expect(h.resumeHook).not.toHaveBeenCalled();
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
    // a deduped rival does no HQ work itself
    expect(h.handleBrief).not.toHaveBeenCalled();
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
  });
});
