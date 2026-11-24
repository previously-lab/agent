import { describe, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({ options: undefined as any }));
vi.mock("@/lib/deepseek/workflow-agent", () => ({
  DeepSeekAgent: class {
    constructor(options: unknown) { captured.options = options; }
  },
}));

import { createChatAgent, createThinkingAgent } from "@/app/api/agent/agent";
import { runAgent, zeroUsage, type ModelCaller } from "@/lib/deepseek/runner";
import { isStepCount, tool } from "@/lib/deepseek/tools";
import type { AgentOptions, ModelMessage, ModelRequest, ModelResponse } from "@/lib/deepseek/types";
import { FIXED_MODEL } from "@/lib/models/registry";
import { z } from "zod";
import { collectThinkingReads, createThinkingReadReceipt, renderVerifiedSearchPassages, wrapThinkingRead } from "@/lib/agents/thinking-read-receipt";

function requestTool(name: string, input: unknown, id = "tool-call"): ModelResponse {
  const call = { id, type: "function" as const, function: { name, arguments: JSON.stringify(input) } };
  return { message: { role: "assistant", content: null, tool_calls: [call] }, toolCalls: [call],
    finishReason: "tool_calls", usage: zeroUsage() };
}

function thinkingOptions() {
  createThinkingAgent({
    model: FIXED_MODEL, thinking: true, reasoningEffort: "high",
    toolsContext: {
      recallRead: { readScopeId: "current-input", dialogueOffer: { sourceInputId: "current-input", workId: "current-work" } },
    } as unknown as Parameters<typeof createThinkingAgent>[0]["toolsContext"],
  });
  return captured.options as AgentOptions;
}

const done: ModelResponse = { message: { role: "assistant", content: "done" }, toolCalls: [],
  finishReason: "stop", usage: zeroUsage() };

function replayedResult(name: string, input: unknown, output: unknown): ModelMessage[] {
  return [
    { role: "assistant", content: [{ type: "tool-call", toolCallId: "tool-call", toolName: name, input }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId: "tool-call", toolName: name, output: { type: "json", value: output } }] },
  ];
}

describe("createChatAgent per-round record mediation", () => {
  it("removes a legacy raw tool result before the next actual ModelCaller request", async () => {
    const sentinel = "DURABLE_RAW_RECORD_SENTINEL_NEVER_SEND";
    createChatAgent({
      model: FIXED_MODEL,
      thinking: true,
      reasoningEffort: "high",
      toolsContext: {} as any,
    });
    const options = captured.options as AgentOptions;
    expect(options.prepareStep).toBeDefined();

    const requests: string[] = [];
    const caller: ModelCaller = async (request) => {
      requests.push(JSON.stringify(request.messages));
      if (requests.length === 1) {
        const call = {
          id: "legacy-record-read",
          type: "function" as const,
          function: { name: "recallRead", arguments: JSON.stringify({ ref: "records/2026-10-20-0930" }) },
        };
        return {
          message: { role: "assistant", content: null, tool_calls: [call] },
          toolCalls: [call],
          finishReason: "tool_calls",
          usage: zeroUsage(),
        } satisfies ModelResponse;
      }
      return {
        message: { role: "assistant", content: "done" },
        toolCalls: [],
        finishReason: "stop",
        usage: zeroUsage(),
      } satisfies ModelResponse;
    };

    const result = await runAgent({
      ...options,
      tools: {
        recallRead: tool({
          description: "Simulated legacy durable read",
          inputSchema: z.object({ ref: z.string() }).strict(),
          execute: async () => sentinel,
        }),
      },
      stopWhen: isStepCount(2),
    }, caller);

    expect(result.toolResults[0]?.output).toBe(sentinel);
    expect(requests).toHaveLength(2);
    expect(requests[0]).not.toContain(sentinel);
    expect(requests[1]).not.toContain(sentinel);
    expect(requests[1]).toContain("recallScenario_required");
    expect(requests[1]).toContain("records/2026-10-20-0930");
  });
});

describe("current-work native tool results", () => {
  it.each(["PUBLIC_CONTENT", "Nothing named this record exists in memory"])("retains the executed direct core result %s across a continuation, without trusting replay", async output => {
    const options = thinkingOptions();
    const input = { ref: "records/2026-10-20-0930", direct: true };
    const publicOutput = { kind: "public_record_v1", ref: input.ref, scopeId: "current-input", toolCallId: "tool-call", text: output };
    const replay = replayedResult("recallRead", input, { ...publicOutput, text: "OLD_PRIVATE_OUTPUT" });
    const tools = { recallRead: tool({ description: "Fixture core reader",
      inputSchema: z.object({ ref: z.string(), direct: z.boolean() }), execute: () => publicOutput }) };
    const first = await runAgent({ ...options, tools, messages: replay }, async request => {
      expect(JSON.stringify(request.messages)).not.toContain("OLD_PRIVATE_OUTPUT");
      return requestTool("recallRead", input);
    });
    const history = [...replay, ...first.steps[0]!.response.messages, { role: "user" as const, content: "continue" }];
    await runAgent({ ...options, tools, messages: history }, async request => {
      expect(JSON.stringify(request.messages)).not.toContain("OLD_PRIVATE_OUTPUT");
      expect(request.messages.filter(m => m.role === "tool").at(-1)?.content).toBe(JSON.stringify(publicOutput));
      return done;
    });
    await runAgent({ ...thinkingOptions(), tools, messages: history }, async request => {
      expect(JSON.stringify(request.messages)).not.toContain(output);
      return done;
    });
  });

  it("mediates a legacy executor's raw direct result even when replayed as a real completed step", async () => {
    const options = thinkingOptions();
    const input = { ref: "records/2026-10-20-0930", direct: true };
    const tools = { recallRead: tool({ description: "Old durable executor", inputSchema: z.object({ ref: z.string(), direct: z.boolean() }),
      execute: () => "OLD_UNFILTERED_CORE" }) };
    let count = 0;
    await runAgent({ ...options, tools, stopWhen: isStepCount(2) }, async request => {
      if (++count === 1) return requestTool("recallRead", input);
      expect(JSON.stringify(request.messages)).not.toContain("OLD_UNFILTERED_CORE");
      expect(request.messages.at(-1)?.content).toContain("recallScenario_required");
      return done;
    });
    expect(count).toBe(2);
  });

  it("presents a verified search passage once while retaining its original evidence receipt", async () => {
    const options = thinkingOptions();
    const excerpt = "The test observed two messages. Delivery order remained unknown.";
    const receipt = createThinkingReadReceipt("current-input", "search", [{
      ref: "events/Example", sourceKind: "semantic_document", edition: "current",
      asOf: "2026-11-08T10:00:00Z", revision: "1".repeat(64), coverage: "excerpt", excerpt,
    }]);
    const output = wrapThinkingRead(receipt, "More matches are available on the next page.");
    const tools = { recallSearch: tool({ inputSchema: z.object({}), execute: () => output,
      toModelOutput: renderVerifiedSearchPassages }) };
    const requests: ModelRequest[] = [];
    const result = await runAgent({ ...options, tools, stopWhen: isStepCount(2) }, async request => {
      requests.push(request);
      return requests.length === 1 ? requestTool("recallSearch", {}, "search") : done;
    });
    const shown = requests[1]!.messages.at(-1)!;
    expect(shown).toMatchObject({ role: "tool", tool_call_id: "search" });
    expect(shown.content).toContain("[search:1] events/Example");
    expect(shown.content).toContain("edition: current, excerpt");
    expect(String(shown.content).split(excerpt)).toHaveLength(2);
    expect(String(shown.content).indexOf(excerpt)).toBeLessThan(String(shown.content).indexOf("next page"));
    expect(shown.content).not.toContain("PREVIOUSLY_THINKING_READ");
    expect(collectThinkingReads(result.messages, "current-input")).toEqual(receipt.reads);
    expect(result.toolResults[0]?.output).toBe(output);
    expect(renderVerifiedSearchPassages(output, "some-other-call")).toBeUndefined();
  });

  it("restricts only an accepted completion, including when this work resumes after a timeout", async () => {
    const accepted = { ok: true, kind: "work-update", sourceInputId: "current-input", updateId: "current-work:tool-call", runId: "actor" };
    let output: unknown = { ok: false, reason: "try again" };
    const options = thinkingOptions();
    const tools = { ...options.tools, completeWork: tool({ description: "Fixture handoff", inputSchema: z.object({}), execute: () => output }) };
    const seen: ModelRequest[] = [];
    const replay = replayedResult("completeWork", {}, accepted);
    const run = (messages: ModelMessage[], caller: ModelCaller) =>
      runAgent({ ...options, tools, messages, stopWhen: isStepCount(3) }, request => {
        seen.push(request);
        return caller(request);
      });
    await run(replay, async () => seen.length === 1 ? requestTool("completeWork", {}) : done);
    expect(seen.slice(0, 2).every(request => request.tools?.some(t => t.function.name === "recallRead"))).toBe(true);

    output = accepted;
    await expect(run(replay, async () => {
      if (seen.length === 3) return requestTool("completeWork", {});
      throw new Error("simulated timeout on report");
    })).rejects.toThrow("simulated timeout");
    await run(replay, async () => requestTool("finishThinking", {}));
    for (const request of seen.slice(3)) {
      expect(request.tools?.map(t => t.function.name)).toEqual(["finishThinking"]);
      expect(request.toolChoice).toBeUndefined();
    }
  });
});
