import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DialogueOfferContext } from "@/lib/dialogue/transport";

const h = vi.hoisted(() => ({ start: vi.fn() }));
vi.mock("workflow/api", () => ({ start: h.start, getRun: vi.fn() }));
vi.mock("@/app/api/chat/dialogue-workflow", () => ({ dialogueWorkflow: vi.fn() }));

import { offerReplyExecute, type ToolContext } from "@/app/api/agent/tool-executors";
import { prepareDialogueOfferStep } from "@/app/api/chat/dialogue-transport-steps";
import { DIALOGUE_OFFER_RESULT } from "@/lib/dialogue/transport";

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