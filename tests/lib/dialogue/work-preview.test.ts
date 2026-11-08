import { describe, expect, it } from "vitest";
import { createWorkPreviewFilter, workPreviewCursor } from "@/lib/dialogue/work-preview";

function project(chunks: unknown[]) {
  const filter = createWorkPreviewFilter();
  return chunks.map((chunk) => filter.push(chunk)).filter((signal) => signal !== null);
}

describe("dialogue work preview filtering", () => {
  it("streams displayable text but never raw reasoning", () => {
    expect(project([
      { type: "text-start", id: "text-1" },
      { type: "text-delta", id: "text-1", delta: "Hello" },
      { type: "reasoning-start", id: "reasoning-1" },
      { type: "reasoning-delta", id: "reasoning-1", delta: "private chain of thought" },
      { type: "data-reasoning", data: { reasoning_content: "also private" } },
      { type: "text-delta", id: "text-1", delta: " world" },
      { type: "text-end", id: "text-1" },
    ])).toEqual([
      { type: "text", partId: "text-1", delta: "Hello" },
      { type: "text", partId: "text-1", delta: " world" },
    ]);
  });

  it("withholds a split native opener, all HTML bytes, and resumes after its close", () => {
    const signals = project([
      { type: "text-delta", id: "text-1", delta: "Before\n" },
      { type: "text-delta", id: "text-1", delta: "`" },
      { type: "text-delta", id: "text-1", delta: "`" },
      { type: "text-delta", id: "text-1", delta: "`html" },
      { type: "text-delta", id: "text-1", delta: " live\n<!doctype html>\n<script>secret</script>\n" },
      { type: "text-delta", id: "text-1", delta: "```\nAfter" },
      { type: "text-end", id: "text-1" },
    ]);
    expect(signals).toEqual([
      { type: "text", partId: "text-1", delta: "Before\n" },
      { type: "text", partId: "text-1", delta: "After" },
    ]);
    expect(JSON.stringify(signals)).not.toContain("secret");
  });

  it("cuts malformed raw HTML and unfinished structure without breaking ordinary comparisons", () => {
    expect(project([
      { type: "text-delta", id: "html", delta: "Hello <" },
      { type: "text-delta", id: "html", delta: "script>secret</script>" },
      { type: "text-delta", id: "fence", delta: "```ht" },
      { type: "text-end", id: "fence" },
      { type: "text-delta", id: "math", delta: "2 < 3" },
    ])).toEqual([
      { type: "text", partId: "html", delta: "Hello " },
      { type: "text", partId: "math", delta: "2 < 3" },
    ]);
  });

  it("forwards only tool identity and state, with one running frame per call", () => {
    const signals = project([
      { type: "tool-input-start", toolCallId: "call-1", toolName: "readFile" },
      { type: "tool-input-delta", toolCallId: "call-1", inputTextDelta: "{\"path\":\"secret\"}" },
      { type: "tool-call", toolCallId: "call-1", toolName: "readFile", input: { path: "secret" } },
      { type: "tool-result", toolCallId: "call-1", toolName: "readFile", output: { token: "secret" } },
      { type: "tool-output-error", toolCallId: "call-2", errorText: "credential failed" },
    ]);
    expect(signals).toEqual([
      { type: "tool", toolCallId: "call-1", toolName: "readFile", state: "running" },
      { type: "tool", toolCallId: "call-1", toolName: "readFile", state: "completed" },
      { type: "tool", toolCallId: "call-2", toolName: "tool", state: "failed" },
    ]);
    expect(JSON.stringify(signals)).not.toContain("secret");
    expect(JSON.stringify(signals)).not.toContain("credential");
  });

  it("carries a validated subject from start to detail to completion on one tool ID", () => {
    const signals = project([
      { type: "tool-input-start", toolCallId: "search-1", toolName: "webSearch" },
      { type: "tool-input-delta", toolCallId: "search-1", inputTextDelta: "{\"query\":\"故宫开放时间\",\"token\":\"private-value\"}" },
      { type: "tool-input-available", toolCallId: "search-1", toolName: "webSearch",
        input: { query: "故宫开放时间", token: "private-value" } },
      { type: "tool-call", toolCallId: "search-1", toolName: "webSearch", input: { query: "故宫开放时间" } },
      { type: "tool-output-available", toolCallId: "search-1", output: {
        answer: "private answer",
        sources: [
          { title: "One", url: "https://example.com/one?token=private-value" },
          { title: "Two", url: "https://example.net/two" },
        ],
      } },
    ]);
    expect(signals).toEqual([
      { type: "tool", toolCallId: "search-1", toolName: "webSearch", state: "running" },
      { type: "tool", toolCallId: "search-1", toolName: "webSearch", state: "running", subject: "故宫开放时间" },
      { type: "tool", toolCallId: "search-1", toolName: "webSearch", state: "completed",
        subject: "故宫开放时间", outcome: "found", resultCount: 2 },
    ]);
    const serialized = JSON.stringify(signals);
    expect(serialized).not.toContain("private answer");
    expect(serialized).not.toContain("token");
    expect(serialized).not.toContain("private-value");
    expect(serialized).not.toContain("example.com");
  });

  it("projects only URL hostnames from page URLs and search terms", () => {
    const signals = project([
      { type: "tool-input-available", toolCallId: "fetch-1", toolName: "webFetch",
        input: { url: "https://user:pass@example.com/private?access_token=private-value" } },
      { type: "tool-output-available", toolCallId: "fetch-1", output: "ERROR: credential failure" },
      { type: "tool-input-available", toolCallId: "fetch-2", toolName: "webFetch",
        input: { url: "https://example.com/share/secret-in-path?access_token=private-value#ticket" } },
      { type: "tool-output-available", toolCallId: "fetch-2", output: "" },
      { type: "tool-input-available", toolCallId: "search-url", toolName: "webSearch",
        input: { query: "Hours at https://example.com/share/secret-in-path?access_token=private-value" } },
    ]);
    expect(signals).toEqual([
      { type: "tool", toolCallId: "fetch-1", toolName: "webFetch", state: "running" },
      { type: "tool", toolCallId: "fetch-1", toolName: "webFetch", state: "failed" },
      { type: "tool", toolCallId: "fetch-2", toolName: "webFetch", state: "running",
        subject: "example.com" },
      { type: "tool", toolCallId: "fetch-2", toolName: "webFetch", state: "completed",
        subject: "example.com", outcome: "empty", resultCount: 0 },
      { type: "tool", toolCallId: "search-url", toolName: "webSearch", state: "running", subject: "Hours at example.com" },
    ]);
    const serialized = JSON.stringify(signals);
    expect(serialized).not.toContain("credential");
    expect(serialized).not.toContain("access_token");
    expect(serialized).not.toContain("private-value");
    expect(serialized).not.toContain("user:pass");
    expect(serialized).not.toContain("secret-in-path");
  });

  it("projects bounded document and reasoning subjects with verified outcomes", () => {
    const longQuestion = `  ${"问".repeat(120)}\n`;
    const signals = project([
      { type: "tool-input-available", toolCallId: "read-1", toolName: "recallRead",
        input: { ref: "research/故宫参观" } },
      { type: "tool-output-available", toolCallId: "read-1",
        output: "Nothing named \"research/故宫参观\" exists in memory — and nothing similar." },
      { type: "tool-input-available", toolCallId: "read-raw", toolName: "recallRead",
        input: { ref: "memory/records/2026/11/08/1200/core.md" } },
      { type: "tool-input-available", toolCallId: "scenario-1", toolName: "recallScenario",
        input: { question: "我们上次如何安排参观？", refs: ["records/2026-11-08-1200"] } },
      { type: "tool-output-available", toolCallId: "scenario-1", output: {
        status: "insufficient_evidence", evidence: [], answer: "private interpretation",
      } },
      { type: "tool-input-available", toolCallId: "think-1", toolName: "thinkDeep", input: { question: longQuestion } },
      { type: "tool-output-available", toolCallId: "think-1", output: {
        status: "error", ok: false, error: "private provider detail",
      } },
    ]);
    expect(signals[0]).toEqual({ type: "tool", toolCallId: "read-1", toolName: "recallRead", state: "running",
      subject: "research/故宫参观" });
    expect(signals[1]).toEqual({ type: "tool", toolCallId: "read-1", toolName: "recallRead", state: "completed",
      subject: "research/故宫参观", outcome: "empty", resultCount: 0 });
    expect(signals[2]).toEqual({ type: "tool", toolCallId: "read-raw", toolName: "recallRead", state: "running" });
    expect(signals[3]).toEqual({ type: "tool", toolCallId: "scenario-1", toolName: "recallScenario", state: "running",
      subject: "我们上次如何安排参观？" });
    expect(signals[4]).toEqual({ type: "tool", toolCallId: "scenario-1", toolName: "recallScenario", state: "completed",
      subject: "我们上次如何安排参观？", outcome: "empty", resultCount: 0 });
    const think = signals[5];
    expect(think).toMatchObject({ type: "tool", toolCallId: "think-1", state: "running" });
    if (think?.type !== "tool") throw new Error("Expected thinkDeep tool signal");
    expect(Array.from(think.subject ?? "")).toHaveLength(96);
    expect(think.subject).toMatch(/…$/);
    expect(signals[6]).toMatchObject({ type: "tool", toolCallId: "think-1", state: "failed" });
    const serialized = JSON.stringify(signals);
    expect(serialized).not.toContain("memory/records");
    expect(serialized).not.toContain("private interpretation");
    expect(serialized).not.toContain("private provider detail");
    expect(serialized).not.toContain("\n");
  });

  it("accepts only non-negative safe integer cursors", () => {
    expect(workPreviewCursor(null)).toBe(0);
    expect(workPreviewCursor("12")).toBe(12);
    expect(workPreviewCursor("-2")).toBe(0);
    expect(workPreviewCursor("2junk")).toBe(0);
    expect(workPreviewCursor("9007199254740992")).toBe(0);
  });
});
