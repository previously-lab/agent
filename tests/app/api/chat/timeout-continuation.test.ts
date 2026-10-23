import { describe, expect, it } from "vitest";
import type { ModelMessage } from "@/lib/deepseek/types";
import { toNativeMessages } from "@/lib/deepseek/messages";
import { buildTimeoutContinuation, type ContinuationStepSnapshot } from "@/app/api/chat/turn-workflow";

const history: ModelMessage[] = [{ role: "user", content: "what did we decide?" }];
const nudge = "You were interrupted. Continue.";
const nativeAssistant = {
  role: "assistant" as const, content: "Let me check.", reasoning_content: "The complete original reasoning.",
  tool_calls: [{ type: "function" as const, id: "original-id", function: { name: "recall", arguments: '{ "query" : "API decision" }' } }],
};
function completedStep(): ContinuationStepSnapshot {
  return { text: "Let me check.", toolCalls: [{ toolCallId: "original-id", toolName: "recall", input: { query: "API decision" } }],
    toolResults: [{ toolCallId: "original-id", toolName: "recall", output: "exact evidence" }],
    messages: [
      { role: "assistant", content: [{ type: "text", text: "Let me check." }], deepseek: nativeAssistant },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "original-id", toolName: "recall", output: { type: "text", value: "exact evidence" } }] },
    ],
  };
}

describe("native timeout continuation", () => {
  it("carries original reasoning, argument bytes and paired results into the next HTTP request", () => {
    const step = completedStep();
    const messages = buildTimeoutContinuation({ history, steps: [step], partialText: step.text, nudge });
    expect(messages).toEqual([...history, ...step.messages!, { role: "user", content: nudge }]);
    expect(toNativeMessages(messages)[1]).toEqual(nativeAssistant);
    expect(toNativeMessages(messages)[2]).toEqual({ role: "tool", tool_call_id: "original-id", content: "exact evidence" });
    // The visible partial was already carried in the authentic model message.
    expect(messages.filter((message) => message.role === "assistant")).toHaveLength(1);
  });
  it("keeps native text-only thinking steps as well as tool steps", () => {
    const message: ModelMessage = { role: "assistant", content: "answer", deepseek: { role: "assistant", content: "answer", reasoning_content: "reasoned answer" } };
    const messages = buildTimeoutContinuation({ history, steps: [{ text: "answer", toolCalls: [], toolResults: [], messages: [message] }], partialText: "answer", nudge });
    expect(messages).toEqual([...history, message, { role: "user", content: nudge }]);
    expect(toNativeMessages(messages)[1].reasoning_content).toBe("reasoned answer");
  });
  it("preserves failed tool results without reconstructing their calls", () => {
    const step = completedStep();
    step.messages![1] = { role: "tool", content: [{ type: "tool-result", toolCallId: "original-id", toolName: "recall", output: { type: "error-text", value: "read failed" } }] };
    const result = buildTimeoutContinuation({ history, steps: [step], partialText: "", nudge });
    expect(result[2]).toEqual(step.messages![1]);
  });
  it("degrades legacy snapshots to visible text rather than inventing tool history", () => {
    const step = completedStep(); delete step.messages;
    const result = buildTimeoutContinuation({ history, steps: [step], partialText: "legacy answer", nudge });
    expect(result).toEqual([...history, { role: "assistant", content: "legacy answer" }, { role: "user", content: nudge }]);
    expect(JSON.stringify(toNativeMessages(result))).not.toContain("tool_calls");
  });
  it("keeps completed step order and appends the continuation instruction last", () => {
    const first = completedStep();
    const second: ContinuationStepSnapshot = { text: "continuing", toolCalls: [], toolResults: [], messages: [{ role: "assistant", content: "continuing", reasoning_content: "more original reasoning" }] };
    const result = buildTimeoutContinuation({ history, steps: [first, second], partialText: "Let me check. continuing", nudge });
    expect(result).toEqual([...history, ...first.messages!, ...second.messages!, { role: "user", content: nudge }]);
  });
  it("handles an interruption before any completed step", () => {
    expect(buildTimeoutContinuation({ history, steps: [], partialText: "", nudge })).toEqual([...history, { role: "user", content: nudge }]);
  });
  it("does not mutate history or native step messages", () => {
    const step = completedStep();
    const before = JSON.stringify({ history, step });
    buildTimeoutContinuation({ history, steps: [step], partialText: "duplicate", nudge });
    expect(JSON.stringify({ history, step })).toBe(before);
  });
});
