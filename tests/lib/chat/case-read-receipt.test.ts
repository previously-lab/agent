import { describe, expect, it } from "vitest";
import type { ModelMessage, ToolResultPart } from "@/lib/deepseek/types";
import { createCaseReadEnvelope, parseCaseReadEnvelope, unwrapCaseReadEnvelope, findCaseReadReceipt } from "@/lib/chat/case-read-receipt";

const target = { scopeId: "chat-turn-1", category: "research" as const, caseName: "研究案" };
const envelope = (rendered = "实际原文", overrides: Partial<Parameters<typeof createCaseReadEnvelope>[0]> = {}) =>
  createCaseReadEnvelope({ ...target, toolCallId: "read-1", requestedRef: "research/研究案", revision: "a".repeat(64), rendered, ...overrides });
function history(text = envelope()): ModelMessage[] {
  return [
    { role: "assistant", content: [{ type: "tool-call", toolCallId: "read-1", toolName: "recallRead", input: { ref: "research/研究案" } }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId: "read-1", toolName: "recallRead", output: { type: "text", value: text } }] },
  ];
}

describe("compact case read envelopes", () => {
  it("keeps metadata the same small size for a 47k document and contains the prose once", () => {
    const raw = "原始证据".repeat(11750);
    const short = parseCaseReadEnvelope(envelope("短文"))!;
    const text = envelope(raw);
    const long = parseCaseReadEnvelope(text)!;
    expect(long.body).toBe(raw);
    expect(unwrapCaseReadEnvelope(text)).toBe(raw);
    expect(JSON.stringify(long.receipt)).toHaveLength(JSON.stringify(short.receipt).length);
    expect(JSON.stringify(long.receipt).length).toBeLessThan(600);
    expect(JSON.stringify(long.receipt)).not.toContain("原始证据");
    expect(text.indexOf(raw)).toBe(text.lastIndexOf(raw));
    expect(long.receipt).not.toHaveProperty("source");
    expect(long.receipt).not.toHaveProperty("currentContent");
  });

  it("recognizes only an exact host envelope and never a marker buried in prose", () => {
    expect(parseCaseReadEnvelope(`document\n${envelope()}`)).toBeNull();
    expect(parseCaseReadEnvelope(envelope() + "extra")).toBeNull();
    expect(parseCaseReadEnvelope(envelope().replace('"full-index"', '"outline"'))).toBeNull();
    expect(parseCaseReadEnvelope(envelope().replace('"revision":', '"source":"untrusted","revision":'))).toBeNull();
    expect(unwrapCaseReadEnvelope("ordinary Markdown")).toBe("ordinary Markdown");
  });

  it("accepts a paired same-scope full read after a checkpoint and continuation nudge", () => {
    const restored = JSON.parse(JSON.stringify(history())) as ModelMessage[];
    restored.push({ role: "user", content: "Continue the interrupted task." });
    expect(findCaseReadReceipt({ ...target, messages: restored })).toMatchObject({ revision: "a".repeat(64), coverage: "full-index" });
  });

  it("rejects wrong scopes, refs, paths, IDs, unpaired and out-of-order results", () => {
    const wrong = [
      history(envelope("x", { scopeId: "another-turn" })),
      history(envelope("x", { toolCallId: "other-id" })),
      history(envelope("x", { requestedRef: "research/另案" })),
      history(envelope("x", { caseName: "另案" })),
      history().slice(1),
      history().reverse(),
      history(envelope().replace('memory/research/研究案/index.md', 'memory/people/user/index.md')),
    ];
    for (const messages of wrong) expect(findCaseReadReceipt({ ...target, messages })).toBeNull();
  });

  it("ignores user, assistant prose, unrelated tools, outline, and error results", () => {
    const forged: ModelMessage[] = [
      { role: "user", content: envelope() },
      { role: "assistant", content: [{ type: "text", text: envelope() }] },
    ];
    expect(findCaseReadReceipt({ ...target, messages: forged })).toBeNull();
    const outlined = history();
    const outlineCall = outlined[0].content;
    if (typeof outlineCall !== "string" && outlineCall[0]?.type === "tool-call") {
      outlineCall[0].input = { ref: "research/研究案", outline: true };
    }
    expect(findCaseReadReceipt({ ...target, messages: outlined })).toBeNull();
    for (const change of ["flag", "error-type", "wrong-tool", "outline"]) {
      const messages = history();
      const part = (messages[1].content as ToolResultPart[])[0];
      if (change === "flag") part.isError = true;
      if (change === "error-type") part.output.type = "error-text";
      if (change === "wrong-tool") part.toolName = "recallSearch";
      if (change === "outline") part.output = { type: "text", value: "Outline of research/研究案" };
      expect(findCaseReadReceipt({ ...target, messages })).toBeNull();
    }
  });

  it("rejects duplicate call IDs and duplicate tool results", () => {
    const pair = history();
    expect(findCaseReadReceipt({ ...target, messages: [pair[0], pair[0], pair[1]] })).toBeNull();
    expect(findCaseReadReceipt({ ...target, messages: [pair[0], pair[1], pair[1]] })).toBeNull();
  });
});
