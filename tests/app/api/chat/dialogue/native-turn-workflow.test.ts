import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TurnInput } from "@/lib/chat/turn-types";
import type { TimeSlice } from "@/lib/episodic";

const h = vi.hoisted(() => ({
  housekeeping: vi.fn(),
  closeTurnStream: vi.fn(async () => {}),
  finalizeTurn: vi.fn(async () => {}),
  offer: vi.fn(),
  publish: vi.fn(),
  reconcile: vi.fn(),
  record: vi.fn(),
  closeOffers: vi.fn(async () => {}),
  closeThoughts: vi.fn(async () => {}),
  beginLegacy: vi.fn(),
  completeLegacy: vi.fn(),
  text: "可以交付的结果",
  offerInModel: false,
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
vi.mock("@/app/api/agent/tool-executors", () => ({ offerReplyExecute: h.offer }));
vi.mock("@/app/api/agent/tools", () => ({ buildChatToolsContext: (context: unknown) => ({ context }) }));
vi.mock("@/app/api/agent/agent", () => ({
  createChatAgent: vi.fn(),
  createThinkingAgent: (options: { onStepEnd: (step: unknown) => Promise<void> }) => ({
    stream: async () => {
      const offer = {
        ok: true, kind: "dialogue-offer", offerId: "work:call",
        runId: "wrun_01JTESTCHILD00000000000000", sourceInputId: "input",
      };
      await options.onStepEnd({
        text: h.text,
        response: { messages: [{ role: "assistant", content: h.text }] },
        toolCalls: [], toolResults: h.offerInModel ? [{ toolName: "offerReply", output: offer }] : [],
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