import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock("@/lib/deepseek/steps", () => ({
  callModelStep: h.call,
  writeAgentEventStep: vi.fn(),
  closeAgentStreamStep: vi.fn(),
}));

import { createDialogueAgent } from "@/app/api/agent/agent";

describe("dialogue DeepSeek profile", () => {
  it("uses non-thinking Chat Completions settings only on the public dialogue", async () => {
    h.call.mockResolvedValue({
      message: { role: "assistant", content: "好的。" },
      toolCalls: [], finishReason: "stop",
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, reasoningTokens: 0, cachedInputTokens: 0, uncachedInputTokens: 0 },
    });
    const result = await createDialogueAgent().stream({ prompt: "fixture" });
    expect(result.text).toBe("好的。");
    expect(h.call).toHaveBeenCalledWith(expect.objectContaining({
      thinking: false,
      reasoningEffort: "low",
      temperature: 0.2,
      tools: undefined,
    }), undefined);
  });
});