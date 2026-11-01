import { describe, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({ options: undefined as any }));
vi.mock("@/lib/deepseek/workflow-agent", () => ({
  DeepSeekAgent: class {
    constructor(options: unknown) { captured.options = options; }
  },
}));

import { createChatAgent } from "@/app/api/agent/agent";
import { runAgent, zeroUsage, type ModelCaller } from "@/lib/deepseek/runner";
import { isStepCount, tool } from "@/lib/deepseek/tools";
import type { AgentOptions, ModelResponse } from "@/lib/deepseek/types";
import { FIXED_MODEL } from "@/lib/models/registry";
import { z } from "zod";

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
