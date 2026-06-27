import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock Flash call to return predictable results
vi.mock("@/lib/router/flash", () => ({
  classifyWithFlash: vi.fn().mockResolvedValue({
    intent: "code_debug",
    confidence: 0.94,
    intent_switched: false,
    needs_more_turns: false,
    reasoning: "test",
  }),
  classifyIntentHybrid: vi.fn().mockImplementation(async (input: { currentInput: string }) => {
    // Simulate hybrid behavior: keyword rules win for certain inputs
    const lower = input.currentInput.toLowerCase();
    if (lower.includes("报错") || lower.includes("bug") || lower.includes("fix")) {
      return { intent: "code_debug", confidence: 1.0, source: "keyword", needsMoreTurns: false };
    }
    if (lower.includes("写") || lower.includes("实现") || lower.includes("create")) {
      return { intent: "code_write", confidence: 1.0, source: "keyword", needsMoreTurns: false };
    }
    if (lower.includes("解释") || lower.includes("什么是")) {
      return { intent: "explain", confidence: 1.0, source: "keyword", needsMoreTurns: false };
    }
    if (lower.includes("你好") || lower.includes("谢谢")) {
      return { intent: "chat", confidence: 1.0, source: "keyword", needsMoreTurns: false };
    }
    return { intent: "code_debug", confidence: 0.94, source: "flash", needsMoreTurns: false };
  }),
}));

import { classifyIntent, resolveIntent, classifyIntentKeywords } from "@/lib/router";

describe("Router - Flash Integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("classifies debug intent with keyword override", async () => {
    const result = await classifyIntent({
      currentInput: "我的代码报错了，帮我看看",
      lastTurnSummary: "",
      sessionIntent: "clarify",
      recentTurns: [],
    });
    expect(result.intent).toBe("code_debug");
    expect(result.source).toBe("keyword");
  });

  it("classifies code_write intent from keywords", async () => {
    const result = await classifyIntent({
      currentInput: "帮我实现一个新的API端点",
      lastTurnSummary: "",
      sessionIntent: "clarify",
      recentTurns: [],
    });
    expect(result.intent).toBe("code_write");
  });

  it("classifies chat intent from keywords", async () => {
    const result = await classifyIntent({
      currentInput: "你好！",
      lastTurnSummary: "",
      sessionIntent: "clarify",
      recentTurns: [],
    });
    expect(result.intent).toBe("chat");
  });

  it("detects intent switch", async () => {
    const result = await classifyIntent({
      currentInput: "帮我修一个bug",
      lastTurnSummary: "user was chatting",
      sessionIntent: "chat",
      recentTurns: [],
    });
    expect(result.switched).toBe(true);
  });

  it("resolveIntent returns both intent and strategy", async () => {
    const { intent, strategy } = await resolveIntent({
      currentInput: "fix the bug in auth.ts",
      lastTurnSummary: "",
      sessionIntent: "clarify",
      recentTurns: [],
    });
    expect(intent.intent).toBe("code_debug");
    expect(strategy.max_nodes).toBeGreaterThan(0);
  });

  it("keyword-only classifier works without Flash", () => {
    const result = classifyIntentKeywords("帮我看看这个bug");
    expect(result.intent).toBe("code_debug");
    expect(result.source).toBe("keyword");
  });

  it("keyword-only falls back for unknown", () => {
    const result = classifyIntentKeywords("...");
    expect(result.intent).toBe("clarify");
  });
});
