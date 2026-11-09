import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelMessage } from "@/lib/deepseek/types";
import type { TurnInput } from "@/lib/chat/turn-types";
import type { TimeSlice } from "@/lib/episodic";

const h = vi.hoisted(() => ({
  housekeeping: vi.fn(),
  closeTurnStream: vi.fn(async () => {}),
  finalizeTurn: vi.fn(async () => {}),
  record: vi.fn(),
  closeThoughts: vi.fn(async () => {}),
  beginLegacy: vi.fn(),
  completeLegacy: vi.fn(),
  stream: vi.fn(),
  agentOptions: null as null | {
    toolsContext: Record<string, { dialogueOffer?: unknown }>;
    onStepEnd: (step: unknown) => Promise<void>;
  },
  text: "可以交付的结果",
  finishReason: "stop",
  extraMessages: [] as ModelMessage[],
  finishThinking: null as null | { toolCallId: string; input: unknown },
}));

vi.mock("workflow", () => ({
  createHook: vi.fn(), sleep: vi.fn(async () => {}),
  getWritable: () => ({}),
}));
vi.mock("workflow/api", () => ({ start: vi.fn() }));
vi.mock("@/app/api/chat/steps", () => ({
  housekeeping: h.housekeeping,
  finalizeTurn: h.finalizeTurn,
  closeTurnStream: h.closeTurnStream,
  decideBurstMergeLine: vi.fn(),
  shouldStartSummary: vi.fn(),
  startSummaryRun: vi.fn(),
  ownRunId: vi.fn(async () => "wrun_01JTESTPARENT0000000000000"),
  episodeClockMs: vi.fn(), readEpisodeInbox: vi.fn(), emitNestedBubble: vi.fn(), pollInnerRunReports: vi.fn(),
}));
vi.mock("@/app/api/chat/dialogue-steps", () => ({
  beginDialogueWorkStep: h.beginLegacy,
  completeDialogueWorkStep: h.completeLegacy,
}));
vi.mock("@/app/api/chat/dialogue-transport-steps", () => ({
  closeDialogueThoughtsStep: h.closeThoughts,
  startDialogueRecordRunStep: h.record,
}));
vi.mock("@/app/api/agent/tools", () => ({ buildChatToolsContext: (context: unknown) => ({ context }) }));
vi.mock("@/app/api/agent/agent", () => ({
  createChatAgent: vi.fn(),
  createThinkingAgent: (options: NonNullable<typeof h.agentOptions>) => {
    h.agentOptions = options;
    return {
      stream: async (streamOptions: unknown) => {
        h.stream(streamOptions);
        await options.onStepEnd({
          text: h.text,
          response: { messages: [{ role: "assistant", content: h.text }, ...h.extraMessages] },
          toolCalls: h.finishThinking
            ? [{ toolCallId: h.finishThinking.toolCallId, toolName: "finishThinking", input: h.finishThinking.input }]
            : [],
          toolResults: [],
        });
        return {
          messages: [{ role: "system", content: "" }, { role: "user", content: "question" }, { role: "assistant", content: h.text }],
          finishReason: h.finishReason,
          steps: [],
        };
      },
    };
  },
}));
vi.mock("@/app/api/chat/inner-turn-workflow", () => ({ innerTurnWorkflow: vi.fn() }));
vi.mock("@/lib/capabilities", () => ({ DEPLOY_GUIDE_URL: "https://example.test" }));

import { turnWorkflow } from "@/app/api/chat/turn-workflow";

const slice: TimeSlice = {
  slice_id: "2026-11-07-0000", focus: "", summary: "", status: "active",
  start: "2026-11-07T00:00:00.000Z", timezone: "UTC", open_loops: [], decisions: [], tags: [],
  related_slices: [], loops: [], turns: [], estimatedTokens: 0,
};

function input(): TurnInput {
  return {
    modelMessages: [
      { role: "user", content: "earlier question" },
      { role: "assistant", content: "earlier public answer" },
      { role: "user", content: "问题" },
    ],
    recentTurns: [], lastUserMessage: "问题", model: "deepseek-flash",
    modelConfig: {
      id: "deepseek-flash", name: "DeepSeek", provider: "deepseek", providerName: "DeepSeek",
      sdk: "deepseek", envKey: "DEEPSEEK_API_KEY", capabilities: { thinking: true, vision: true, maxTokens: 1000 },
      defaultThinking: true, defaultEffort: "high",
    },
    thinking: true, reasoningEffort: "high", clientTimezone: "UTC", locale: "zh",
    config: {
      slicing: { maxSliceMinutes: 30, maxTurnsPerSlice: 1, idleGapMinutes: 15 },
      model: { provider: "deepseek-flash", thinking: true, reasoningEffort: "high" },
    },
    owner: "local", repo: "local", useGithub: false, useDemo: false,
    startedAtIso: "2026-11-07T00:00:00.000Z", turnId: "input", clientMessageId: "message", imageAttachments: [],
    dialogue: { scopeKey: "scope", workId: "work", sourceInputId: "input", transport: "workflow-v2" },
  };
}

describe("native thinking work", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.agentOptions = null;
    h.text = "可以交付的结果";
    h.finishReason = "stop";
    h.extraMessages = [];
    h.finishThinking = null;
    h.housekeeping.mockResolvedValue({
      slice, previouslyContent: "", sliceHeadBlock: "", identityPrompt: "", analysis: null,
      evidenceAttachments: null, previouslyUpdate: null, sliceOnDisk: true,
    });
    h.record.mockResolvedValue("wrun_01JTESTRECORD0000000000000");
  });

  it("uses the complete client history and returns only private dialogue work", async () => {
    const turn = input();
    const result = await turnWorkflow(turn);
    expect(h.stream).toHaveBeenCalledWith(expect.objectContaining({ messages: turn.modelMessages }));
    expect(Object.values(h.agentOptions!.toolsContext)[0]!.dialogueOffer).toBeUndefined();
    expect(result.dialogueWork).toMatchObject({
      workId: "work",
      scopeKey: "scope",
      text: "可以交付的结果",
      product: expect.objectContaining({ version: 1, status: "complete" }),
      producerRunId: "wrun_01JTESTPARENT0000000000000",
      source: expect.objectContaining({ inputId: "input", text: "问题" }),
      sourceTurnId: "input",
      locale: "zh",
      record: expect.objectContaining({ sliceId: slice.slice_id, owner: "local" }),
    });
    expect(result.replyText).toBe("");
    expect(result.cognition).toBe("");
    expect(result.nativeMessages).toBeUndefined();
    expect(h.finalizeTurn).not.toHaveBeenCalled();
    expect(h.beginLegacy).not.toHaveBeenCalled();
    expect(h.completeLegacy).not.toHaveBeenCalled();
    expect(h.record).toHaveBeenCalledWith(expect.objectContaining({ work: result.dialogueWork }));
    expect(h.closeThoughts).toHaveBeenCalledOnce();
  });

  it("returns a server-produced terminal report even without ordinary text", async () => {
    const report = { needsUser: { kind: "missing_information", detail: "需要确认预算上限" } };
    h.text = "";
    h.finishReason = "tool-calls";
    h.finishThinking = { toolCallId: "finish-1", input: report };
    h.extraMessages = [{ role: "assistant", content: [{ type: "tool-call", toolCallId: "finish-1", toolName: "finishThinking", input: report }] }];
    const result = await turnWorkflow(input());
    expect(result.dialogueWork).toMatchObject({ text: "", report });
    expect(result.error).toBeUndefined();
    expect(h.record).toHaveBeenCalledWith(expect.objectContaining({ work: result.dialogueWork }));
  });

  it("records only the user input when no usable work result exists", async () => {
    h.text = "";
    const result = await turnWorkflow(input());
    expect(result.dialogueWork).toBeUndefined();
    expect(result.replyText).toBe("");
    expect(result.error).toContain("without a work result");
    expect(h.record).toHaveBeenCalledWith({
      source: expect.objectContaining({ inputId: "input", text: "问题" }),
      sourceTurnId: "input",
      environment: expect.objectContaining({ sliceId: slice.slice_id }),
    });
    expect(JSON.stringify(h.record.mock.calls[0])).not.toContain("可以交付的结果");
    expect(h.closeTurnStream).toHaveBeenCalledWith(expect.objectContaining({ finishReason: "error" }), "input", undefined);
  });

  it("keeps the user-only failure record when housekeeping fails", async () => {
    h.housekeeping.mockRejectedValue(new Error("context unavailable"));
    await expect(turnWorkflow(input())).rejects.toThrow("context unavailable");
    expect(h.record).toHaveBeenCalledWith(expect.objectContaining({
      source: expect.objectContaining({ inputId: "input", text: "问题" }),
    }));
    expect(h.record.mock.calls[0]![0].utterance).toBeUndefined();
    expect(h.closeThoughts).toHaveBeenCalledOnce();
  });
});
