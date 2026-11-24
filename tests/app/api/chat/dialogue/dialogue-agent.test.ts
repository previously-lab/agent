import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkUpdateEvent } from "@/lib/dialogue/work-contract";

const h = vi.hoisted(() => ({ call: vi.fn(), publish: vi.fn(), wake: vi.fn(), snapshot: vi.fn() }));
vi.mock("@/lib/deepseek/steps", () => ({
  callModelStep: h.call,
  writeAgentEventStep: vi.fn(),
  closeAgentStreamStep: vi.fn(),
}));
vi.mock("@/app/api/chat/dialogue-transport-steps", () => ({
  publishWorkUpdateStep: h.publish, reconcileDialogueOffersStep: vi.fn(),
}));
vi.mock("@/app/api/chat/dialogue-orchestrator-steps", () => ({
  ensureDialogueOrchestratorStep: h.wake, readWorkSnapshotStep: h.snapshot,
}));

import { createDialogueAgent, createThinkingAgent } from "@/app/api/agent/agent";
import { buildChatToolsContext, getChatTools } from "@/app/api/agent/tools";
import { isStepCount, serializeTools } from "@/lib/deepseek/tools";

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
  h.publish.mockReset();
  h.wake.mockReset().mockResolvedValue({ runId: "actor" });
  h.snapshot.mockReset();
});

describe("dialogue DeepSeek profile", () => {
  it("asks for the missing fact in an archive lookup and still accepts earlier calls", () => {
    const tools = getChatTools();
    const lookups = [
      ["recallList", { path: "things" }],
      ["recallFind", { name: "stage lamp" }],
      ["recallSearch", { query: ["stage lamp"] }],
    ] as const;
    for (const [name, input] of lookups) {
      const definition = tools[name];
      const parameters = serializeTools({ [name]: definition })![0].function.parameters;
      expect(parameters.required).toContain("missingFact");
      const legacy = definition.inputSchema.parse(input);
      expect(definition.inputSchema.parse({ ...input, missingFact: "Which filter was ordered?" })).toEqual(legacy);
      expect(legacy).not.toHaveProperty("missingFact");
    }
    expect(tools.recallFind.inputSchema.safeParse({ missingFact: "Which filter?" }).success).toBe(false);
  });

  it.each([false, true])("uses non-thinking wording and expects a final reply with direct=%s", async (direct) => {
    const result = await createDialogueAgent(false, direct).stream({ prompt: "fixture" });
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
    expect(system).toContain("sourceInput.text");
    expect(system).toContain("A greeting, thanks or personal observation can be a whole exchange");
    expect(system).toContain("Keep attribution, corrections and uncertainty intact");
    expect(system).toContain("alreadySaid contains previous publications");
    expect(system).toContain("ask the specific question that unblocks the work");
    expect(system).toContain("receive it and leave the next turn to them");
    expect(system).not.toContain("return empty text");
    expect(system).not.toContain("Keep ordinary replies to one or two short sentences");
  });

  it("gives the checkpoint wording model no tools, even for an opening that is only a plan", async () => {
    await createDialogueAgent(true).stream({ prompt: "Opening | Plan: check the forecast." });
    const request = h.call.mock.calls[0]![0] as CapturedRequest;
    expect(request.tools).toBeUndefined();
    expect(request.messages[0]?.content).toContain("Give the part of the original question this handoff already answers");
    expect(request.messages[0]?.content).toContain("a finding already published, return empty text");
  });

  it("matches each input to a response mode instead of expanding all available context", async () => {
    await createDialogueAgent().stream({ prompt: "fixture" });
    const publicSystem = (h.call.mock.calls[0]![0] as CapturedRequest).messages[0]?.content;
    expect(publicSystem).toContain("Follow currentTaskContract.modeGuidance");
    expect(publicSystem).not.toMatch(/^(chat|focused|research|rewrite):/m);

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
    expect(thought).toContain("Use the conversation to resolve who or what the user means");
    expect(thought).toContain("a particular fact absent from the exchange");
    expect(thought).toContain("another plausible occasion would give a different answer");

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
    expect(system).toContain("Work on what the user brings up in the current input");
    expect(system).toContain("The dialogue role writes the public reply");
    expect(system).toContain("If the conversation already answers the question, no snapshot or search is needed");
    expect(system).toContain("alongside the next independent lookup in the same tool step");
    expect(system).toContain("If the whole answer is ready, go straight to completion");
    expect(system).toContain("call completeWork exactly once");
    expect(system).toContain("Describe a link only in the direction the source shows");
    expect(system).toContain("Confine a missing-record claim to the material actually checked");
    expect(system).toContain("every complete native HTML artifact");
    expect(system).toContain("separate later step");
    expect(system).toContain("finishThinking alone with needsUser");
    expect(system).not.toContain("offerReply");

    expect(request.tools?.map(entry => entry.function.name)).toEqual(expect.arrayContaining([
      "workCheckpoint", "completeWork", "readWorkSnapshot", "finishThinking",
    ]));
    expect(request.tools?.some(entry => entry.function.name === "offerReply")).toBe(false);
    expect(request.tools?.find(entry => entry.function.name === "workCheckpoint")?.function.description)
      .toContain("new, supported partial answer to this input while work continues");
    expect(request.tools?.find(entry => entry.function.name === "completeWork")?.function.description)
      .toContain("The dialogue Actor owns integration and public expression");
    expect(request.tools?.find(entry => entry.function.name === "finishThinking")?.function.description)
      .toContain("An empty report is sufficient otherwise");
  });

  it("wakes public wording with the supported part while an independent lookup is still pending", async () => {
    const task = "When is the workshop, and did the venue change?";
    const partial = "The agenda confirms the workshop starts at 10 am.";
    const source = { inputId: "input", clientMessageId: "message", userSeq: 1, eventSeq: 1,
      acceptedAt: "2026-11-21T09:00:00Z", text: task };
    const ctx = buildChatToolsContext({
      repo: "local", owner: "local", useGithub: false, useDemo: false, sliceId: "slice", turnId: "input",
      readScopeId: "work", currentUserText: task, recentTurns: [],
      dialogueOffer: { scopeKey: "scope", parentRunId: "thought", workId: "work", sourceInputId: "input",
        sourceTurnId: "input", source, priorContext: [], locale: "en",
        record: { repo: "local", owner: "local", useGithub: false, useDemo: false, timezone: "UTC",
          slicing: { idleGapMinutes: 30, maxSliceMinutes: 60, maxTurnsPerSlice: 40 } } },
    });
    const agendaCall = { id: "agenda", type: "function",
      function: { name: "readWorkSnapshot", arguments: JSON.stringify({ workId: "agenda-work" }) } };
    const toolCalls = [
      { id: "venue", type: "function", function: { name: "readWorkSnapshot", arguments: JSON.stringify({ workId: "venue-work" }) } },
      { id: "time", type: "function", function: { name: "workCheckpoint", arguments: JSON.stringify({ text: partial }) } },
    ];
    h.call.mockResolvedValueOnce({ ...modelResponse, toolCalls: [agendaCall], finishReason: "tool_calls",
      message: { role: "assistant", content: null, tool_calls: [agendaCall] } })
      .mockResolvedValueOnce({ ...modelResponse, toolCalls, finishReason: "tool_calls",
        message: { role: "assistant", content: null, reasoning_content: "PRIVATE_FIXTURE", tool_calls: toolCalls } });
    const lookup = Promise.withResolvers<null>();
    h.snapshot.mockResolvedValueOnce({ status: "completed", publicHandoffs: [{ stage: "completed", text: partial }] })
      .mockReturnValueOnce(lookup.promise);
    const thinking = createThinkingAgent({ model: {} as Parameters<typeof createThinkingAgent>[0]["model"],
      thinking: true, reasoningEffort: "low", toolsContext: ctx }).stream({
      system: "Work agenda-work checked the workshop agenda. Work venue-work is checking the venue.",
      prompt: task, stopWhen: isStepCount(3),
    });
    try {
      await vi.waitFor(() => expect(h.wake).toHaveBeenCalledTimes(1));
      expect(h.call).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(h.call.mock.calls[1]?.[0]?.messages)).toContain(partial);
      expect(h.snapshot).toHaveBeenCalledWith("scope", "venue-work");
      const event = h.publish.mock.calls[0]?.[0] as WorkUpdateEvent;
      expect(event).toMatchObject({ type: "work_checkpoint", sourceInputId: "input", text: partial });
      expect(JSON.stringify(event)).not.toContain("PRIVATE_FIXTURE");
      expect(h.wake).toHaveBeenCalledWith(expect.objectContaining({ candidateKeys: [event.updateId] }));
    } finally {
      lookup.resolve(null);
      await thinking;
    }
    expect(h.call).toHaveBeenCalledTimes(3);
  });

});
