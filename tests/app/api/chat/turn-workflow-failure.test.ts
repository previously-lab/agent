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
  successful: false,
  nativeStep: null as null | {role:"assistant";content:string;deepseek:{role:"assistant";content:string;reasoning_content:string}},
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
  createChatAgent: vi.fn((opts: {onStepEnd?: (step: unknown) => void}) => ({
    // The answer stream blows up mid-turn with a TRANSIENT error —
    // classifyWorkflowError rethrows those into the workflow's outer catch.
    stream: vi.fn(async () => {
      if (h.nativeStep) opts.onStepEnd?.({text:h.nativeStep.content,response:{messages:[h.nativeStep]},reasoning:[{type:"reasoning",text:h.nativeStep.deepseek.reasoning_content}],toolCalls:[],toolResults:[]});
      if (h.successful) return {
        messages: [{ role: "system", content: "fixture" }, { role: "user", content: "我的问题" }, { role: "assistant", content: "already produced answer" }],
        steps: [], finishReason: "stop",
      };
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

import {
  buildTurnToolContext,
  turnWorkflow,
} from "@/app/api/chat/turn-workflow";
import { buildChatToolsContext } from "@/app/api/agent/tools";
import { NEUTRAL_ROOM_PROFILE } from "@/lib/game/room-profile";
import { ROOM_SNAPSHOT_GENERATOR_VERSION } from "@/lib/game/room-snapshot";
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
  h.successful = false;
  h.nativeStep = null;
  h.finalizeTurn.mockResolvedValue(undefined);
  h.startSummaryRun.mockResolvedValue("run-summary-1");
  h.shouldStartSummary.mockResolvedValue(true);
});

describe("turnWorkflow — the v0.42 §5 failure floor", () => {
  it("a final active-write failure still hands off the produced answer and closes its stream", async () => {
    h.successful = true;
    h.finalizeTurn.mockRejectedValueOnce(new Error("final write refused"));
    await expect(turnWorkflow(input())).rejects.toThrow("final write refused");
    expect(h.startSummaryRun).toHaveBeenCalledOnce();
    expect(h.startSummaryRun.mock.calls[0]![0]).toMatchObject({ own: { userText: USER_TEXT, replyText: "already produced answer" } });
    expect(h.closeTurnStream).toHaveBeenCalledWith(expect.anything(), TURN_ID, { summaryRunId: "run-summary-1" });
  });

  it("a failed persistence handoff closes honestly without invoking the answer a second time", async () => {
    h.successful = true;
    h.startSummaryRun.mockRejectedValueOnce(new Error("handoff acknowledgement lost"));
    await expect(turnWorkflow(input())).rejects.toThrow("handoff acknowledgement lost");
    expect(h.startSummaryRun).toHaveBeenCalledOnce();
    expect(h.closeTurnStream).toHaveBeenCalledWith(expect.objectContaining({ text: "already produced answer", error: "handoff acknowledgement lost" }), TURN_ID, undefined);
  });

  it("preserves the validated view in outer and inner context construction", async () => {
    const view: NonNullable<TurnInput["view"]> = {
      sliceId: SLICE_ID,
      surface: "room",
      snapshot: {
        sliceId: SLICE_ID,
        generatorVersion: ROOM_SNAPSHOT_GENERATOR_VERSION,
        profile: NEUTRAL_ROOM_PROFILE,
        roomDoorCount: 2,
        corridorSide: "north",
      },
    };
    const withView = { ...input(), view };
    const outer = buildTurnToolContext(withView, SLICE_ID, "system", true);
    const inner = buildTurnToolContext(withView, SLICE_ID, "system", false);
    expect(outer.view).toBe(view);
    expect(inner.view).toBe(view);
    expect(outer.imageAttachments).toEqual([]);
    expect(inner.imageAttachments).toBeUndefined();

    h.successful = true;
    await turnWorkflow(withView);
    expect(vi.mocked(buildChatToolsContext)).toHaveBeenCalledWith(
      expect.objectContaining({ view }),
    );
  });

  it("regenerate and stable client identity cross the durable handoff", async () => {
    h.successful = true;
    const result = await turnWorkflow({ ...input(), regenerate: true, clientMessageId: "original-question" });
    expect(result).toMatchObject({ regenerate: true, clientMessageId: "original-question", summaryRunId: "run-summary-1" });
    expect(h.startSummaryRun.mock.calls[0]![0]).toMatchObject({ own: { regenerate: true, clientMessageId: "original-question" } });
  });
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


it("retains checkpointed native output after a provider failure without another paid attempt", async () => {
  h.nativeStep = {role:"assistant",content:"already streamed partial",deepseek:{role:"assistant",content:"already streamed partial",reasoning_content:"preserved reasoning"}};
  h.streamError = Object.assign(new Error("upstream unavailable after retries"),{name:"DeepSeekError",statusCode:503});
  const result = await turnWorkflow(input());
  expect(result.replyText).toBe("already streamed partial");
  expect(result.nativeMessages).toEqual([h.nativeStep]);
  expect(result.cognition).toContain("preserved reasoning");
  expect(h.startSummaryRun).toHaveBeenCalledOnce();
  expect(h.startSummaryRun.mock.calls[0][0]).toMatchObject({own:{replyText:"already streamed partial",nativeMessages:undefined}});
  expect(h.closeTurnStream).toHaveBeenCalledWith(expect.objectContaining({text:"already streamed partial",finishReason:"error"}),TURN_ID,{summaryRunId:"run-summary-1"});
});
