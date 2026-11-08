import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DialogueOfferContext } from "@/lib/dialogue/transport";
import type { ModelMessage } from "@/lib/deepseek/types";

const h = vi.hoisted(() => ({ start: vi.fn() }));
vi.mock("workflow/api", () => ({ start: h.start, getRun: vi.fn() }));
vi.mock("@/app/api/chat/dialogue-workflow", () => ({ dialogueWorkflow: vi.fn() }));

import { offerDialogueEventExecute, offerReplyExecute, type ToolContext } from "@/app/api/agent/tool-executors";
import { prepareDialogueOfferStep } from "@/app/api/chat/dialogue-transport-steps";
import { DIALOGUE_OFFER_RESULT } from "@/lib/dialogue/transport";
import { buildDialoguePrompt } from "@/lib/dialogue/dialogue-prompt";
import { createThinkingReadReceipt, wrapThinkingRead } from "@/lib/agents/thinking-read-receipt";

const context: DialogueOfferContext = {
  parentRunId: "wrun_01JTESTPARENT0000000000000",
  workId: "work-1",
  sourceInputId: "input-1",
  sourceTurnId: "input-1",
  source: {
    inputId: "input-1", clientMessageId: "message-1", userSeq: 1, eventSeq: 1,
    acceptedAt: "2026-11-07T00:00:00.000Z", text: "给我一个计算器",
  },
  priorContext: [{ role: "user", text: "之前的上下文" }],
  locale: "zh",
  record: {
    useGithub: false, useDemo: false, owner: "local", repo: "local", timezone: "Asia/Shanghai",
    slicing: { idleGapMinutes: 30, maxSliceMinutes: 60, maxTurnsPerSlice: 40 },
    sliceId: "2026-11-07-0000",
  },
};

function ctx(): ToolContext {
  return {
    repo: "local", owner: "local", useGithub: false, useDemo: false,
    sliceId: "2026-11-07-0000", turnId: "input-1", readScopeId: "input-1",
    currentUserText: "给我一个计算器", recentTurns: [], dialogueOffer: context,
  };
}

describe("offerReply native handoff", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.start.mockResolvedValue({ runId: "wrun_01JTESTCHILD00000000000000" });
  });

  it("starts one child with stable identity and never waits for its result", async () => {
    const html = "<!doctype html>\n<html><body>Calculator</body></html>\n";
    const text = `可以。\n\n\`\`\`html live\n${html}\`\`\`\n`;
    const result = await offerReplyExecute({ text }, { context: ctx(), toolCallId: "call-1", messages: [] });
    expect(result).toEqual({
      ok: true, kind: DIALOGUE_OFFER_RESULT, offerId: "work-1:call-1",
      runId: "wrun_01JTESTCHILD00000000000000", sourceInputId: "input-1",
    });
    const [, args, options] = h.start.mock.calls[0]!;
    expect(args[0].text).toBe(text);
    expect(args[0].offerId).toBe("work-1:call-1");
    expect(options).toMatchObject({ region: "hkg1", attributes: { role: "dialogue", offer: "work-1:call-1" } });
    expect(h.start).toHaveBeenCalledOnce();
  });

  it("assigns distinct public slots to parallel offers in provider order", async () => {
    const messages = [{ role: "assistant" as const, content: [
      { type: "tool-call" as const, toolCallId: "call-1", toolName: "offerReply", input: { text: "one" } },
      { type: "tool-call" as const, toolCallId: "call-2", toolName: "offerReply", input: { text: "two" } },
    ] }];
    await offerReplyExecute({ text: "two" }, { context: ctx(), toolCallId: "call-2", messages });
    expect(h.start.mock.calls[0]![1][0].publicSeq).toBe(2);
  });
  it("admits a sixth distinct checkpoint, carries all five priors into dialogue context, and preserves dedupe", async () => {
    const texts = ["first finding", "second finding", "third finding", "fourth finding", "fifth finding"];
    const messages: ModelMessage[] = texts.flatMap((text, index) => {
      const toolCallId = `call-${index + 1}`;
      const offerId = `work-1:${toolCallId}`;
      return [
        { role: "assistant" as const, content: [
          { type: "tool-call" as const, toolCallId, toolName: "offerReply", input: { stage: "checkpoint", text } },
        ] },
        { role: "tool" as const, content: [
          { type: "tool-result" as const, toolCallId, toolName: "offerReply", output: { type: "json" as const, value: {
            ok: true, kind: DIALOGUE_OFFER_RESULT, offerId, runId: `wrun_TEST${index + 1}`,
            sourceInputId: "input-1", stage: "checkpoint", publicSeq: index + 1,
          } } },
        ] },
      ];
    });
    const sixth = "sixth distinct finding";
    const result = await offerReplyExecute(
      { stage: "checkpoint", text: sixth },
      { context: ctx(), toolCallId: "call-6", messages },
    );
    expect(result).toMatchObject({ ok: true, offerId: "work-1:call-6" });
    const startedInput = h.start.mock.calls[0]![1][0];
    expect(startedInput.priorCheckpoints.map((entry: { text: string }) => entry.text)).toEqual(texts);
    const prompt = JSON.parse(buildDialoguePrompt(startedInput, [], startedInput.text));
    expect(prompt.priorCheckpoints).toEqual(texts);
    expect(prompt.event).toEqual({ kind: "offer_reply", notes: sixth });

    const duplicate = await offerReplyExecute(
      { stage: "checkpoint", text: sixth },
      { context: ctx(), toolCallId: "call-7", messages: [...messages, { role: "assistant" as const, content: [
        { type: "tool-call" as const, toolCallId: "call-6", toolName: "offerReply", input: { stage: "checkpoint", text: sixth } },
      ] }, { role: "tool" as const, content: [
        { type: "tool-result" as const, toolCallId: "call-6", toolName: "offerReply", output: { type: "json" as const, value: result } },
      ] }] },
    );
    expect(duplicate).toMatchObject({ ok: false, reason: "This checkpoint was already offered." });
    expect(h.start).toHaveBeenCalledOnce();
  });

  it("keeps raw HTML unchanged in typed data and out of the dialogue prompt", async () => {
    const html = "<!doctype html>\n<html><body><button>Calculate</button></body></html>\n";
    const offered = `结果如下。\n\n\`\`\`html live\n${html}\`\`\`\n`;
    const started = await offerReplyExecute({ text: offered }, { context: ctx(), toolCallId: "call-1", messages: [] });
    if (!started.ok) throw new Error("offer failed");
    const input = h.start.mock.calls[0]![1][0];
    const prepared = await prepareDialogueOfferStep(input, "wrun_01JTESTCHILD00000000000000");
    expect(prepared.artifacts).toHaveLength(1);
    expect(prepared.artifacts[0]!.body).toBe(html);
    expect(prepared.artifacts[0]!.artifact.kind).toBe("native_html");
    expect(prepared.prompt).not.toContain("<html>");
    expect(prepared.prompt).not.toContain("<button>");
    expect(prepared.prompt).toContain(prepared.artifacts[0]!.artifact.artifactId);
    expect(prepared.prompt).toContain("结果如下");
    expect(prepared.prompt).toContain("之前的上下文");
  });
});

describe("offerDialogueEventExecute host event handoff", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.start.mockResolvedValue({ runId: "wrun_01JTESTCHILD00000000000000" });
  });

  it("starts the dialogue with empty text, the typed event and a stable work-scoped offer id, without waiting", async () => {
    const event = { kind: "read_completed", sourceKind: "semantic_document", evidenceCount: 2 } as const;
    const result = await offerDialogueEventExecute(
      { event, stage: "checkpoint" },
      { context: ctx(), toolCallId: "host-read-checkpoint", messages: [] },
    );
    expect(result).toEqual({
      ok: true, kind: DIALOGUE_OFFER_RESULT, offerId: "work-1:host-read-checkpoint",
      runId: "wrun_01JTESTCHILD00000000000000", sourceInputId: "input-1",
      stage: "checkpoint", publicSeq: 1, eventKind: "read_completed",
    });
    const [, args, options] = h.start.mock.calls[0]!;
    expect(args[0].text).toBe("");
    expect(args[0].event).toEqual(event);
    expect(args[0].offerId).toBe("work-1:host-read-checkpoint");
    expect(args[0].stage).toBe("checkpoint");
    expect(options).toMatchObject({ region: "hkg1", attributes: { role: "dialogue", offer: "work-1:host-read-checkpoint" } });
    // Admission only: one start, never a completion wait on the child run.
    expect(h.start).toHaveBeenCalledOnce();
  });

  it("does not reserve a public slot for a tool read", async () => {
    const receipt = createThinkingReadReceipt("input-1", "read-1", [{
      ref: "research/audio", sourceKind: "semantic_document", edition: "current", revision: "bytes-v1",
      asOf: "2026-11-06T00:00:00.000Z", coverage: "full",
    }]);
    const messages = [
      { role: "assistant" as const, content: [{ type: "tool-call" as const, toolCallId: "read-1", toolName: "recallRead", input: { ref: "research/audio" } }] },
      { role: "tool" as const, content: [{ type: "tool-result" as const, toolCallId: "read-1", toolName: "recallRead",
        output: { type: "text" as const, value: wrapThinkingRead(receipt, "Observed source") } }] },
    ];
    const offer = await offerReplyExecute({ stage: "checkpoint", text: "First public offer" },
      { context: ctx(), toolCallId: "call-2", messages });
    expect(offer).toMatchObject({ ok: true, stage: "checkpoint", publicSeq: 1 });
  });

});
