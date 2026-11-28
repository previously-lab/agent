import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelMessage } from "@/lib/deepseek/types";
import { toNativeMessages } from "@/lib/deepseek/messages";
import type { TurnInput } from "@/lib/chat/turn-types";
import type { TimeSlice } from "@/lib/episodic";

const h = vi.hoisted(() => ({
  housekeeping: vi.fn(),
  closeTurnStream: vi.fn(async () => {}),
  finalizeTurn: vi.fn(async () => {}),
  record: vi.fn(),
  closeThoughts: vi.fn(async () => {}),
  closeOffers: vi.fn(async () => {}),
  admission: vi.fn(async () => ({
    holder: { runId: "wrun_ORCHESTRATOR", sessionId: "session" },
    otherWorks: [{ workId: "previous-work", status: "running" }],
  })),
  started: vi.fn(async () => {}),
  ensure: vi.fn(async (_request: unknown) => ({
    runId: "wrun_ORCHESTRATOR", sessionId: "session", reused: false,
    otherWorks: [{ workId: "previous-work", status: "running" }],
  })),
  witness: vi.fn(async () => "delivered" as const),
  beginLegacy: vi.fn(),
  completeLegacy: vi.fn(),
  completeWork: vi.fn(),
  completeEvent: vi.fn(),
  stream: vi.fn(),
  agentOptions: null as null | {
    toolsContext: Record<string, { dialogueOffer?: unknown }>;
    onStepEnd: (step: unknown) => Promise<void>;
    onToolExecutionResult: (result: unknown) => Promise<void>;
  },
  text: "",
  finishReason: "tool-calls",
  finalOffer: true,
  notifiedRunId: "wrun_RESULT_ACTOR" as string | undefined,
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
  closeDialogueOffersStep: h.closeOffers,
  startDialogueRecordRunStep: h.record,
  publishThoughtStartedStep: h.started,
}));
vi.mock("@/app/api/chat/dialogue-orchestrator-steps", () => ({
  ensureDialogueOrchestratorStep: h.ensure,
  readDialogueAdmissionStep: h.admission,
  witnessDialogueDeliveryStep: h.witness,
}));
vi.mock("@/app/api/agent/tool-executors", () => ({
  completeWorkExecute: h.completeWork,
  completeWorkEventExecute: h.completeEvent,
}));
vi.mock("@/app/api/agent/tools", () => ({ buildChatToolsContext: (context: unknown) => ({ context }) }));
vi.mock("@/app/api/agent/agent", () => ({
  createChatAgent: vi.fn(),
  createThinkingAgent: (options: NonNullable<typeof h.agentOptions>) => {
    h.agentOptions = options;
    return {
      stream: async (streamOptions: unknown) => {
        h.stream(streamOptions);
        const toolCalls = [];
        if (h.finalOffer) {
          const input = { result: "Final | verified result", relation: "related", dependsOnInputIds: ["previous-work"] };
          toolCalls.push({ toolCallId: "offer-1", toolName: "completeWork", input });
          await options.onToolExecutionResult({
            toolCallId: "offer-1", toolName: "completeWork",
            output: {
              ok: true, kind: "work-update", updateId: "work:offer-1",
              runId: h.notifiedRunId, sourceInputId: "input",
            },
          });
        }
        if (h.finishThinking) toolCalls.push({
          toolCallId: h.finishThinking.toolCallId, toolName: "finishThinking", input: h.finishThinking.input,
        });
        await options.onStepEnd({
          text: h.text,
          response: { messages: [{ role: "assistant", content: h.text }, ...h.extraMessages] },
          toolCalls,
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

function gate() {
  let open!: () => void;
  const promise = new Promise<void>(resolve => { open = resolve; });
  return { promise, open };
}

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
    h.text = "";
    h.finishReason = "tool-calls";
    h.finalOffer = true;
    h.notifiedRunId = "wrun_RESULT_ACTOR";
    h.finishThinking = {
      toolCallId: "finish-1",
      input: { findings: [{ text: "可以交付的结果", kind: "conversation" }] },
    };
    h.extraMessages = [{ role: "assistant", content: [{
      type: "tool-call", toolCallId: "finish-1", toolName: "finishThinking", input: h.finishThinking.input,
    }] }];
    h.housekeeping.mockResolvedValue({
      slice, previouslyContent: "", sliceHeadBlock: "", identityPrompt: "", analysis: null,
      evidenceAttachments: null, sliceOnDisk: true,
    });
    h.beginLegacy.mockResolvedValue({ inputs: [], pending: [], publications: [], firstRecentUserSeq: 1 });
    h.record.mockResolvedValue("wrun_01JTESTRECORD0000000000000");
    const accepted = (toolCallId: string, _stage: "checkpoint" | "final") => ({
      ok: true, kind: "work-update", updateId: `work:${toolCallId}`,
      runId: "wrun_ORCHESTRATOR", sourceInputId: "input",
    });
    h.completeWork.mockImplementation(async (_input, options) => accepted(options.toolCallId, _input.stage ?? "final"));
    h.completeEvent.mockImplementation(async (_input, options) => accepted(options.toolCallId, _input.stage ?? "final"));
  });

  it.each(["workflow-v2", "legacy"] as const)("sends only the accepted image and its display ordinal to %s thinking", async transport => {
    const turn = input();
    if (transport === "legacy") delete turn.dialogue!.transport;
    const dataBase64 = "AQID";
    const assetId = `img_${"a".repeat(32)}`;
    turn.lastUserMessage = "";
    turn.verifiedImages = [{ snapshot: { version: 1, assetId, ref: `drafts/${assetId}`, ordinal: 3,
      name: "attached.png", mediaType: "image/png" }, dataBase64 }];
    turn.modelMessages = [
      { role: "user", content: [{ type: "image", image: "OLD" }] },
      { role: "user", content: [{ type: "image", image: dataBase64 }] },
    ];
    await turnWorkflow(turn);
    const outbound = h.stream.mock.calls[0]![0] as { messages: ModelMessage[] };
    const wire = toNativeMessages(outbound.messages);
    expect(wire).toHaveLength(1);
    expect(wire[0].content).toEqual(expect.arrayContaining([
      { type: "image_url", image_url: { url: "data:image/png;base64,AQID" } },
      { type: "text", text: expect.stringContaining("〔图3〕 = attached.png") },
    ]));
    expect(JSON.stringify(wire)).not.toContain("OLD");
    expect(h.agentOptions!.toolsContext.context).toMatchObject({ imageAttachments: ["data:image/png;base64,AQID"] });
  });

  it("gives thinking the previous confirmed public exchange before the current input is interpreted", async () => {
    const turn = input();
    turn.lastUserMessage = "Same again.";
    turn.startedAtIso = "2026-11-07T00:05:00.000Z";
    turn.config.slicing.maxTurnsPerSlice = 32;
    turn.dialogue!.recentExchangeHints = { inputIds: ["earlier"], publicationIds: ["visible"] };
    const currentSlice: TimeSlice = { ...slice, turns: [
      { role: "user", timestamp: slice.start, content: "Noise from upstairs again.", dialogue: { kind: "user_input", inputId: "earlier" } },
      { role: "agent", timestamp: "2026-11-07T00:03:00.000Z", content: "raw row", dialogue: { kind: "public_utterance",
        publicationId: "visible", inputIds: ["earlier"], publicSeq: 1, sourceResults: [],
        blocks: [{ kind: "markdown", blockId: "public", text: "You heard it at the old flat." }] } },
    ] };
    h.housekeeping.mockResolvedValue({ slice: currentSlice, previouslyContent: "", sliceHeadBlock: "", identityPrompt: "",
      analysis: null, evidenceAttachments: null, sliceOnDisk: true });
    await turnWorkflow(turn);
    const outbound = h.stream.mock.calls[0]![0] as { messages: ModelMessage[] };
    const content = outbound.messages.at(-1)!.content as string;
    expect(content).toContain('"recentPublicExchanges":[{"user":"Noise from upstairs again.","assistant":"You heard it at the old flat."}]');
    expect(content).toContain('"task":"Same again."');
    expect(content).not.toContain("earlier public answer");
  });

  it("keeps ordinary thought text empty and publishes a scoped final offer", async () => {
    const turn = input();
    const result = await turnWorkflow(turn);
    const outbound = h.stream.mock.calls[0]![0] as { messages: Array<{ role: string; content: unknown }> };
    expect(outbound.messages.at(-1)?.content).toContain("current_task_contract");
    expect(outbound.messages.at(-1)?.content).toContain("previous-work");
    expect(outbound.messages).toHaveLength(1);
    expect(outbound.messages[0]?.content).not.toContain("earlier question");
    expect(Object.values(h.agentOptions!.toolsContext)[0]!.dialogueOffer).toMatchObject({
      scopeKey: "scope", workId: "work", parentRunId: "wrun_01JTESTPARENT0000000000000",
      holder: { runId: "wrun_ORCHESTRATOR", sessionId: "session" },
    });
    expect(result.dialogueWork).toMatchObject({
      workId: "work",
      scopeKey: "scope",
      text: "",
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
    expect(h.completeWork).not.toHaveBeenCalled();
    expect(h.completeEvent).not.toHaveBeenCalled();
    expect(h.record).toHaveBeenCalledWith(expect.objectContaining({ work: result.dialogueWork }));
    expect(h.closeThoughts).toHaveBeenCalledOnce();
    expect(h.started).toHaveBeenCalledWith(expect.objectContaining({
      parentRunId: "wrun_01JTESTPARENT0000000000000", source: expect.objectContaining({ text: "问题" }),
    }));
    expect(h.ensure).not.toHaveBeenCalled();
    expect(h.witness).not.toHaveBeenCalled();
    expect(result.dialogueDelivery).toBeUndefined();
  });

  it("ends after a durable handoff without a receipt lookup or delivery witness", async () => {
    h.notifiedRunId = undefined;
    const result = await turnWorkflow(input());
    expect(h.ensure).not.toHaveBeenCalled();
    expect(h.witness).not.toHaveBeenCalled();
    expect(result.dialogueDelivery).toBeUndefined();
    expect(result.error).toBeUndefined();
  });

  it("hands a genuine user blocker to the dialogue orchestrator without ordinary text", async () => {
    const report = { needsUser: { kind: "missing_information", detail: "需要确认预算上限" } };
    h.finalOffer = false;
    h.finishThinking = { toolCallId: "finish-1", input: report };
    h.extraMessages = [{ role: "assistant", content: [{ type: "tool-call", toolCallId: "finish-1", toolName: "finishThinking", input: report }] }];
    const result = await turnWorkflow(input());
    expect(result.dialogueWork).toMatchObject({ text: "", report });
    expect(result.error).toBeUndefined();
    expect(h.completeEvent).toHaveBeenCalledWith(
      { event: { kind: "needs_user", needsUser: report.needsUser } },
      expect.objectContaining({ toolCallId: "host-needs-user" }),
    );
    expect(h.record).toHaveBeenCalledWith(expect.objectContaining({ work: result.dialogueWork }));
  });

  it.each([true, false])("accepts an empty terminal report only after a real handoff (accepted=%s)", async accepted => {
    h.finalOffer = accepted;
    h.finishThinking = { toolCallId: "finish-1", input: { findings: [] } };
    h.extraMessages = [{ role: "assistant", content: [{
      type: "tool-call", toolCallId: "finish-1", toolName: "finishThinking", input: { findings: [] },
    }] }];
    const result = await turnWorkflow(input());
    if (accepted) {
      expect(result.dialogueWork?.text).toBe("Final | verified result");
      expect(result.dialogueDelivery).toBeUndefined();
      expect(h.witness).not.toHaveBeenCalled();
      expect(result.error).toBeUndefined();
      expect(h.record).toHaveBeenCalledWith(expect.objectContaining({ work: result.dialogueWork }));
    } else {
      expect(result.dialogueWork).toBeUndefined();
      expect(result.error).toContain("without a work result");
    }
  });

  it("records only the user input when no final offer or usable work result exists", async () => {
    h.finalOffer = false;
    h.finishThinking = null;
    h.extraMessages = [];
    h.finishReason = "stop";
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

  it("starts admission and the thought event while document reads are still pending", async () => {
    const reading = gate();
    const notified = gate();
    h.housekeeping.mockImplementationOnce(async () => {
      await reading.promise;
      return { slice, previouslyContent: "", sliceHeadBlock: "", identityPrompt: "", sliceOnDisk: true };
    });
    h.started.mockImplementationOnce(async () => { notified.open(); });
    const work = turnWorkflow(input());
    try {
      await notified.promise;
      expect(h.housekeeping).toHaveBeenCalledOnce();
      expect(h.admission).toHaveBeenCalledWith("scope", "input");
      expect(h.stream).not.toHaveBeenCalled();
    } finally {
      reading.open();
    }
    await work;
    expect(h.stream).toHaveBeenCalledOnce();
  });

  it("closes a failed startup after the thought event lands, independently of admission", async () => {
    const starting = gate();
    const releaseStart = gate();
    const releaseAdmission = gate();
    h.admission.mockImplementationOnce(async () => {
      await releaseAdmission.promise;
      return { holder: { runId: "actor", sessionId: "session" }, otherWorks: [] };
    });
    h.started.mockImplementationOnce(async () => {
      starting.open();
      await releaseStart.promise;
    });
    h.housekeeping.mockRejectedValueOnce(new Error("context unavailable"));
    const failure = expect(turnWorkflow(input())).rejects.toThrow("context unavailable");
    try {
      await starting.promise;
      expect(h.closeOffers).not.toHaveBeenCalled();
      expect(h.closeTurnStream).not.toHaveBeenCalled();
      releaseStart.open();
      await failure;
      expect(h.closeOffers).toHaveBeenCalledOnce();
      expect(h.closeTurnStream).toHaveBeenCalledOnce();
      expect(h.stream).not.toHaveBeenCalled();
    } finally {
      releaseStart.open();
      releaseAdmission.open();
    }
    expect(h.record).toHaveBeenCalledWith(expect.objectContaining({
      source: expect.objectContaining({ inputId: "input", text: "问题" }),
    }));
    expect(h.record.mock.calls[0]![0].utterance).toBeUndefined();
    expect(h.closeThoughts).toHaveBeenCalledOnce();
  });
});
