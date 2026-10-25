import { describe, it, expect, vi, beforeEach } from "vitest";

const ai = vi.hoisted(() => ({
  streamText: vi.fn(),
  // Records the runner's step cap (stopWhen: isStepCount(maxSteps)) so the
  // anti-loop fuse value is assertable.
  isStepCount: vi.fn((n: number) => ({ __stepCount: n })),
}));
vi.mock("@/lib/deepseek/generate", async () => {
  const actual = await vi.importActual("@/lib/deepseek/generate");
  return { ...actual, streamText: ai.streamText, isStepCount: ai.isStepCount };
});
vi.mock("@/lib/models/provider", () => ({
  createModel: vi.fn((c: unknown) => ({ _mock: c })),
}));

import { analyzeTurn } from "@/lib/episodic/flash/turn-analyzer";
import type { ModelConfig } from "@/lib/models/registry";

const model: ModelConfig = {
  id: "deepseek-v4-flash",
  name: "DeepSeek V4 Flash",
  provider: "deepseek",
  providerName: "DeepSeek",
  sdk: "deepseek",
  envKey: "DEEPSEEK_API_KEY",
  capabilities: { thinking: true, vision: false, maxTokens: 393216 },
  defaultThinking: false,
  defaultEffort: "low",
};

/** A StreamTextResult stand-in resolving to the given report tool call. */
function makeToolCall(input: unknown) {
  return {
    text: Promise.resolve(""),
    toolCalls: Promise.resolve([{ toolName: "analyzeOutput", input }]),
    reasoningText: Promise.resolve(undefined),
    sources: Promise.resolve([]),
    warnings: Promise.resolve([]),
  };
}

/** A StreamTextResult stand-in with no tool calls at all. */
function noToolCall() {
  return {
    text: Promise.resolve(""),
    toolCalls: Promise.resolve([]),
    reasoningText: Promise.resolve(undefined),
    sources: Promise.resolve([]),
    warnings: Promise.resolve([]),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("analyzeTurn", () => {
  it("parses intent, emotional signal, and close marking from the tool call", async () => {
    ai.streamText.mockResolvedValue(
      makeToolCall({
        intent: { type: "code_debug", reason: "user is debugging a failing loop" },
        memory_worthy: true,
        emotional_signal: { intensity: "strong", register: "frustrated", note: "user is frustrated" },
        closed_marking: {
          focus: "Rust loop tests",
          summary: "Debugged failures",
          tone: "mixed",
          open_loops: ["why does the iterator borrow fail"],
          decisions: ["pin the toolchain to stable"],
        },
      }),
    );

    const result = await analyzeTurn({
      model,
      userMessage: "rust loop broken",
      closingSlice: {
        turns: [{ timestamp: "t", role: "user", content: "hi" }],
      },
    });

    // The retired semantic-hint task is gone from the output entirely.
    expect(result.semanticHint).toBeUndefined();
    expect(result.intent).toEqual({
      type: "code_debug",
      reason: "user is debugging a failing loop",
    });
    expect(result.memoryWorthy).toBe(true);
    expect(result.emotionalSignal).toEqual({
      intensity: "strong",
      register: "frustrated",
      note: "user is frustrated",
    });
    expect(result.closedMarking).toEqual({
      focus: "Rust loop tests",
      summary: "Debugged failures",
      tone: "mixed",
      openLoops: ["why does the iterator borrow fail"],
      decisions: ["pin the toolchain to stable"],
    });
  });

  it("passes through memory_worthy for a trivial turn", async () => {
    ai.streamText.mockResolvedValue(
      makeToolCall({
        intent: { type: "chat", reason: "greeting" },
        memory_worthy: false,
        emotional_signal: { intensity: "none", register: "neutral", note: "" },
      }),
    );
    const result = await analyzeTurn({ model, userMessage: "你好" });
    expect(result.memoryWorthy).toBe(false);
  });

  it("extracts an explicit memory update request", async () => {
    ai.streamText.mockResolvedValue(
      makeToolCall({
        intent: { type: "chat", reason: "user asked to record a preference" },
        memory_worthy: true,
        emotional_signal: { intensity: "light", register: "excited", note: "user is happy" },
        memory_update: { content: "User prefers answers in Chinese from now on", section: "past" },
      }),
    );
    const result = await analyzeTurn({ model, userMessage: "记住：以后都用中文回答" });
    expect(result.memoryUpdate).toEqual({
      content: "User prefers answers in Chinese from now on",
      section: "past",
    });
  });

  it("extracts an explicit behavioral correction as a memory update", async () => {
    ai.streamText.mockResolvedValue(
      makeToolCall({
        intent: { type: "chat", reason: "user correcting agent behavior" },
        memory_worthy: true,
        emotional_signal: { intensity: "light", register: "frustrated", note: "mildly annoyed" },
        memory_update: { content: "Never open with filler preambles", section: "past" },
      }),
    );
    const result = await analyzeTurn({ model, userMessage: "以后别给废话开场白" });
    expect(result.memoryUpdate).toEqual({
      content: "Never open with filler preambles",
      section: "past",
    });
  });

  it("drops a stale self_model section hint (the v5 card no longer has that section)", async () => {
    ai.streamText.mockResolvedValue(
      makeToolCall({
        intent: { type: "chat", reason: "user correcting agent behavior" },
        memory_worthy: true,
        emotional_signal: { intensity: "light", register: "frustrated", note: "mildly annoyed" },
        // A model emitting the retired enum value fails schema validation of
        // the section field — the report must survive regardless (zod strips
        // or the runner's report extraction rejects; either way no crash).
        memory_update: { content: "Never open with filler preambles", section: "self_model" },
      }),
    );
    const result = await analyzeTurn({ model, userMessage: "以后别给废话开场白" });
    // The invalid enum invalidates the whole report → degraded empty analysis.
    expect(result.memoryUpdate).toBeUndefined();
    expect(result.memoryWorthy).toBe(true);
  });

  it("omits memory_update when the user did not explicitly ask", async () => {
    ai.streamText.mockResolvedValue(
      makeToolCall({
        intent: { type: "chat", reason: "greeting" },
        memory_worthy: false,
        emotional_signal: { intensity: "none", register: "neutral", note: "" },
      }),
    );
    const result = await analyzeTurn({ model, userMessage: "你好" });
    expect(result.memoryUpdate).toBeUndefined();
  });

  it("omits closed marking when no slice is closing", async () => {
    ai.streamText.mockResolvedValue(
      makeToolCall({
        intent: { type: "chat", reason: "greeting" },
        memory_worthy: false,
        emotional_signal: { intensity: "none", register: "neutral", note: "" },
      }),
    );
    const result = await analyzeTurn({ model, userMessage: "x" });
    expect(result.closedMarking).toBeUndefined();
    expect(result.memoryWorthy).toBe(false);
  });

  it("parses the emotional register and normalizes a missing register to neutral", async () => {
    ai.streamText.mockResolvedValue(
      makeToolCall({
        intent: { type: "chat", reason: "user is venting" },
        memory_worthy: false,
        emotional_signal: { intensity: "strong", note: "venting about a rough week" },
      }),
    );
    const result = await analyzeTurn({ model, userMessage: "今天太难了" });
    expect(result.emotionalSignal).toEqual({
      intensity: "strong",
      register: "neutral",
      note: "venting about a rough week",
    });
  });

  it("returns an empty analysis when the model fails", async () => {
    ai.streamText.mockRejectedValue(new Error("boom"));
    const result = await analyzeTurn({ model, userMessage: "x" });
    expect(result).toEqual({
      memoryWorthy: true,
      emotionalSignal: { intensity: "none", register: "neutral", note: "" },
    });
  });

  it("returns an empty analysis when the tool call is missing", async () => {
    ai.streamText.mockResolvedValue(noToolCall());
    const result = await analyzeTurn({ model, userMessage: "x" });
    expect(result.semanticHint).toBeUndefined();
    expect(result.memoryWorthy).toBe(true);
  });

  it("sends a static shared-base system prompt and dynamic content in the user prompt", async () => {
    ai.streamText.mockResolvedValue(
      makeToolCall({
        intent: { type: "chat", reason: "chat" },
        memory_worthy: false,
        emotional_signal: { intensity: "none", register: "neutral", note: "" },
      }),
    );
    await analyzeTurn({ model, userMessage: "hello world" });

    const arg = ai.streamText.mock.calls.at(-1)?.[0] as {
      system: string;
      prompt: string;
    };
    // Static: shared sub-agent base + role instructions live in system.
    expect(arg.system).toContain("sub-agent of the Previously memory system");
    expect(arg.system).toContain("memory analyzer");
    expect(arg.system).not.toContain("hello world");
    // The retired semantic-hint task is gone from the role block.
    expect(arg.system).not.toContain("Semantic hint");
    // Dynamic: the message lives in the user prompt.
    expect(arg.prompt).toContain('Message: "hello world"');
  });

  it("projects native agent replies in closing excerpts but keeps user words raw", async () => {
    const agent = `agent before\n\`\`\`html live\n${"<button>generated preference</button>\n".repeat(30)}\`\`\`\nagent after`;
    const user = "user native\n```html live\n<button>user example</button>\n```";
    const turns = [
      { timestamp: "u", role: "user" as const, content: user },
      { timestamp: "a", role: "agent" as const, content: agent },
    ];
    const snapshot = turns.map((turn) => ({ ...turn }));
    ai.streamText.mockResolvedValue(
      makeToolCall({
        intent: { type: "chat", reason: "chat" },
        memory_worthy: true,
        emotional_signal: { intensity: "none", register: "neutral", note: "" },
      }),
    );

    await analyzeTurn({ model, userMessage: "current", closingSlice: { turns } });

    const arg = ai.streamText.mock.calls.at(-1)?.[0] as { prompt: string };
    expect(arg.prompt).toContain("agent before\n[Interactive visual omitted]agent after");
    expect(arg.prompt).not.toContain("generated preference");
    expect(arg.prompt).toContain(user);
    expect(turns).toEqual(snapshot);
  });

  it("returns an empty analysis on failure even when a slice is closing", async () => {
    ai.streamText.mockRejectedValue(new Error("boom"));
    const result = await analyzeTurn({
      model,
      userMessage: "x",
      closingSlice: { turns: [{ timestamp: "t", role: "user", content: "hi" }] },
    });
    expect(result.closedMarking).toBeUndefined();
    expect(result.memoryWorthy).toBe(true);
  });

  it("runs with the 50-step anti-loop fuse (the wall clock is the real budget)", async () => {
    ai.streamText.mockResolvedValue(
      makeToolCall({
        intent: { type: "chat", reason: "chat" },
        memory_worthy: false,
        emotional_signal: { intensity: "none", register: "neutral", note: "" },
      }),
    );
    await analyzeTurn({ model, userMessage: "x" });
    expect(ai.streamText.mock.calls.at(-1)?.[0].stopWhen.maxSteps).toBe(50);
  });
});
