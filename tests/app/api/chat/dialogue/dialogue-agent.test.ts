import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock("@/lib/deepseek/steps", () => ({
  callModelStep: h.call,
  writeAgentEventStep: vi.fn(),
  closeAgentStreamStep: vi.fn(),
}));

import { createDialogueAgent, createThinkingAgent } from "@/app/api/agent/agent";

type CapturedRequest = {
  messages: Array<{ role: string; content: string }>;
  tools?: Array<{ function: { name: string; description?: string } }>;
};

const modelResponse = {
  message: { role: "assistant", content: "好的。" },
  toolCalls: [], finishReason: "stop",
  usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, reasoningTokens: 0, cachedInputTokens: 0, uncachedInputTokens: 0 },
};

beforeEach(() => {
  h.call.mockReset();
  h.call.mockResolvedValue(modelResponse);
});

describe("dialogue DeepSeek profile", () => {
  it("uses non-thinking Chat Completions settings only on the public dialogue", async () => {
    const result = await createDialogueAgent().stream({ prompt: "fixture" });
    expect(result.text).toBe("好的。");
    expect(h.call).toHaveBeenCalledWith(expect.objectContaining({
      thinking: false,
      reasoningEffort: "low",
      temperature: 0.2,
      tools: undefined,
    }), undefined);
    const request = h.call.mock.calls[0]![0] as CapturedRequest;
    const system = request.messages.find(message => message.role === "system")?.content;
    expect(system).toContain("sourceInput.text is the original user ask");
    expect(system).toContain("priorCheckpoints and alreadySaid");
    expect(system).toContain("You own how to say it.");
    expect(system).toContain("Do not investigate, fact-check");
    expect(system).toContain("Preserve the event's attribution, corrections, and confidence level.");
    expect(system).toContain("An offer_reply event");
    expect(system).toContain("Do not ask the user a question unless the current event is needs_user");
    expect(system).not.toContain("Keep ordinary replies to one or two short sentences");
  });

  it("gives the checkpoint wording model no tools, even for an opening that is only a plan", async () => {
    await createDialogueAgent(true).stream({ prompt: "Opening | Plan: check the forecast." });
    const request = h.call.mock.calls[0]![0] as CapturedRequest;
    expect(request.tools).toBeUndefined();
    expect(request.messages[0]?.content).toContain("including when it only confirms the task or states a plan");
  });

  it("assembles lifecycle handoffs and separate final steps into the thinking request", async () => {
    type ThinkingOptions = Parameters<typeof createThinkingAgent>[0];
    await createThinkingAgent({
      model: {} as ThinkingOptions["model"],
      thinking: true,
      reasoningEffort: "low",
      toolsContext: {
        currentTime: { dialogueOffer: { workId: "work-1" } },
      } as unknown as ThinkingOptions["toolsContext"],
    }).stream({ prompt: "fixture", system: "BASE PROMPT" });

    const request = h.call.mock.calls[0]![0] as CapturedRequest;
    const system = request.messages.find(message => message.role === "system")?.content;
    expect(system?.startsWith("BASE PROMPT")).toBe(true);
    expect(system).toContain("Leave ordinary assistant message content empty on every step, including the last.");
    expect(system).toContain("FIRST action after receiving every user task");
    expect(system).toContain("SEPARATE tool step before the first investigative tool");
    expect(system).toContain("give your initial take");
    expect(system).toContain("After each search, recall, source read");
    expect(system).toContain("your NEXT tool step MUST be offerReply");
    expect(system).not.toContain("may skip all checkpoints");
    expect(system).toContain("checkpoints of at most 2,400 characters each");
    expect(system).toContain("ONE combined checkpoint as the next tool step");
    expect(system).toContain("every material still-unhanded result or error");
    expect(system).toContain("Wait for the final offer to succeed");
    expect(system).toContain("SEPARATE later tool step");
    expect(system).toContain("Never bundle or run final offerReply and finishThinking in parallel");
    expect(system).toContain("finishThinking alone with needsUser");
    expect(system).toContain("accepted explicit final suppresses the host fallback final");
    expect(system).toContain('offerReply({stage: "checkpoint"');
    expect(system).toContain('offerReply({stage: "final"');
    expect(system).toContain("rather than emitting standalone artifact prose");
    expect(system).not.toContain("Put a native visual's complete original document in final text");

    const offeredTool = request.tools?.find(entry => entry.function.name === "offerReply");
    expect(offeredTool?.function.description).toContain("Checkpoints are limited to 2,400 characters each");
    expect(offeredTool?.function.description).toContain("Opening |");
    expect(offeredTool?.function.description).toContain("After EACH search, recall");
    expect(offeredTool?.function.description).toContain("Progress |");
    expect(offeredTool?.function.description).toContain("carry all remaining unhanded evidence into final");
    expect(offeredTool?.function.description).toContain("never bundled or parallel");
  });
});
