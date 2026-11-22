import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock("@/lib/deepseek/steps", () => ({
  callModelStep: h.call,
  writeAgentEventStep: vi.fn(),
  closeAgentStreamStep: vi.fn(),
}));

import { createDialogueAgent, createThinkingAgent } from "@/app/api/agent/agent";

import { CHARTER_MD } from "@/lib/identity/agent-prompt.generated";
import { buildDirectionBlock } from "@/lib/evolution/direction-agent";

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
      publicWording: true,
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
    expect(system).toContain("A work_update event");
    expect(system).toContain("Do not ask the user a question unless the current event is needs_user");
    expect(system).not.toContain("Keep ordinary replies to one or two short sentences");
  });

  it("gives the checkpoint wording model no tools, even for an opening that is only a plan", async () => {
    await createDialogueAgent(true).stream({ prompt: "Opening | Plan: check the forecast." });
    const request = h.call.mock.calls[0]![0] as CapturedRequest;
    expect(request.tools).toBeUndefined();
    expect(request.messages[0]?.content).toContain("A synthetic opening with empty handoff text may instead return empty text");
  });

  it("matches each input to a response mode instead of expanding all available context", async () => {
    await createDialogueAgent().stream({ prompt: "fixture" });
    const publicSystem = (h.call.mock.calls[0]![0] as CapturedRequest).messages[0]?.content;
    expect(publicSystem).toContain("chat: Give a brief natural social reply");
    expect(publicSystem).toContain("focused: Answer the exact ask directly and only that");
    expect(publicSystem).toContain("rewrite: Transform only the referenced material");

    type ThinkingOptions = Parameters<typeof createThinkingAgent>[0];
    await createThinkingAgent({
      model: {} as ThinkingOptions["model"], thinking: true, reasoningEffort: "low",
      toolsContext: { currentTime: { dialogueOffer: { workId: "work-1" } } } as unknown as ThinkingOptions["toolsContext"],
    }).stream({ prompt: "fixture" });
    const thinkingSystem = h.call.mock.calls[1]![0].messages[0]?.content;
    expect(h.call.mock.calls[1]![0]).not.toHaveProperty("publicWording");
    expect(thinkingSystem).toContain("Choose a responseMode for this request");
    expect(thinkingSystem).toContain("return the requested text or fact in the requested form");
  });

  it("carries gist and quote boundaries through both model requests with an existing user hypothesis", async () => {
    const direction = buildDirectionBlock([
      "# Portrait", "## Communication preferences", "- Prefers short answers — refs: 2026-11-01-1000",
      "# Hypotheses", "- [proposed 2026-11-01-1000] May test exact recall — falsify if: accepts a summary",
    ].join("\n"));
    type Options = Parameters<typeof createThinkingAgent>[0];
    await createThinkingAgent({
      model: {} as Options["model"], thinking: true, reasoningEffort: "low",
      toolsContext: { currentTime: { dialogueOffer: { workId: "memory" } } } as unknown as Options["toolsContext"],
    }).stream({ system: [CHARTER_MD, direction].join("\n\n"), prompt: "我们第一次聊的是什么？" });
    const thought = (h.call.mock.calls[0]![0] as CapturedRequest).messages[0]!.content;
    expect(thought).toContain("give the topic and qualify the order");
    expect(thought).toContain("For exact wording, speaker attribution");
    expect(thought).toContain("May test exact recall");
    expect(thought).toContain("A guess supplies no reason to investigate");
    expect(thought).toContain("a supported account already in context can answer the gist");
    expect(thought).toContain("If a point is missing, search across case documents");
    expect(thought).toContain("A limited search cannot establish that nothing happened later");

    await createDialogueAgent().stream({ prompt: "We have a reliable case account of the topic. Chronology is incomplete." });
    const publicRequest = h.call.mock.calls[1]![0] as CapturedRequest;
    expect(publicRequest.messages[0]!.content).toContain("Preserve qualifications about order or coverage, and quote only verified wording");
    expect(publicRequest.tools).toBeUndefined();
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
    expect(system).toContain("You own ONLY the current input's investigation");
    expect(system).toContain("Never write ordinary assistant content or a public answer");
    expect(system).toContain("If the conversation already answers the question, no snapshot or search is needed");
    expect(system).toContain("Pending work is not a completed fact");
    expect(system).toContain("use workCheckpoint when a substantive update would help the user");
    expect(system).toContain("Simple direct work may skip it");
    expect(system).toContain("A checkpoint is public-safe work state, not a reply draft");
    expect(system).toContain("call completeWork exactly once");
    expect(system).toContain("every complete native HTML artifact");
    expect(system).toContain("SEPARATE later tool step");
    expect(system).toContain("finishThinking alone with needsUser");
    expect(system).not.toContain("offerReply");

    expect(request.tools?.map(entry => entry.function.name)).toEqual(expect.arrayContaining([
      "workCheckpoint", "completeWork", "readWorkSnapshot", "finishThinking",
    ]));
    expect(request.tools?.some(entry => entry.function.name === "offerReply")).toBe(false);
    expect(request.tools?.find(entry => entry.function.name === "workCheckpoint")?.function.description)
      .toContain("not a reply draft");
    expect(request.tools?.find(entry => entry.function.name === "completeWork")?.function.description)
      .toContain("The dialogue Actor owns integration and public expression");
  });
});
