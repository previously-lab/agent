import { describe, expect, it } from "vitest";
import { WorkflowAgent } from "@ai-sdk/workflow";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { isStepCount, jsonSchema, tool } from "ai";
import type { LanguageModelV3, LanguageModelV3Prompt, LanguageModelV3StreamPart } from "@ai-sdk/provider";

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 1 },
};

describe("WorkflowAgent thinking across tool steps", () => {
  it("sends reasoning_content on the second real compatible-provider HTTP request", async () => {
    const requests: Array<{ messages: Array<{ role: string; reasoning_content?: string }> }> = [];
    const provider = createOpenAICompatible({
      name: "deepseek", baseURL: "https://fixture.invalid/v1", apiKey: "fixture",
      fetch: async (_url, init) => {
        requests.push(JSON.parse(String(init?.body)));
        const first = requests.length === 1;
        const deltas = first ? [
          { role: "assistant", reasoning_content: "inspect the evidence" },
          { tool_calls: [{ index: 0, id: "call1", type: "function", function: { name: "noop", arguments: "{}" } }] },
        ] : [{ role: "assistant", content: "done" }];
        const chunks = deltas.map(delta => ({ id: "fixture", model: "thinking", choices: [{ index: 0, delta, finish_reason: null }] }));
        const finish = { id: "fixture", model: "thinking", choices: [{ index: 0, delta: {}, finish_reason: first ? "tool_calls" : "stop" }] };
        return new Response([...chunks, finish].map(c => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n", {
          headers: { "content-type": "text/event-stream" },
        });
      },
    });
    const agent = new WorkflowAgent({ model: provider("thinking"), tools: {
      noop: tool({ inputSchema: jsonSchema({ type: "object", properties: {} }), execute: async () => ({ ok: true }) }),
    } });
    await agent.stream({ messages: [{ role: "user", content: "inspect" }], stopWhen: isStepCount(3) });
    expect(requests).toHaveLength(2);
    expect(requests[1].messages.find(m => m.role === "assistant")?.reasoning_content).toBe("inspect the evidence");
  });

  it("replays ordered reasoning and its signature into the next real SDK model call", async () => {
    const prompts: LanguageModelV3Prompt[] = [];
    const model: LanguageModelV3 = {
      specificationVersion: "v3",
      provider: "fixture",
      modelId: "thinking",
      supportedUrls: {},
      doGenerate: async () => { throw new Error("streaming fixture only"); },
      async doStream(options) {
        prompts.push(structuredClone(options.prompt));
        const chunks: LanguageModelV3StreamPart[] = prompts.length === 1 ? [
          { type: "stream-start", warnings: [] },
          { type: "reasoning-start", id: "r1" },
          { type: "reasoning-delta", id: "r1", delta: "inspect " },
          { type: "reasoning-delta", id: "r1", delta: "the evidence" },
          { type: "reasoning-end", id: "r1", providerMetadata: { anthropic: { signature: "fixture-signature" } } },
          { type: "tool-call", toolCallId: "t1", toolName: "noop", input: "{}" },
          { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_calls" }, usage },
        ] : [
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "answer" },
          { type: "text-delta", id: "answer", delta: "done" },
          { type: "text-end", id: "answer" },
          { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
        ];
        return { stream: new ReadableStream({ start(controller) {
          for (const chunk of chunks) controller.enqueue(chunk);
          controller.close();
        } }) } as Awaited<ReturnType<LanguageModelV3["doStream"]>>;
      },
    };
    const agent = new WorkflowAgent({ model, tools: {
      noop: tool({ inputSchema: jsonSchema({ type: "object", properties: {} }), execute: async () => ({ ok: true }) }),
    } });
    const result = await agent.stream({ messages: [{ role: "user", content: "inspect" }], stopWhen: isStepCount(3) });
    expect(prompts).toHaveLength(2);
    const assistant = prompts[1].find((message) => message.role === "assistant");
    expect(assistant?.content).toEqual([
      { type: "reasoning", text: "inspect the evidence", providerOptions: { anthropic: { signature: "fixture-signature" } } },
      expect.objectContaining({ type: "tool-call", toolCallId: "t1" }),
    ]);
    expect(result.steps[0].reasoning).toEqual([
      { type: "reasoning", text: "inspect the evidence", providerMetadata: { anthropic: { signature: "fixture-signature" } } },
    ]);
  });
});
