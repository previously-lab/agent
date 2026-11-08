import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelMessage } from "@/lib/deepseek/types";
import type { TurnInput } from "@/lib/chat/turn-types";
import type { TimeSlice } from "@/lib/episodic";

const h = vi.hoisted(() => ({
  housekeeping: vi.fn(),
  closeTurnStream: vi.fn(async () => {}),
  finalizeTurn: vi.fn(async () => {}),
  offer: vi.fn(),
  eventOffer: vi.fn(),
  publish: vi.fn(),
  reconcile: vi.fn(),
  record: vi.fn(),
  closeOffers: vi.fn(async () => {}),
  closeThoughts: vi.fn(async () => {}),
  beginLegacy: vi.fn(),
  completeLegacy: vi.fn(),
  text: "可以交付的结果",
  offerInModel: false,
  checkpointInModel: false,
  readResults: [] as Array<{ toolCallId: string; toolName: string; output?: unknown; error?: unknown }>,
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
  closeDialogueOffersStep: h.closeOffers,
  closeDialogueThoughtsStep: h.closeThoughts,
  publishDialogueOfferControlsStep: h.publish,
  reconcileDialogueOffersStep: h.reconcile,
  startDialogueRecordRunStep: h.record,
}));
vi.mock("@/app/api/agent/tool-executors", () => ({ offerReplyExecute: h.offer, offerDialogueEventExecute: h.eventOffer }));
vi.mock("@/app/api/agent/tools", () => ({ buildChatToolsContext: (context: unknown) => ({ context }) }));
vi.mock("@/app/api/agent/agent", () => ({
  createChatAgent: vi.fn(),
  createThinkingAgent: (options: {
    onStepEnd: (step: unknown) => Promise<void>;
    onToolExecutionResult: (result: unknown) => Promise<void>;
  }) => ({
    stream: async () => {
      const offer = {
        ok: true, kind: "dialogue-offer", offerId: "work:call",
        runId: "wrun_01JTESTCHILD00000000000000", sourceInputId: "input",
        ...(h.checkpointInModel ? { stage: "checkpoint", publicSeq: 1 } : {}),
      };
      const results = [
        ...h.readResults,
        ...(h.offerInModel ? [{ toolCallId: "call", toolName: "offerReply", output: offer }] : []),
      ];
      for (const result of results) await options.onToolExecutionResult(result);
      await options.onStepEnd({
        text: h.text,
        response: { messages: [{ role: "assistant", content: h.text }, ...h.extraMessages] },
        toolCalls: [
          ...(h.finishThinking
            ? [{ toolCallId: h.finishThinking.toolCallId, toolName: "finishThinking", input: h.finishThinking.input }]
            : []),
        ],
        toolResults: results,
      });
      return {
        messages: [{ role: "system", content: "" }, { role: "user", content: "question" }, { role: "assistant", content: h.text }],
        finishReason: "stop", steps: [],
      };
    },
  }),
}));
vi.mock("@/app/api/chat/inner-turn-workflow", () => ({ innerTurnWorkflow: vi.fn() }));
vi.mock("@/lib/capabilities", () => ({ DEPLOY_GUIDE_URL: "https://example.test" }));

import { turnWorkflow } from "@/app/api/chat/turn-workflow";
import {
  DIALOGUE_HOST_NEEDS_USER_TOOL_CALL_ID,
  DIALOGUE_HOST_READ_CHECKPOINT_TOOL_CALL_ID,
  DIALOGUE_HOST_STRUCTURED_REPORT_TOOL_CALL_ID,
} from "@/lib/dialogue/transport";
import {
  createThinkingReadReceipt,
  wrapThinkingRead,
  type ThinkingRead,
} from "@/lib/agents/thinking-read-receipt";

const slice: TimeSlice = {
  slice_id: "2026-11-07-0000", focus: "", summary: "", status: "active",
  start: "2026-11-07T00:00:00.000Z", timezone: "UTC", open_loops: [], decisions: [], tags: [],
  related_slices: [], loops: [], turns: [], estimatedTokens: 0,
};

function input(): TurnInput {
  return {
    modelMessages: [], recentTurns: [], lastUserMessage: "问题", model: "deepseek-flash",
    modelConfig: {
      id: "deepseek-flash", name: "DeepSeek", provider: "deepseek", providerName: "DeepSeek",
      sdk: "deepseek", envKey: "DEEPSEEK_API_KEY", capabilities: { thinking: true, vision: true, maxTokens: 1000 },
      defaultThinking: true, defaultEffort: "high",
    },
    thinking: true, reasoningEffort: "high", clientTimezone: "UTC", locale: "zh",
    config: {
      slicing: { maxSliceMinutes: 30, maxTurnsPerSlice: 40, idleGapMinutes: 15 },
      model: { provider: "deepseek-flash", thinking: true, reasoningEffort: "high" },
    },
    owner: "local", repo: "local", useGithub: false, useDemo: false,
    startedAtIso: "2026-11-07T00:00:00.000Z", turnId: "input", clientMessageId: "message", imageAttachments: [],
    dialogue: { scopeKey: "scope", workId: "work", sourceInputId: "input", transport: "workflow-v2" },
  };
}

const startedOffer = {
  ok: true, kind: "dialogue-offer", offerId: "work:fallback",
  runId: "wrun_01JTESTCHILD00000000000000", sourceInputId: "input",
};

describe("native thinking parent offer tail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.text = "可以交付的结果";
    h.offerInModel = false;
    h.checkpointInModel = false;
    h.readResults = [];
    h.extraMessages = [];
    h.finishThinking = null;
    h.eventOffer.mockResolvedValue({
      ok: true, kind: "dialogue-offer", offerId: "work:host-read-checkpoint",
      runId: "wrun_01JTESTCHILD00000000000000", sourceInputId: "input",
      stage: "checkpoint", publicSeq: 1, eventKind: "read_completed",
    });
    h.housekeeping.mockResolvedValue({
      slice, previouslyContent: "", sliceHeadBlock: "", identityPrompt: "", analysis: null,
      evidenceAttachments: null, previouslyUpdate: null, sliceOnDisk: true,
    });
    h.offer.mockResolvedValue(startedOffer);
    h.publish.mockResolvedValue(1);
    h.reconcile.mockResolvedValue([]);
    h.record.mockResolvedValue("wrun_01JTESTRECORD0000000000000");
  });

  it("uses the stable server fallback for forgotten offerReply", async () => {
    const result = await turnWorkflow(input());
    expect(h.offer).toHaveBeenCalledWith({ text: "可以交付的结果" }, expect.objectContaining({ toolCallId: "fallback" }));
    expect(h.publish).toHaveBeenCalledWith([startedOffer]);
    expect(h.record).not.toHaveBeenCalled();
    expect(h.finalizeTurn).not.toHaveBeenCalled();
    expect(h.beginLegacy).not.toHaveBeenCalled();
    expect(h.completeLegacy).not.toHaveBeenCalled();
    expect(result.replyText).toBe("");
  });

  it("publishes a model offer once and suppresses fallback", async () => {
    h.offerInModel = true;
    h.reconcile.mockResolvedValue([{ type: "offer", offerId: "work:call", runId: startedOffer.runId, sourceInputId: "input" }]);
    await turnWorkflow(input());
    expect(h.publish).toHaveBeenCalledOnce();
    expect(h.offer).not.toHaveBeenCalled();
    expect(h.record).not.toHaveBeenCalled();
  });

  it("still delivers the final fallback when the model only handed off a checkpoint", async () => {
    h.offerInModel = true;
    h.checkpointInModel = true;
    h.reconcile.mockResolvedValue([{ type: "offer", offerId: "work:call", runId: startedOffer.runId,
      sourceInputId: "input", stage: "checkpoint", publicSeq: 1 }]);
    await turnWorkflow(input());
    expect(h.publish).toHaveBeenNthCalledWith(1, [expect.objectContaining({ stage: "checkpoint" })]);
    expect(h.offer).toHaveBeenCalledWith({ text: h.text }, expect.objectContaining({ toolCallId: "fallback" }));
    expect(h.publish).toHaveBeenNthCalledWith(2, [startedOffer]);
  });

  it("recovers an uncertain model-offer control write without another dialogue", async () => {
    h.offerInModel = true;
    h.publish.mockRejectedValueOnce(new Error("ack lost"));
    h.reconcile.mockResolvedValue([{ type: "offer", offerId: "work:call", runId: startedOffer.runId, sourceInputId: "input" }]);
    await turnWorkflow(input());
    expect(h.offer).not.toHaveBeenCalled();
    expect(h.record).not.toHaveBeenCalled();
  });

  it("falls back when a model-offer control write never landed", async () => {
    h.offerInModel = true;
    h.publish.mockRejectedValueOnce(new Error("not written")).mockResolvedValueOnce(1);
    h.reconcile.mockResolvedValue([]);
    await turnWorkflow(input());
    expect(h.offer).toHaveBeenCalledWith({ text: "可以交付的结果" }, expect.objectContaining({ toolCallId: "fallback" }));
    expect(h.publish).toHaveBeenCalledTimes(2);
  });
  it("preserves only the accepted user draft when no result can be offered", async () => {
    h.text = "";
    const result = await turnWorkflow(input());
    expect(h.offer).not.toHaveBeenCalled();
    expect(h.record).toHaveBeenCalledWith(expect.objectContaining({
      source: expect.objectContaining({ inputId: "input", text: "问题" }),
    }));
    expect(result.replyText).toBe("");
    expect(result.error).toContain("without a reply");
    expect(h.closeTurnStream).toHaveBeenCalledWith(expect.objectContaining({ finishReason: "error" }), "input", undefined);
  });
});


// ─── Native semantic event wiring (host read checkpoints + typed finals) ──
// The thinking agent's read receipts and finishThinking reports are built with
// the REAL receipt makers: the workflow's eligibility check runs unmocked.

const asOf = "2026-11-06T00:00:00.000Z";
const docRead = (ref = "research/audio"): Omit<ThinkingRead, "evidenceId"> => ({
  ref, sourceKind: "semantic_document", edition: "current", revision: "bytes-v1", asOf, coverage: "full",
});
const turnRead = (): Omit<ThinkingRead, "evidenceId"> => ({
  ref: "records/2026-11-05-1329", sourceKind: "original_turn", edition: "original", revision: "record-v1",
  asOf, coverage: "excerpt", turnId: "u42", role: "user", excerpt: "原始记录说静音车厢更安静。",
});
function readExchange(callId: string, toolName: string, output: unknown): ModelMessage[] {
  return [
    { role: "assistant", content: [{ type: "tool-call", toolCallId: callId, toolName, input: { ref: "research/audio" } }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId: callId, toolName,
      output: typeof output === "string" ? { type: "text", value: output } : { type: "json", value: output } }] },
  ];
}
function finishExchange(input: unknown): ModelMessage {
  return { role: "assistant", content: [{ type: "tool-call", toolCallId: "finish-1", toolName: "finishThinking", input }] };
}

describe("native semantic event wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.text = "可以交付的结果";
    h.offerInModel = false;
    h.checkpointInModel = false;
    h.readResults = [];
    h.extraMessages = [];
    h.finishThinking = null;
    h.eventOffer.mockImplementation(async (
      eventInput: { event: { kind: string }; stage: string },
      eventOpts: { toolCallId: string },
    ) => ({
      ok: true, kind: "dialogue-offer", offerId: `work:${eventOpts.toolCallId}`,
      runId: "wrun_01JTESTCHILD00000000000000", sourceInputId: "input",
      stage: eventInput.stage, publicSeq: 1, eventKind: eventInput.event.kind,
    }));
    h.housekeeping.mockResolvedValue({
      slice, previouslyContent: "", sliceHeadBlock: "", identityPrompt: "", analysis: null,
      evidenceAttachments: null, previouslyUpdate: null, sliceOnDisk: true,
    });
    h.offer.mockResolvedValue(startedOffer);
    h.publish.mockResolvedValue(1);
    h.reconcile.mockResolvedValue([]);
    h.record.mockResolvedValue("wrun_01JTESTRECORD0000000000000");
  });

  it("auto-wakes at most one checkpoint offer for the first eligible read and forwards no raw output", async () => {
    const semantic = createThinkingReadReceipt("input", "read-1", [docRead()]);
    const wrappedSemantic = wrapThinkingRead(semantic, "Observed source body that must not leak");
    const original = createThinkingReadReceipt("input", "rec-1", [turnRead()]);
    const scenarioOutput = { answer: "用户当时倾向静音车厢。", thinkingReceipt: original };
    h.text = "";
    h.readResults = [
      { toolCallId: "read-1", toolName: "recallRead", output: wrappedSemantic },
      { toolCallId: "rec-1", toolName: "recallScenario", output: scenarioOutput },
    ];
    h.extraMessages = [
      ...readExchange("read-1", "recallRead", wrappedSemantic),
      ...readExchange("rec-1", "recallScenario", scenarioOutput),
    ];
    const result = await turnWorkflow(input());
    expect(h.eventOffer).toHaveBeenCalledTimes(1);
    const [eventInput, eventOpts] = h.eventOffer.mock.calls[0]!;
    expect(eventInput).toEqual({
      event: { kind: "read_completed", sourceKind: "semantic_document", evidenceCount: 1 },
      stage: "checkpoint",
    });
    expect(eventOpts).toEqual(expect.objectContaining({
      toolCallId: DIALOGUE_HOST_READ_CHECKPOINT_TOOL_CALL_ID,
      context: expect.objectContaining({ dialogueOffer: expect.objectContaining({ workId: "work" }) }),
    }));
    const forwarded = JSON.stringify(eventInput);
    expect(forwarded).not.toContain("research/audio");
    expect(forwarded).not.toContain("Observed source body");
    expect(forwarded).not.toContain("静音车厢");
    expect(h.publish).toHaveBeenCalledWith([expect.objectContaining({
      offerId: "work:host-read-checkpoint", stage: "checkpoint", eventKind: "read_completed",
    })]);
    expect(h.offer).not.toHaveBeenCalled();
    expect(result.replyText).toBe("");
  });

  it("ignores receipt-less and noneligible read results without any event offer", async () => {
    const outlined = createThinkingReadReceipt("input", "read-2", [{ ...docRead(), coverage: "outline" }]);
    h.readResults = [
      { toolCallId: "read-1", toolName: "recallRead", output: "raw observation text with no receipt" },
      { toolCallId: "read-2", toolName: "recallRead", output: wrapThinkingRead(outlined, "skeleton only") },
    ];
    h.extraMessages = [
      ...readExchange("read-1", "recallRead", "raw observation text with no receipt"),
      ...readExchange("read-2", "recallRead", wrapThinkingRead(outlined, "skeleton only")),
    ];
    await turnWorkflow(input());
    expect(h.eventOffer).not.toHaveBeenCalled();
    expect(h.offer).toHaveBeenCalledWith({ text: "可以交付的结果" }, expect.objectContaining({ toolCallId: "fallback" }));
  });

  it("emits a typed final needs_user for a valid finishThinking blocker and skips the prose fallback", async () => {
    const needsUser = { kind: "missing_information", detail: "需要确认预算上限" };
    h.text = "";
    h.finishThinking = { toolCallId: "finish-1", input: { needsUser } };
    h.extraMessages = [finishExchange({ needsUser })];
    h.eventOffer.mockResolvedValue({
      ok: true, kind: "dialogue-offer", offerId: "work:host-needs-user",
      runId: "wrun_01JTESTCHILD00000000000000", sourceInputId: "input",
      stage: "final", publicSeq: 1, eventKind: "needs_user",
    });
    const result = await turnWorkflow(input());
    expect(h.eventOffer).toHaveBeenCalledTimes(1);
    expect(h.eventOffer).toHaveBeenCalledWith(
      { event: { kind: "needs_user", needsUser }, stage: "final" },
      expect.objectContaining({ toolCallId: DIALOGUE_HOST_NEEDS_USER_TOOL_CALL_ID }),
    );
    expect(h.offer).not.toHaveBeenCalled();
    expect(h.record).not.toHaveBeenCalled();
    expect(result.error ?? "").not.toContain("without a reply");
    expect(h.publish).toHaveBeenCalledWith([expect.objectContaining({ stage: "final", eventKind: "needs_user" })]);
  });

  it("emits a typed findings final for an evidence-admitted finishThinking report without raw fields", async () => {
    const receipt = createThinkingReadReceipt("input", "read-1", [docRead()]);
    const wrapped = wrapThinkingRead(receipt, "Observed source body");
    const report = {
      findings: [{ text: "对比结论：A 方案更省。", kind: "observation", evidenceIds: ["read-1:1"], uncertainty: "样本只有两周" }],
    };
    h.text = "";
    h.readResults = [{ toolCallId: "read-1", toolName: "recallRead", output: wrapped }];
    h.finishThinking = { toolCallId: "finish-1", input: report };
    h.extraMessages = [...readExchange("read-1", "recallRead", wrapped), finishExchange(report)];
    h.eventOffer
      .mockResolvedValueOnce({
        ok: true, kind: "dialogue-offer", offerId: "work:host-read-checkpoint",
        runId: "wrun_01JTESTCHILD00000000000000", sourceInputId: "input",
        stage: "checkpoint", publicSeq: 1, eventKind: "read_completed",
      })
      .mockResolvedValueOnce({
        ok: true, kind: "dialogue-offer", offerId: "work:host-structured-report",
        runId: "wrun_01JTESTCHILD00000000000000", sourceInputId: "input",
        stage: "final", publicSeq: 2, eventKind: "findings",
      });
    const result = await turnWorkflow(input());
    // The eligible read auto-wakes one checkpoint; the admitted report is the typed final.
    expect(h.eventOffer).toHaveBeenCalledTimes(2);
    expect(h.eventOffer).toHaveBeenNthCalledWith(1,
      { event: { kind: "read_completed", sourceKind: "semantic_document", evidenceCount: 1 }, stage: "checkpoint" },
      expect.objectContaining({ toolCallId: DIALOGUE_HOST_READ_CHECKPOINT_TOOL_CALL_ID }));
    expect(h.eventOffer).toHaveBeenNthCalledWith(2,
      { event: { kind: "findings", findings: [{ text: "对比结论：A 方案更省。", kind: "observation", uncertainty: "样本只有两周" }] }, stage: "final" },
      expect.objectContaining({ toolCallId: DIALOGUE_HOST_STRUCTURED_REPORT_TOOL_CALL_ID }),
    );
    expect(h.offer).not.toHaveBeenCalled();
    expect(h.record).not.toHaveBeenCalled();
    expect(result.error ?? "").not.toContain("without a reply");
    const forwarded = JSON.stringify(h.eventOffer.mock.calls[1]![0]);
    expect(forwarded).not.toContain("openQuestions");
    expect(forwarded).not.toContain("nextAction");
    expect(forwarded).not.toContain("memoryDelta");
    expect(forwarded).not.toContain("evidenceIds");
    expect(forwarded).not.toContain("research/audio");
    expect(h.publish).toHaveBeenCalledWith([expect.objectContaining({ stage: "final", eventKind: "findings" })]);
  });

  it("emits only the host safe status when a nonempty report has no admitted findings", async () => {
    const uncheckedText = "未经检查的思考正文不能交付";
    const report = { findings: [{ text: "未经证实的项目事实", kind: "project_fact" }] };
    h.text = uncheckedText;
    h.finishThinking = { toolCallId: "finish-1", input: report };
    h.extraMessages = [finishExchange(report)];
    const result = await turnWorkflow(input());
    expect(h.eventOffer).toHaveBeenCalledOnce();
    expect(h.eventOffer).toHaveBeenCalledWith(
      { event: { kind: "findings", findings: [{ text: "相关依据还没核实。", kind: "status" }] }, stage: "final" },
      expect.objectContaining({ toolCallId: DIALOGUE_HOST_STRUCTURED_REPORT_TOOL_CALL_ID }),
    );
    // The server step still reads model history for sequencing. The semantic
    // event is the data handed to dialogue; history is not part of that event.
    expect(JSON.stringify(h.eventOffer.mock.calls[0]![0])).not.toContain(uncheckedText);
    expect(h.offer).not.toHaveBeenCalled();
    expect(h.record).not.toHaveBeenCalled();
    expect(result.error ?? "").not.toContain("without a reply");
  });

  it("does not invent a generic event for an empty finishThinking report with no prose", async () => {
    h.text = "";
    h.finishThinking = { toolCallId: "finish-1", input: { findings: [] } };
    h.extraMessages = [finishExchange({ findings: [] })];
    const result = await turnWorkflow(input());
    expect(h.eventOffer).not.toHaveBeenCalled();
    expect(h.offer).not.toHaveBeenCalled();
    expect(h.record).toHaveBeenCalled();
    expect(result.error).toContain("without a reply");
  });
});
