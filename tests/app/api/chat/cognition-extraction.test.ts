import { describe, it, expect } from "vitest";
import { extractCognition } from "@/app/api/chat/turn-workflow";
import type { ModelMessage } from "ai";

// ─── Helpers ───────────────────────────────────────────────────────────

function msg(role: "assistant", content: Array<Record<string, unknown>>): ModelMessage;
function msg(role: "tool", content: Array<Record<string, unknown>>): ModelMessage;
function msg(role: "user", content: string): ModelMessage;
function msg(
  role: string,
  content: string | Array<Record<string, unknown>>,
): ModelMessage {
  return { role, content } as ModelMessage;
}

// ─── extractCognition ──────────────────────────────────────────────────

describe("extractCognition", () => {
  it("returns an empty string when there is no reasoning or tool activity", () => {
    const messages: ModelMessage[] = [
      msg("assistant", [{ type: "text", text: "Hello!" }]),
    ];
    const result = extractCognition(messages);
    // No thinking, no tools — just a newline
    expect(result).toBe("\n");
  });

  it("extracts reasoning traces under a Thinking section", () => {
    const messages: ModelMessage[] = [
      msg("assistant", [
        { type: "reasoning", text: "The user is asking about Rust runtimes." },
        { type: "reasoning", text: "I need to check their preferences first." },
        { type: "text", text: "Let me look into that." },
      ]),
    ];
    const result = extractCognition(messages);
    expect(result).toContain("### Thinking");
    expect(result).toContain("The user is asking about Rust runtimes.");
    expect(result).toContain("I need to check their preferences first.");
    expect(result).not.toContain("### Tools");
  });

  it("extracts tool calls with parameters under a Tools section", () => {
    const messages: ModelMessage[] = [
      msg("assistant", [
        {
          type: "tool-call",
          toolCallId: "tc1",
          toolName: "readMemory",
          input: { path: "memory/nodes/rust-prefs.md" },
        },
      ]),
      msg("tool", [
        {
          type: "tool-result",
          toolCallId: "tc1",
          toolName: "readMemory",
          output: "...very long file content here...",
          isError: false,
        },
      ]),
    ];
    const result = extractCognition(messages);
    expect(result).toContain("### Tools");
    expect(result).toContain("`readMemory`");
    expect(result).toContain('path: "memory/nodes/rust-prefs.md"');
    expect(result).toContain("→ ok");
    // Raw output body must NOT appear
    expect(result).not.toContain("very long file content");
  });

  it("marks failed tools with the error reason", () => {
    const messages: ModelMessage[] = [
      msg("assistant", [
        {
          type: "tool-call",
          toolCallId: "tc1",
          toolName: "readMemory",
          input: { path: "memory/nodes/missing.md" },
        },
      ]),
      msg("tool", [
        {
          type: "tool-result",
          toolCallId: "tc1",
          toolName: "readMemory",
          output: "File not found",
          isError: true,
        },
      ]),
    ];
    const result = extractCognition(messages);
    expect(result).toContain("→ error: File not found");
  });

  it("shows ? when a tool-call has no matching result", () => {
    const messages: ModelMessage[] = [
      msg("assistant", [
        {
          type: "tool-call",
          toolCallId: "orphan",
          toolName: "webSearch",
          input: { query: "rust" },
        },
      ]),
      // No tool message with this toolCallId
    ];
    const result = extractCognition(messages);
    expect(result).toContain("→ ?");
  });

  it("combines thinking and tools in one entry", () => {
    const messages: ModelMessage[] = [
      msg("assistant", [
        { type: "reasoning", text: "Let me search for relevant info." },
        {
          type: "tool-call",
          toolCallId: "tc1",
          toolName: "listMemory",
          input: { path: "memory/episodic/" },
        },
      ]),
      msg("tool", [
        {
          type: "tool-result",
          toolCallId: "tc1",
          toolName: "listMemory",
          output: "3 entries",
          isError: false,
        },
      ]),
      msg("assistant", [
        { type: "text", text: "I found 3 relevant files." },
      ]),
    ];
    const result = extractCognition(messages);
    expect(result).toContain("### Thinking");
    expect(result).toContain("### Tools");
    expect(result).toContain("`listMemory`(path: \"memory/episodic/\") → ok");
  });

  it("handles multiple tool calls across multiple assistant/tool message pairs", () => {
    const messages: ModelMessage[] = [
      msg("assistant", [
        { type: "reasoning", text: "Multi-step plan." },
        {
          type: "tool-call",
          toolCallId: "tc1",
          toolName: "listMemory",
          input: { path: "memory/" },
        },
      ]),
      msg("tool", [
        {
          type: "tool-result",
          toolCallId: "tc1",
          toolName: "listMemory",
          output: "ok",
          isError: false,
        },
      ]),
      msg("assistant", [
        {
          type: "tool-call",
          toolCallId: "tc2",
          toolName: "readMemory",
          input: { path: "memory/nodes/x.md" },
        },
      ]),
      msg("tool", [
        {
          type: "tool-result",
          toolCallId: "tc2",
          toolName: "readMemory",
          output: "content",
          isError: false,
        },
      ]),
    ];
    const result = extractCognition(messages);
    // Both tools in order
    const toolsIdx = result.indexOf("### Tools");
    const tc1Idx = result.indexOf("`listMemory`");
    const tc2Idx = result.indexOf("`readMemory`");
    expect(tc1Idx).toBeGreaterThan(toolsIdx);
    expect(tc2Idx).toBeGreaterThan(tc1Idx);
  });
});
