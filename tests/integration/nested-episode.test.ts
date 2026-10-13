/**
 * NESTED EPISODE spike (v0.30 §8-a, batch B) — the outer episode run E
 * draining two concurrently-arrived user messages: mock the agent stream
 * (one clean stop, then the merge pass), start two inner runs, feed their
 * bubble reports back through the inbox hook, and pin the whole shape —
 * E collects, merges, and finalizeTurn lands ONE tail.
 *
 * Everything durable is mocked at the module boundary: the workflow runtime
 * (createHook/getWritable/sleep), the runtime API (start), the agent factory,
 * and every step (housekeeping/finalizeTurn/readEpisodeInbox/emitNestedBubble/
 * …). The workflow body itself — the drain loop, the envelope assembly, the
 * merge pass, the tail — runs REAL; that is what the spike exists to prove.
 *
 * The兼任 (single-message) case asserts the tail stays undefined and nothing
 * episode-shaped fires — the byte-identical guarantee rests on the nested
 * parameters being absent (see the diff; asserting that here is review-level,
 * not byte-level).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TimeSlice } from "@/lib/episodic";
import type { InnerTurnInput, NestedTurnTail, TurnInput, TurnOutcome } from "@/lib/chat/turn-types";
import type { NestedBubbleFrame } from "@/lib/chat/nested-bubble";

const h = vi.hoisted(() => {
  /** Events the (mocked) inner runs report back — start() pushes here and the
   *  fake hook's iterator shifts from here, so a queued event ALWAYS beats the
   *  5 ms sleep arm in the drain's race (microtask vs macrotask). */
  const inboxQueue: unknown[] = [];
  return {
    inboxQueue,
    /** createHook capture: one hook per run, token asserted in tests. */
    hookTokens: [] as string[],
    /** start() capture: the inner inputs E spawned. */
    startedInner: [] as InnerTurnInput[],
    /** emitNestedBubble capture: the frame stream E produced. */
    frames: [] as NestedBubbleFrame[],
    /** finalizeTurn capture. */
    finalizeCalls: [] as Array<{ outcome: TurnOutcome; nested: NestedTurnTail | undefined }>,
    /** agent.stream answers, shifted per call (main answer, then the merge). */
    streamAnswers: [] as string[],
    /** agent.stream failures, shifted per call BEFORE the answer queue. */
    streamErrors: [] as string[],
    streamCalls: [] as Array<{ messages: unknown[]; system: string }>,
    /** readEpisodeInbox script: shifted per call; empty when exhausted. */
    inboxReads: [] as Array<Array<{ turnId: string; timestamp: string; text: string }>>,
    closeStream: vi.fn(async () => {}),
    ring: vi.fn(async () => {}),
  };
});

vi.mock("workflow", () => ({
  createHook: vi.fn((opts: { token: string }) => {
    h.hookTokens.push(opts.token);
    return {
      token: opts.token,
      [Symbol.asyncIterator]: () => ({
        next: () => {
          const v = h.inboxQueue.shift();
          return v !== undefined
            ? Promise.resolve({ value: v, done: false })
            : new Promise(() => {}); // pends — the sleep arm wins
        },
        return: () => Promise.resolve({ value: undefined, done: true }),
      }),
      dispose: () => {},
    };
  }),
  getWritable: () => ({
    getWriter: () => ({ write: async () => {}, releaseLock: () => {} }),
    close: async () => {},
  }),
  // A REAL 5 ms timer: long enough that a queued hook event (microtask) always
  // wins the race, short enough that the idle arm settles the loop.
  sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5))),
}));

vi.mock("workflow/api", () => ({
  // The inner run "completes" instantly: its bubble report lands in the inbox
  // queue the moment E spawns it (the report's real path — inner workflow →
  // reportInnerBubble step → resumeHook — is a one-line wrapper; the spike's
  // subject is E's drain, not the wire).
  start: vi.fn(async (_fn: unknown, args: [InnerTurnInput], _opts?: unknown) => {
    const inner = args[0];
    h.startedInner.push(inner);
    h.inboxQueue.push({
      kind: "bubble",
      turnId: inner.turnId,
      replyTo: inner.replyTo,
      text: `answer for ${inner.replyTo}`,
      finishReason: "stop",
    });
    return { runId: `inner-${inner.turnId}` };
  }),
}));

vi.mock("@/app/api/agent/agent", () => ({
  createChatAgent: () => ({
    stream: vi.fn(async (opts: { messages: unknown[]; system: string }) => {
      h.streamCalls.push(opts);
      const error = h.streamErrors.shift();
      if (error) throw new Error(error);
      const answer = h.streamAnswers.shift() ?? "";
      return {
        // SDK shape: [system, ...input, assistant] — the extraction slices at
        // 1 + the input window length.
        messages: [
          { role: "system", content: opts.system },
          ...(opts.messages as Array<{ role: string; content: string }>),
          { role: "assistant", content: answer },
        ],
        steps: [],
        finishReason: "stop",
      };
    }),
  }),
}));

vi.mock("@/app/api/agent/tools", () => ({
  buildChatToolsContext: () => ({}),
}));

// The inner workflow module is replaced by a bare symbol — E only hands it to
// start(); its body never runs here.
vi.mock("@/app/api/chat/inner-turn-workflow", () => ({
  innerTurnWorkflow: vi.fn(),
}));

vi.mock("@/app/api/chat/steps", () => ({
  ownRunId: vi.fn(async () => "run-E"),
  housekeeping: vi.fn(async () => ({
    slice: SLICE,
    previouslyContent: "",
    sliceHeadBlock: "",
    identityPrompt: "",
    directionBlock: "",
    userProfileBlock: "",
    dueTasksBlock: "",
    contextPrefix: "",
    rebuiltHistory: undefined,
    reflectionNote: null,
    analysis: null,
    bridgeReport: null,
  })),
  readEpisodeInbox: vi.fn(async () => h.inboxReads.shift() ?? []),
  emitNestedBubble: vi.fn(async (frame: NestedBubbleFrame) => {
    h.frames.push(frame);
  }),
  finalizeTurn: vi.fn(
    async (_slice: unknown, outcome: TurnOutcome, _input: unknown, _hk: unknown, nested?: NestedTurnTail) => {
      h.finalizeCalls.push({ outcome, nested });
    },
  ),
  closeTurnStream: h.closeStream,
  ringReflection: h.ring,
}));

import { turnWorkflow } from "@/app/api/chat/turn-workflow";

const SLICE: TimeSlice = {
  slice_id: "2026-07-14-0900",
  focus: "",
  status: "active",
  start: "2026-07-14T09:00:00.000Z",
  timezone: "UTC",
  summary: "",
  open_loops: [],
  decisions: [],
  tags: [],
  related_slices: [],
  loops: [],
  turns: [{ timestamp: "2026-07-14T09:00:10.000Z", role: "user", content: "first question", turnId: "t-main" }],
  estimatedTokens: 0,
  emotional_tone: "neutral",
};

function makeInput(): TurnInput {
  return {
    modelMessages: [{ role: "user", content: "first question" }],
    recentTurns: [],
    lastUserMessage: "first question",
    model: "deepseek-v4-flash",
    modelConfig: {
      id: "deepseek-v4-flash",
      name: "DeepSeek V4 Flash",
      provider: "deepseek",
      providerName: "DeepSeek",
      sdk: "deepseek",
      envKey: "DEEPSEEK_API_KEY",
      capabilities: { thinking: true, vision: false, maxTokens: 393216 },
      defaultThinking: false,
      defaultEffort: "low",
    },
    thinking: true,
    reasoningEffort: "medium",
    clientTimezone: "UTC",
    locale: "en",
    config: {
      slicing: { maxSliceMinutes: 30, maxTurnsPerSlice: 40, idleGapMinutes: 15 },
      model: { provider: "deepseek-v4-flash", thinking: true, reasoningEffort: "medium" },
    },
    owner: "local",
    repo: "local",
    useGithub: false,
    useDemo: false,
    startedAtIso: "2026-07-14T09:00:10.000Z",
    turnId: "t-main",
    imageAttachments: [],
  } as TurnInput;
}

const U2 = { turnId: "u2", timestamp: "2026-07-14T09:01:00.000Z", text: "queued question two" };
const U3 = { turnId: "u3", timestamp: "2026-07-14T09:02:00.000Z", text: "queued question three" };

beforeEach(() => {
  vi.clearAllMocks();
  h.inboxQueue.length = 0;
  h.hookTokens.length = 0;
  h.startedInner.length = 0;
  h.frames.length = 0;
  h.finalizeCalls.length = 0;
  h.streamCalls.length = 0;
  h.streamAnswers.length = 0;
  h.streamErrors.length = 0;
  h.inboxReads.length = 0;
});

describe("§8-a spike — E drains two queued messages into nested bubbles", () => {
  it("spawns one inner run per unanswered message, collects both bubbles, merges once, finalize lands ONE tail", async () => {
    h.streamAnswers.push("main answer", "merged closing");
    // The drain's first disk read sees the two arrivals; every re-read after
    // the spawns sees them as in-flight (registered) → empty.
    h.inboxReads.push([U2, U3]);

    await turnWorkflow(makeInput());

    // The inbox hook rode the run's own id (ownRunId), token `episode:run-E`.
    expect(h.hookTokens).toEqual(["episode:run-E"]);

    // Two inner runs, deterministic ids, each carrying its envelope + the
    // return address; spawn region matches the repo's starts (D10).
    expect(h.startedInner.map((i) => [i.turnId, i.replyTo, i.inboxToken])).toEqual([
      ["nu2", "u2", "episode:run-E"],
      ["nu3", "u3", "episode:run-E"],
    ]);
    expect(h.startedInner[0].envelope).toContain("## Your target");
    expect(h.startedInner[0].envelope).toContain("queued question two");

    // The frame stream: queued+running at spawn, done with text at collection.
    expect(h.frames.map((f) => `${f.status}:${f.turnId}`)).toEqual([
      "queued:nu2",
      "running:nu2",
      "queued:nu3",
      "running:nu3",
      "done:nu2",
      "done:nu3",
    ]);
    expect(h.frames[4]).toMatchObject({ replyTo: "u2", text: "answer for u2" });

    // agent.stream ran TWICE: the main answer, then the merge pass whose
    // message tail is the mechanical wrap-up brief.
    expect(h.streamCalls).toHaveLength(2);
    const mergeMsgs = h.streamCalls[1].messages as Array<{ role: string; content: string }>;
    expect(mergeMsgs.at(-1)).toMatchObject({ role: "user" });
    expect(mergeMsgs.at(-1)!.content).toContain("Episode wrap-up");

    // finalize ONCE, with both bubbles and the merge summary in the tail.
    expect(h.finalizeCalls).toHaveLength(1);
    const { outcome, nested } = h.finalizeCalls[0];
    expect(outcome.text).toBe("main answer");
    expect(outcome.finishReason).toBe("stop");
    expect(nested?.mergeSummary).toBe("merged closing");
    expect(nested?.bubbles).toEqual([
      { turnId: "nu2", replyTo: "u2", text: "answer for u2", finishReason: "stop" },
      { turnId: "nu3", replyTo: "u3", text: "answer for u3", finishReason: "stop" },
    ]);
    expect(h.closeStream).toHaveBeenCalledTimes(1);
    expect(h.ring).toHaveBeenCalledTimes(1);
  });

  it("兼任 path: no arrivals → no spawns, no frames, no merge pass, nestedTail stays undefined", async () => {
    h.streamAnswers.push("main answer");
    // inboxReads empty → every disk read returns [].

    await turnWorkflow(makeInput());

    expect(h.startedInner).toEqual([]);
    expect(h.frames).toEqual([]);
    expect(h.streamCalls).toHaveLength(1); // no merge pass
    expect(h.finalizeCalls).toHaveLength(1);
    expect(h.finalizeCalls[0].nested).toBeUndefined();
    expect(h.finalizeCalls[0].outcome.text).toBe("main answer");
  });

  it("a textless bubble settles as failed and the merge brief still runs (D4 honesty)", async () => {
    h.streamAnswers.push("main answer", "merged closing");
    h.inboxReads.push([U2]);
    // This inner run reports back with NO text — a failed instance.
    const { start } = await import("workflow/api");
    vi.mocked(start).mockImplementationOnce(async (_fn, args: [InnerTurnInput]) => {
      const inner = args[0];
      h.startedInner.push(inner);
      h.inboxQueue.push({
        kind: "bubble",
        turnId: inner.turnId,
        replyTo: inner.replyTo,
        text: "",
        finishReason: "error",
      });
      return { runId: "inner-nu2" };
    });

    await turnWorkflow(makeInput());

    expect(h.frames.map((f) => `${f.status}:${f.turnId}`)).toEqual([
      "queued:nu2",
      "running:nu2",
      "failed:nu2",
    ]);
    const { nested } = h.finalizeCalls[0];
    expect(nested?.bubbles).toEqual([
      { turnId: "nu2", replyTo: "u2", text: "", finishReason: "error" },
    ]);
    // the merge pass still ran — its brief states the failure (§3.6)
    const mergeMsgs = h.streamCalls[1].messages as Array<{ content: string }>;
    expect(mergeMsgs.at(-1)!.content).toContain("NOT answered");
    expect(nested?.mergeSummary).toBe("merged closing");
  });

  it("a failed MERGE pass degrades to bubbles-without-summary — finalize still lands (D4)", async () => {
    h.streamAnswers.push("main answer");
    h.inboxReads.push([U2]);
    // The main stream call succeeds (placeholder), the merge pass throws.
    h.streamErrors.push("", "merge model blew up");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await turnWorkflow(makeInput());
    } finally {
      errSpy.mockRestore();
    }

    const { nested } = h.finalizeCalls[0];
    expect(nested?.bubbles).toEqual([
      { turnId: "nu2", replyTo: "u2", text: "answer for u2", finishReason: "stop" },
    ]);
    // bubbles stand on their own — no closing summary, and the turn itself
    // still finalized clean (the episode phase never takes down an answer)
    expect(nested?.mergeSummary).toBeUndefined();
    expect(h.finalizeCalls[0].outcome.finishReason).toBe("stop");
  });
});
