/**
 * ORCHESTRATOR-SHELL spike (v0.31, formerly the v0.30 §8-a nested-episode
 * spike) — the outer run E as a pure dispatch/persistence shell: EVERY user
 * message (the episode's first included) is answered by its own child run;
 * E spawns mechanically, drains the inbox, merges once when the episode was
 * multi-message (or saw a failure), and finalizeTurn lands ONE tail.
 *
 * Everything durable is mocked at the module boundary: the workflow runtime
 * (createHook/getWritable/sleep), the runtime API (start), the agent factory,
 * and every step (housekeeping/finalizeTurn/readEpisodeInbox/emitNestedBubble/
 * episodeClockMs/…). The workflow body itself — the drain loop, the envelope
 * assembly, the watchdog, the merge pass, the tail — runs REAL; that is what
 * the spike exists to prove.
 *
 * The mocked hook implements REAL async-iterator semantics (a next() with no
 * queued event registers a waiter that a later push resolves) — the drain's
 * single-pending-next discipline depends on it; the old shift-on-call fake
 * would deadlock the loop it pretended to drive.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TimeSlice } from "@/lib/episodic";
import type { InnerTurnInput, NestedTurnTail, TurnInput, TurnOutcome } from "@/lib/chat/turn-types";
import type { NestedBubbleFrame } from "@/lib/chat/nested-bubble";

const h = vi.hoisted(() => {
  /** Bubble reports the (mocked) child runs make — start() pushes here. */
  const inboxQueue: unknown[] = [];
  /** Pending next() waits on the hook iterator, oldest first. */
  const inboxWaiters: Array<(r: { value: unknown; done: false }) => void> = [];
  /** Real iterator semantics: resolve the oldest waiter, else enqueue. */
  const pushInbox = (v: unknown) => {
    const w = inboxWaiters.shift();
    if (w) w({ value: v, done: false });
    else inboxQueue.push(v);
  };
  return {
    inboxQueue,
    inboxWaiters,
    pushInbox,
    /** createHook capture: one hook per run, token asserted in tests. */
    hookTokens: [] as string[],
    /** start() capture: the child inputs E spawned. */
    startedInner: [] as InnerTurnInput[],
    /** emitNestedBubble capture: the frame stream E produced. */
    frames: [] as NestedBubbleFrame[],
    /** finalizeTurn capture. */
    finalizeCalls: [] as Array<{ outcome: TurnOutcome; nested: NestedTurnTail | undefined }>,
    /** agent.stream answers, shifted per call (the merge pass is the ONLY
     *  stream call an orchestrator run makes). */
    streamAnswers: [] as string[],
    /** agent.stream failures, shifted per call BEFORE the answer queue. */
    streamErrors: [] as string[],
    streamCalls: [] as Array<{ messages: unknown[]; system: string }>,
    /** readEpisodeInbox script: shifted per call; empty when exhausted. */
    inboxReads: [] as Array<Array<{ turnId: string; timestamp: string; text: string }>>,
    /** readEpisodeInbox failures, shifted per call BEFORE the reads script
     *  ("" = no-op — the lap reads normally). */
    inboxReadErrors: [] as string[],
    /** Children (by instance turnId) whose report is empty+error. */
    failInner: new Set<string>(),
    /** Children that NEVER report — the watchdog's test subject. */
    silentInner: new Set<string>(),
    /** episodeClockMs script: shifted per call; real Date.now() when empty. */
    clockValues: [] as number[],
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
        next: (): Promise<{ value: unknown; done: false }> => {
          const v = h.inboxQueue.shift();
          if (v !== undefined) return Promise.resolve({ value: v, done: false });
          // No event queued — park a waiter; a later pushInbox resolves it
          // (a queued resolution is a microtask, so it ALWAYS beats the 5 ms
          // sleep arm in the drain's race).
          return new Promise((resolve) => {
            h.inboxWaiters.push(resolve);
          });
        },
        return: () => {
          // Release any parked waiter so nothing dangles after the drain.
          const w = h.inboxWaiters.shift();
          if (w) w({ value: undefined, done: false });
          return Promise.resolve({ value: undefined, done: true });
        },
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
  // The child run "completes" instantly: its bubble report lands in the inbox
  // the moment E spawns it (the report's real path — child workflow →
  // reportInnerBubble step → resumeHook — is a one-line wrapper; the spike's
  // subject is E's drain, not the wire). silentInner children never report.
  start: vi.fn(async (_fn: unknown, args: [InnerTurnInput], _opts?: unknown) => {
    const inner = args[0];
    h.startedInner.push(inner);
    if (!h.silentInner.has(inner.turnId)) {
      const failed = h.failInner.has(inner.turnId);
      h.pushInbox({
        kind: "bubble",
        turnId: inner.turnId,
        replyTo: inner.replyTo,
        text: failed ? "" : `answer for ${inner.replyTo}`,
        finishReason: failed ? "error" : "stop",
      });
    }
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

// The child workflow module is replaced by a bare symbol — E only hands it to
// start(); its body never runs here.
vi.mock("@/app/api/chat/inner-turn-workflow", () => ({
  innerTurnWorkflow: vi.fn(),
}));

vi.mock("@/app/api/chat/steps", () => ({
  ownRunId: vi.fn(async () => "run-E"),
  episodeClockMs: vi.fn(async () => h.clockValues.shift() ?? Date.now()),
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
  readEpisodeInbox: vi.fn(async () => {
    const err = h.inboxReadErrors.shift();
    if (err) throw new Error(err);
    return h.inboxReads.shift() ?? [];
  }),
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
    clientMessageId: "msg-1",
    imageAttachments: [],
  } as TurnInput;
}

const U2 = { turnId: "u2", timestamp: "2026-07-14T09:01:00.000Z", text: "queued question two" };
const U3 = { turnId: "u3", timestamp: "2026-07-14T09:02:00.000Z", text: "queued question three" };

beforeEach(() => {
  vi.clearAllMocks();
  h.inboxQueue.length = 0;
  h.inboxWaiters.length = 0;
  h.hookTokens.length = 0;
  h.startedInner.length = 0;
  h.frames.length = 0;
  h.finalizeCalls.length = 0;
  h.streamCalls.length = 0;
  h.streamAnswers.length = 0;
  h.streamErrors.length = 0;
  h.inboxReads.length = 0;
  h.inboxReadErrors.length = 0;
  h.clockValues.length = 0;
  h.failInner.clear();
  h.silentInner.clear();
});

describe("v0.31 orchestrator shell — E spawns one child per message, never answers itself", () => {
  it("first message + two arrivals → three child runs, one merge, finalize lands ONE tail", async () => {
    h.streamAnswers.push("merged closing");
    // The drain's first disk read sees the two arrivals; every re-read after
    // the spawns sees them as in-flight (registered) → empty.
    h.inboxReads.push([U2, U3]);

    await turnWorkflow(makeInput());

    // The inbox hook rode the run's own id (ownRunId), token `episode:run-E`.
    expect(h.hookTokens).toEqual(["episode:run-E"]);

    // Three child runs — the FIRST MESSAGE included — deterministic ids, each
    // carrying the return address; spawn region matches the repo's starts (D10).
    expect(h.startedInner.map((i) => [i.turnId, i.replyTo, i.inboxToken])).toEqual([
      ["nt-main", "t-main", "episode:run-E"],
      ["nu2", "u2", "episode:run-E"],
      ["nu3", "u3", "episode:run-E"],
    ]);
    // The first child rides the turn's own message window, NOT an envelope…
    expect(h.startedInner[0].messages).toEqual([
      { role: "user", content: "first question" },
    ]);
    // …arrivals get the mechanical envelope as their single user message.
    const u2Msg = h.startedInner[1].messages[0] as { role: string; content: string };
    expect(u2Msg.role).toBe("user");
    expect(u2Msg.content).toContain("## Your target");
    expect(u2Msg.content).toContain("queued question two");

    // The frame stream: queued+running (with the child runId) at spawn, done
    // with text at collection; the FIRST instance's frames carry the anchor.
    expect(h.frames.map((f) => `${f.status}:${f.turnId}`)).toEqual([
      "queued:nt-main",
      "running:nt-main",
      "queued:nu2",
      "running:nu2",
      "queued:nu3",
      "running:nu3",
      "done:nt-main",
      "done:nu2",
      "done:nu3",
    ]);
    expect(h.frames[0]).toMatchObject({ anchorId: "msg-1" });
    expect(h.frames[1]).toMatchObject({ runId: "inner-nt-main", anchorId: "msg-1" });
    expect(h.frames[3]).toMatchObject({ runId: "inner-nu2" });
    expect(h.frames[3].anchorId).toBeUndefined();
    expect(h.frames[6]).toMatchObject({ replyTo: "t-main", text: "answer for t-main" });

    // The orchestrator's ONLY model call is the merge pass — its single user
    // message is the mechanical wrap-up brief.
    expect(h.streamCalls).toHaveLength(1);
    const mergeMsgs = h.streamCalls[0].messages as Array<{ role: string; content: string }>;
    expect(mergeMsgs).toHaveLength(1);
    expect(mergeMsgs[0].content).toContain("Episode wrap-up");

    // finalize ONCE, with all three bubbles and the merge summary in the tail;
    // the orchestrator's own outcome carries NO answer text.
    expect(h.finalizeCalls).toHaveLength(1);
    const { outcome, nested } = h.finalizeCalls[0];
    expect(outcome.text).toBe("");
    expect(outcome.finishReason).toBe("stop");
    expect(nested?.mergeSummary).toBe("merged closing");
    expect(nested?.bubbles).toEqual([
      { turnId: "nt-main", replyTo: "t-main", text: "answer for t-main", finishReason: "stop" },
      { turnId: "nu2", replyTo: "u2", text: "answer for u2", finishReason: "stop" },
      { turnId: "nu3", replyTo: "u3", text: "answer for u3", finishReason: "stop" },
    ]);
    expect(h.closeStream).toHaveBeenCalledTimes(1);
    expect(h.ring).toHaveBeenCalledTimes(1);
  });

  it("single-message episode: exactly one child, no merge pass — the bubble IS the answer", async () => {
    // inboxReads empty → every disk read returns [].
    await turnWorkflow(makeInput());

    expect(h.startedInner.map((i) => i.turnId)).toEqual(["nt-main"]);
    expect(h.frames.map((f) => `${f.status}:${f.turnId}`)).toEqual([
      "queued:nt-main",
      "running:nt-main",
      "done:nt-main",
    ]);
    // No model call on the outer run at all.
    expect(h.streamCalls).toHaveLength(0);
    expect(h.finalizeCalls).toHaveLength(1);
    const { outcome, nested } = h.finalizeCalls[0];
    expect(outcome.text).toBe("");
    expect(nested?.mergeSummary).toBeUndefined();
    expect(nested?.bubbles).toEqual([
      { turnId: "nt-main", replyTo: "t-main", text: "answer for t-main", finishReason: "stop" },
    ]);
  });

  it("a textless child settles as failed and the merge brief still runs (D4 honesty)", async () => {
    h.streamAnswers.push("merged closing");
    h.inboxReads.push([U2]);
    h.failInner.add("nu2");

    await turnWorkflow(makeInput());

    expect(h.frames.map((f) => `${f.status}:${f.turnId}`)).toEqual([
      "queued:nt-main",
      "running:nt-main",
      "queued:nu2",
      "running:nu2",
      "done:nt-main",
      "failed:nu2",
    ]);
    const { nested } = h.finalizeCalls[0];
    expect(nested?.bubbles).toEqual([
      { turnId: "nt-main", replyTo: "t-main", text: "answer for t-main", finishReason: "stop" },
      { turnId: "nu2", replyTo: "u2", text: "", finishReason: "error" },
    ]);
    // The merge pass ran BECAUSE a failure needs stating (§3.6) — its brief
    // names the unanswered message.
    expect(h.streamCalls).toHaveLength(1);
    const mergeMsgs = h.streamCalls[0].messages as Array<{ content: string }>;
    expect(mergeMsgs[0].content).toContain("NOT answered");
    expect(nested?.mergeSummary).toBe("merged closing");
  });

  it("a failed MERGE pass degrades to bubbles-without-summary — finalize still lands (D4)", async () => {
    h.inboxReads.push([U2]);
    // The merge pass (the orchestrator's only stream call) throws.
    h.streamErrors.push("merge model blew up");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await turnWorkflow(makeInput());
    } finally {
      errSpy.mockRestore();
    }

    const { nested } = h.finalizeCalls[0];
    expect(nested?.bubbles).toEqual([
      { turnId: "nt-main", replyTo: "t-main", text: "answer for t-main", finishReason: "stop" },
      { turnId: "nu2", replyTo: "u2", text: "answer for u2", finishReason: "stop" },
    ]);
    // Bubbles stand on their own — no closing summary, and the turn itself
    // still finalized clean (the episode phase never takes down an answer).
    expect(nested?.mergeSummary).toBeUndefined();
    expect(h.finalizeCalls[0].outcome.finishReason).toBe("stop");
  });

  it("看门狗: a child that never reports is failed by the watchdog, and the episode still closes", async () => {
    h.streamAnswers.push("closing notes the failure");
    h.silentInner.add("nt-main");
    // Two laps of the step-stamped clock: spawn at T0, next lap T0+11min —
    // past the 10-minute watchdog bound.
    const T0 = 1_760_000_000_000;
    h.clockValues.push(T0, T0 + 11 * 60_000);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await turnWorkflow(makeInput());
    } finally {
      errSpy.mockRestore();
    }

    expect(h.frames.map((f) => `${f.status}:${f.turnId}`)).toEqual([
      "queued:nt-main",
      "running:nt-main",
      "failed:nt-main",
    ]);
    const { outcome, nested } = h.finalizeCalls[0];
    expect(nested?.bubbles).toEqual([
      { turnId: "nt-main", replyTo: "t-main", text: "", finishReason: "timeout" },
    ]);
    // The failure is stated by the merge pass (hasFailed triggers it even for
    // a single instance), and the turn still finalized clean.
    expect(nested?.mergeSummary).toBe("closing notes the failure");
    expect(outcome.finishReason).toBe("stop");
  });

  it("orchestrator death mid-episode: in-flight instances fail LOUDLY, settled ones keep their verdict", async () => {
    // Lap 1 reads the arrival and spawns both children; nt-main's report lands
    // instantly (done). Lap 2's disk read throws — the drain dies with nu2
    // still running. The catch must fail nu2 on the wire and must NOT touch
    // nt-main's settled verdict (the inverted-guard regression: running rows
    // were skipped and done rows clobbered to failed).
    h.inboxReads.push([U2]);
    h.inboxReadErrors.push("", "disk exploded");
    h.silentInner.add("nu2");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await turnWorkflow(makeInput());
    } finally {
      errSpy.mockRestore();
    }

    expect(h.frames.map((f) => `${f.status}:${f.turnId}`)).toEqual([
      "queued:nt-main",
      "running:nt-main",
      "queued:nu2",
      "running:nu2",
      "done:nt-main",
      "failed:nu2",
    ]);
    expect(h.streamCalls).toHaveLength(0); // no merge pass in the catch path
    expect(h.finalizeCalls).toHaveLength(1);
    const { outcome, nested } = h.finalizeCalls[0];
    expect(outcome.finishReason).toBe("stop");
    expect(nested?.bubbles).toEqual([
      { turnId: "nt-main", replyTo: "t-main", text: "answer for t-main", finishReason: "stop" },
      { turnId: "nu2", replyTo: "u2", text: "", finishReason: "error" },
    ]);
    expect(h.closeStream).toHaveBeenCalledTimes(1);
    expect(h.ring).toHaveBeenCalledTimes(1);
  });
});
