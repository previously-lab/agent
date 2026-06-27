import { describe, it, expect } from "vitest";
import { classifyIntent, getStrategy, resolveIntent } from "@/lib/router";

describe("Router", () => {
  it("classifies debug intent from keywords", () => {
    const result = classifyIntent("我的代码报错了，帮我看看");
    expect(result.intent).toBe("code_debug");
    expect(result.source).toBe("keyword");
    expect(result.confidence).toBe(1.0);
  });

  it("classifies code_write intent from keywords", () => {
    const result = classifyIntent("帮我实现一个新的API端点");
    expect(result.intent).toBe("code_write");
    expect(result.source).toBe("keyword");
  });

  it("classifies chat intent from keywords", () => {
    const result = classifyIntent("你好！");
    expect(result.intent).toBe("chat");
  });

  it("classifies explain intent from keywords", () => {
    const result = classifyIntent("解释一下什么是React Server Component");
    expect(result.intent).toBe("explain");
  });

  it("falls back to clarify for unknown input", () => {
    const result = classifyIntent("...");
    expect(result.intent).toBe("clarify");
    expect(result.source).toBe("fallback");
  });

  it("returns correct strategy for known intent", () => {
    const strategy = getStrategy("code_debug");
    expect(strategy.loop_mode).toBe(true);
    expect(strategy.max_nodes).toBe(5);
    expect(strategy.memory_types).toContain("experience");
  });

  it("returns fallback strategy for unknown intent", () => {
    const strategy = getStrategy("unknown_intent");
    expect(strategy.loop_mode).toBe(false);
  });

  it("resolveIntent returns both intent and strategy", () => {
    const { intent, strategy } = resolveIntent("fix the bug in auth.ts");
    expect(intent.intent).toBe("code_debug");
    expect(strategy.max_nodes).toBeGreaterThan(0);
  });
});
