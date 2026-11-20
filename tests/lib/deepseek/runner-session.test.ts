import { describe, expect, it } from "vitest";
import { runAgent } from "@/lib/deepseek/runner";
import type { ModelRequest } from "@/lib/deepseek/types";

const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, reasoningTokens: 0, cachedInputTokens: 0, uncachedInputTokens: 0 };

describe("stable provider session forwarding", () => {
  it("passes the session ID separately from the step call ID", async () => {
    let captured: ModelRequest | undefined;
    await runAgent({ prompt: "hello", sessionId: "slice-2026-11-17-0100" }, async request => {
      captured = request;
      return { message: { role: "assistant", content: "ok" }, toolCalls: [], finishReason: "stop", usage };
    });
    expect(captured?.sessionId).toBe("slice-2026-11-17-0100");
    expect(captured?.callId).toBe("agent:0");
    expect(JSON.stringify(captured)).not.toContain("apiKey");
  });
});
