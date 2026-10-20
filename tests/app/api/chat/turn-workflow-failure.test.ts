/**
 * turnWorkflow — the v0.42 §5 failure floor ([11279]: 除非更严重的错误,
 * workflow 保证把能提交的都提交上去). The steps module and the agent are
 * mocked; the workflow body runs REAL. A TRANSIENT agent.stream failure
 * re-throws (classifyWorkflowError → transient → platform retry) into the
 * workflow's outer catch — and the tail below it MUST still run: the turn's
 * record is produced (empty reply, honest error), the last-one judgment
 * happens, and the summary run is woken so the user message lands. The run
 * then re-throws — the failure is reported, not hidden.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  housekeeping: vi.fn(),
  finalizeTurn: vi.fn(async () => {}),
  closeTurnStream: vi.fn(async () => {}),
  decideBurstMergeLine: vi.fn(async (): Promise<string | undefined> => undefined),
  shouldStartSummary: vi.fn(async () => true),
  startSummaryRun: vi.fn(async (_payload: unknown) => "run-summary-1"),
  streamError: null as Error | null,
}));

vi.mock("workflow", () => ({
  createHook: vi.fn(),
  getWritable: () => ({
    getWriter: () => ({
      write: vi.fn(async () => {}),
      releaseLock: () => {},
    }),
  }),
  sleep: vi.fn(async () => {}),
}));

vi.mock("@/app/api/chat/steps", () => ({
  housekeeping: h.housekeeping,
  finalizeTurn: h.finalizeTurn,
  closeTurnStream: h.closeTurnStream,
  decideBurstMergeLine: h.decideBurstMergeLine,
  shouldStartSummary: h.shouldStartSummary,
  startSummaryRun: h.startSummaryRun,
  ownRunId: vi.fn(async () => "run-1"),
  episodeClockMs: vi.fn(() => 0),
  readEpisodeInbox: vi.fn(async () => null),
  emitNestedBubble: vi.fn(async () => {}),
  pollInnerRunReports: vi.fn(async () => []),
}));

vi.mock("@/app/api/agent/agent", () => ({
  createChatAgent: vi.fn(() => ({
    // The answer stream blows up mid-turn with a TRANSIENT error —
    // classifyWorkflowError rethrows those into the workflow's outer catch.
    stream: vi.fn(async () => {
      throw (h.streamError ?? new Error("ECONNRESET: provider socket dropped"));
    }),
  })),
}));

vi.mock("@/app/api/agent/tools", () => ({
  buildChatToolsContext: vi.fn(() => ({})),
}));

vi.mock("@/lib/capabilities", () => ({ DEPLOY_GUIDE_URL: "https://example.test" }));

vi.mock("@/app/api/chat/inner-turn-workflow", () => ({
  innerTurnWorkflow: vi.fn(),
}));
vi.mock("@/app/api/chat/inner-envelope", () => ({
  buildInnerEnvelope: vi.fn(() => null),
  buildMergeSummaryBrief: vi.fn(() => null),
}));

import { turnWorkflow } from "@/app/api/chat/turn-workflow";
import type { TurnInput } from "@/lib/chat/turn-types";
import type { UserConfig } from "@/lib/config/types";
import type { TimeSlice } from "@/lib/episodic";

const SLICE_ID = "2026-10-20-1836";
const USER_TEXT = "我的问题";
const TURN_ID = "a1b2c3";

const SLICE: TimeSlice = {
  slice_id: SLICE_ID,
  focus: "",
  summary: "",
  status: "active",
  start: "2026-10-20T18:36:00.000Z",
  timezone: "UTC",
  open_loops: [],
  decisions: [],
  tags: [],
  related_slices: [],
  loops: [],
  turns: [
    {
      timestamp: "2026-10-20T18:36:00.000Z",
      role: "user",
      content: USER_TEXT,
      turnId: TURN_ID,
    },
  ],
  estimatedTokens: 16,
};

function hkResult() {
  return {
    slice: SLICE,
    previouslyContent: "",
    sliceHeadBlock: "",
    identityPrompt: "",
    analysis: null,
    bridgeReport: null,
    evidenceAttachments: null,
    previouslyUpdate: null,
    sliceOnDisk: true,
  };
}

function input(): TurnInput {
  const modelConfig = {
    id: "test-model",
    name: "Test",
    provider: "deepseek",
    providerName: "DeepSeek",
    sdk: "deepseek",
    envKey: "TEST_KEY",
    thinking: false,
    reasoningEffort: "low",
  } as unknown as TurnInput["modelConfig"];
  return {
    modelMessages: [{ role: "user", content: USER_TEXT }],
    recentTurns: [{ role: "user", content: USER_TEXT }],
    lastUserMessage: USER_TEXT,
    model: "test-model",
    modelConfig,
    thinking: false,
    reasoningEffort: "low",
    clientTimezone: "UTC",
    locale: "zh",
    config: {
      slicing: { maxSliceMinutes: 30, maxTurnsPerSlice: 40, idleGapMinutes: 720 },
      // UserConfig carries its OWN ModelConfig shape (config/types.ts) —
      // cast, same as the TurnInput one above.
      model: modelConfig as unknown as UserConfig["model"],
    },
    owner: "local",
    repo: "local",
    useGithub: false,
    useDemo: false,
    startedAtIso: "2026-10-20T18:40:00.000Z",
    turnId: TURN_ID,
    imageAttachments: [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.housekeeping.mockResolvedValue(hkResult());
  h.streamError = null;
});

describe("turnWorkflow — the v0.42 §5 failure floor", () => {
  it("a. a mid-answer transient failure → the run still produces its record, reaches the last-one judgment, wakes the summary, THEN fails honestly", async () => {
    await expect(turnWorkflow(input())).rejects.toThrow("ECONNRESET");

    // the tail ran: finalize, then the summary start (the last-one check is
    // BYPASSED for a failed run — see the sibling test below), carrying the
    // honest record.
    expect(h.finalizeTurn).toHaveBeenCalledTimes(1);
    expect(h.shouldStartSummary).not.toHaveBeenCalled(); // failed runs bypass it
    expect(h.startSummaryRun).toHaveBeenCalledTimes(1);
    const payload = h.startSummaryRun.mock.calls[0]![0] as unknown as {
      sliceId: string;
      own: { turnId: string; userText: string; replyText: string };
    };
    expect(payload.sliceId).toBe(SLICE_ID);
    expect(payload.own.turnId).toBe(TURN_ID);
    expect(payload.own.userText).toBe(USER_TEXT); // 用户那句话 — the floor
    expect(payload.own.replyText).toBe(""); // 没产出的就是没有, honestly
    expect(h.closeTurnStream).toHaveBeenCalledTimes(1);
  });

  it("a failed turn that is NOT the last still wakes its own summary — the user message has no other way to land (§5 [11279])", async () => {
    // The burst's real last survivor would say NO (a sibling is still
    // answering) — but a FAILED run has no returnValue, so waiting for the
    // survivor would lose this turn's user message forever.
    h.shouldStartSummary.mockResolvedValue(false);

    await expect(turnWorkflow(input())).rejects.toThrow("ECONNRESET");

    expect(h.shouldStartSummary).not.toHaveBeenCalled(); // the bypass
    expect(h.startSummaryRun).toHaveBeenCalledTimes(1);
    const payload = h.startSummaryRun.mock.calls[0]![0] as unknown as {
      own: { userText: string; replyText: string };
    };
    expect(payload.own.userText).toBe(USER_TEXT);
    expect(payload.own.replyText).toBe("");
  });

});
