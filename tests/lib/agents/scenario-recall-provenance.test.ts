import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentOptions, ModelRequest } from "@/lib/deepseek/types";

const native = vi.hoisted(() => ({ streamText: vi.fn() }));
vi.mock("@/lib/deepseek/generate", () => ({ streamText: native.streamText }));
vi.mock("workflow", () => ({ getWritable: vi.fn() }));
vi.mock("@/lib/evolution/store", () => ({ readSelfSopSnapshot: vi.fn() }));
vi.mock("@/lib/evolution/skill-store", () => ({ readSkillLedger: vi.fn() }));
vi.mock("@/lib/chat/step-timeout", () => ({
  withStepTimeout: vi.fn(async (work: () => Promise<unknown>) => ({ ok: true, result: await work(), elapsedMs: 0 })),
}));

import { runScenarioRecall } from "@/lib/agents/scenario-recall";
import { runAgent, zeroUsage } from "@/lib/deepseek/runner";
import { serializeSlice } from "@/lib/episodic/manager";
import { NATIVE_REPLY_OMISSION_MARKER, projectNativeReplySemantics } from "@/lib/markdown/native-reply-semantics";

const REF = "records/2026-10-20-0930";
const PATH = "memory/records/2026/10/20/0930/core.md";
const QUOTE = "Interactive visual";

function conversation(content: string): string {
  return serializeSlice({
    slice_id: "2026-10-20-0930",
    focus: "An earlier drawing",
    status: "closed",
    start: "2026-10-20T09:30:00.000Z",
    timezone: "UTC",
    summary: "A conversation about a drawing",
    open_loops: [], decisions: [], tags: [], related_slices: [], loops: [], estimatedTokens: 0,
    closedBy: "user_explicit",
    turns: [
      { timestamp: "2026-10-20T09:30:00.000Z", role: "user", turnId: "drawing", content: "Please draw a button." },
      { timestamp: "2026-10-20T09:31:00.000Z", role: "agent", turnId: "drawing", content },
    ],
  });
}

async function recall(content: string, quote = QUOTE) {
  const raw = conversation(content);
  const files = new Map([[PATH, raw]]);
  const readFile = vi.fn(async (path: string) => {
    const value = files.get(path);
    if (value === undefined) throw new Error(`File not found: ${path}`);
    return value;
  });
  native.streamText.mockImplementation(async (options: AgentOptions) => {
    const read = options.tools?.readRecord.execute;
    if (!read) throw new Error("Missing original-record reader");
    const view = await read({ ref: REF }, {
      toolCallId: "read-original", messages: [], context: undefined, abortSignal: options.abortSignal,
    });
    expect(JSON.stringify(view)).toContain(NATIVE_REPLY_OMISSION_MARKER);
    expect(JSON.stringify(view)).not.toContain("<button>");
    return {
      text: Promise.resolve(""), reasoningText: Promise.resolve(""), sources: Promise.resolve([]),
      toolCalls: Promise.resolve([{
        toolCallId: "report", toolName: "scenarioRecallReport",
        input: {
          answer: "The earlier assistant used this phrase in prose.",
          evidence: [{ ref: REF, turnId: "drawing", role: "assistant", quote }],
          uncertainty: [],
        },
      }]),
    };
  });
  const result = await runScenarioRecall({
    question: "What phrase did the earlier assistant actually write in prose?",
    refs: [REF], backend: { listMemoryFiles: async () => [PATH], readFile }, timeoutMs: 1_000,
  });
  expect(files.get(PATH)).toBe(raw);
  expect(readFile).toHaveBeenCalledWith(PATH);
  expect(native.streamText).toHaveBeenCalledTimes(1);
  return result;
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("original prose provenance across native omission markers", () => {
  it("rejects marker substrings whose only original occurrence is inside generated HTML", async () => {
    const content = "```html live\n<button>Interactive visual</button>\n```";
    expect(projectNativeReplySemantics(content, "agent")).toContain(NATIVE_REPLY_OMISSION_MARKER);
    expect(NATIVE_REPLY_OMISSION_MARKER).toContain(QUOTE);
    const result = await recall(content);
    expect(result).toMatchObject({ status: "insufficient_evidence", answer: "", evidence: [] });
  });

  it("accepts the same words when they occur in visible original assistant prose", async () => {
    const result = await recall("Interactive visual is a presentation label.\n\n```html live\n<button>Some generated value</button>\n```");
    expect(result).toMatchObject({ status: "ok" });
    expect(result.evidence).toEqual([
      expect.objectContaining({ ref: REF, turnId: "drawing", role: "assistant", quote: QUOTE }),
    ]);
  });

  it("does not authorize a marker substring from matching real prose outside the returned window", async () => {
    const content = `\`\`\`html live\n<button>Interactive visual</button>\n\`\`\`\n\n${"x".repeat(5_000)}\nInteractive visual is real but hidden prose.`;
    const result = await recall(content);
    expect(result).toMatchObject({ status: "insufficient_evidence", answer: "", evidence: [], truncated: true });
  });

  it("allows a literal omission marker when it is itself visible original prose", async () => {
    const content = `The literal label ${NATIVE_REPLY_OMISSION_MARKER} is a display convention.\n\n\`\`\`html live\n<button>Generated value</button>\n\`\`\``;
    const result = await recall(content, NATIVE_REPLY_OMISSION_MARKER);
    expect(result).toMatchObject({ status: "ok" });
    expect(result.evidence).toEqual([
      expect.objectContaining({ role: "assistant", quote: NATIVE_REPLY_OMISSION_MARKER }),
    ]);
  });

  it("keeps thinking enabled and makes the final actual model step report-only with auto tool choice", async () => {
    const requests: ModelRequest[] = [];
    const raw = conversation("The earlier assistant wrote a visible original phrase.");
    native.streamText.mockImplementation(async (options: AgentOptions) => {
      expect(await options.prepareStep?.({ stepNumber: 7, steps: [], messages: [] })).toMatchObject({
        toolChoice: "auto", activeTools: ["scenarioRecallReport"], system: expect.stringContaining("This is the final step"),
      });
      expect(await options.prepareStep?.({ stepNumber: 0, steps: [], messages: [] })).toBeUndefined();
      const result = await runAgent(options, async (request) => {
        const final = requests.length === 7;
        requests.push(request);
        const toolCalls = [{
          id: `model-step-${requests.length}`, type: "function" as const,
          function: {
            name: final ? "scenarioRecallReport" : "readRecord",
            arguments: JSON.stringify(final ? {
              answer: "The assistant wrote a visible original phrase.",
              evidence: [{ ref: REF, turnId: "drawing", role: "assistant", quote: "visible original phrase" }],
              uncertainty: [],
            } : { ref: REF }),
          },
        }];
        expect(request.thinking).toBe(true);
        if (request.thinking && typeof request.toolChoice === "object") throw new Error("Thinking rejects forced named tool choice");
        return {
          message: { role: "assistant", content: null, tool_calls: toolCalls },
          toolCalls, finishReason: "tool_calls", usage: zeroUsage(),
        };
      });
      return {
        text: Promise.resolve(result.text), reasoningText: Promise.resolve(result.reasoningText),
        toolCalls: Promise.resolve(result.toolCalls), sources: Promise.resolve([]),
      };
    });
    const result = await runScenarioRecall({
      question: "What did the assistant write?", refs: [REF], timeoutMs: 1_000,
      backend: { listMemoryFiles: async () => [PATH], readFile: async () => raw },
    });
    expect(result.status).toBe("ok");
    expect(requests).toHaveLength(8);
    expect(requests.at(-1)?.toolChoice).toBe("auto");
    expect(requests.at(-1)?.tools?.map((definition) => definition.function.name)).toEqual(["scenarioRecallReport"]);
    expect(requests.at(-1)?.messages[0].content).toContain("Call scenarioRecallReport now");
  });

  it("stops after an in-flight backend read crosses its own deadline, without starting another read", async () => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds: number) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException("Fixture recall deadline", "TimeoutError")), milliseconds);
      return controller.signal;
    });
    let release: (value: string) => void = () => {};
    let started: () => void = () => {};
    const waiting = new Promise<string>((resolve) => { release = resolve; });
    const reading = new Promise<void>((resolve) => { started = resolve; });
    const raw = conversation("An original statement.");
    const readFile = vi.fn(async () => {
      if (readFile.mock.calls.length === 1) { started(); return waiting; }
      return raw;
    });
    native.streamText.mockImplementation(async (options: AgentOptions) => {
      const search = options.tools?.searchRecords.execute;
      if (!search) throw new Error("Missing bounded record search");
      await search({ query: "statement" }, { toolCallId: "search", messages: [], context: undefined });
      return {
        text: Promise.resolve(""), reasoningText: Promise.resolve(""), sources: Promise.resolve([]),
        toolCalls: Promise.resolve([{
          toolCallId: "report", toolName: "scenarioRecallReport",
          input: { answer: "No verified evidence.", evidence: [], uncertainty: [] },
        }]),
      };
    });
    const run = runScenarioRecall({
      question: "Find the earlier statement.", timeoutMs: 1_000,
      backend: {
        listMemoryFiles: async () => [PATH, "memory/records/2026/10/19/1800/core.md"], readFile,
      },
    });
    await reading;
    await vi.advanceTimersByTimeAsync(1_000);
    release(raw);
    const result = await run;
    expect(result).toMatchObject({ status: "timeout", answer: "", evidence: [] });
    expect(readFile).toHaveBeenCalledTimes(1);
    expect(result.coverage.read).toEqual([]);
    expect(result.error).toContain("timed out");
  });
});
