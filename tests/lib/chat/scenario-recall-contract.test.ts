import { describe, expect, it } from "vitest";
import {
  canonicalConversationRecordRef,
  mediateReplayedRecordReads,
} from "@/lib/chat/scenario-recall-contract";
import { fromNativeAssistant, toNativeMessages } from "@/lib/deepseek/messages";
import type { ModelMessage } from "@/lib/deepseek/types";

const RECORD_REF = "records/2026-10-20-0930";

describe("conversation record reference classification", () => {
  it.each([
    RECORD_REF,
    `/${RECORD_REF}`,
    `previously:${RECORD_REF}`,
    "《records/2026-10-20-0930.md》",
    "memory/records/2026/10/20/0930/core.md",
    "/memory/records/2026/10/20/0930/agent.md",
    ["memory", "episodic", "slices", "2026", "10", "20", "0930", "timeline", "core.md"].join(String.fromCharCode(92)),
  ])("canonicalizes %s without exposing a read path", (ref) => {
    expect(canonicalConversationRecordRef(ref)).toBe(RECORD_REF);
  });

  it("does not classify semantic documents as conversations", () => {
    expect(canonicalConversationRecordRef("research/departure")).toBeNull();
    expect(canonicalConversationRecordRef("people/user/profile")).toBeNull();
  });
});

describe("native and structured replay mediation", () => {
  it("removes old raw record reads from the actual provider conversion path", () => {
    const sentinel = "RAW_RECORD_SENTINEL_NEVER_REPLAY";
    const assistant = fromNativeAssistant({
      role: "assistant",
      content: "",
      tool_calls: [{
        id: "record-call",
        type: "function",
        function: { name: "recallRead", arguments: JSON.stringify({ ref: "memory/records/2026/10/20/0930/core.md" }) },
      }],
    });
    const tool: ModelMessage = {
      role: "tool",
      content: [{ type: "tool-result", toolCallId: "record-call", toolName: "recallRead", output: { type: "text", value: sentinel } }],
      deepseek: { role: "tool", tool_call_id: "record-call", content: sentinel },
    };
    const mediated = mediateReplayedRecordReads([assistant, tool]);
    const provider = toNativeMessages(mediated);
    expect(JSON.stringify(mediated)).not.toContain(sentinel);
    expect(JSON.stringify(provider)).not.toContain(sentinel);
    expect(provider.at(-1)?.content).toContain("recallScenario_required");
    expect(provider.at(-1)?.content).toContain(RECORD_REF);
  });

  it("replaces only record rows in replayed mixed search output and preserves live chat", () => {
    const recordSentinel = "RAW_SEARCH_SENTINEL_NEVER_REPLAY";
    const semanticSentinel = "SEMANTIC_SEARCH_EXCERPT_KEEP";
    const output = [
      `2 match(es) for "departure":`,
      `- [2026-10-20] Derived focus — ${recordSentinel} (ref: ${RECORD_REF})`,
      `- [2026-10-19] Departure research — ${semanticSentinel} (ref: research/departure)`,
    ].join("\n");
    const assistant = fromNativeAssistant({
      role: "assistant",
      content: "Visible assistant answer stays intact",
      tool_calls: [{
        id: "search-call",
        type: "function",
        function: { name: "recallSearch", arguments: JSON.stringify({ query: "departure", includeRecords: true }) },
      }],
    });
    const tool: ModelMessage = {
      role: "tool",
      content: [{ type: "tool-result", toolCallId: "search-call", toolName: "recallSearch", output: { type: "text", value: output } }],
      deepseek: { role: "tool", tool_call_id: "search-call", content: output },
    };
    const user: ModelMessage = { role: "user", content: "Current live chat stays intact" };
    const mediated = mediateReplayedRecordReads([user, assistant, tool]);
    const providerText = JSON.stringify(toNativeMessages(mediated));
    expect(JSON.stringify(mediated)).not.toContain(recordSentinel);
    expect(providerText).not.toContain(recordSentinel);
    expect(providerText).toContain(semanticSentinel);
    expect(providerText).toContain("Original conversation");
    expect(providerText).toContain("Current live chat stays intact");
    expect(providerText).toContain("Visible assistant answer stays intact");
  });

  it("leaves semantic document replay unchanged", () => {
    const messages: ModelMessage[] = [
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "doc", toolName: "recallRead", input: { ref: "research/departure" } }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "doc", toolName: "recallRead", output: { type: "text", value: "Semantic original" } }] },
    ];
    expect(mediateReplayedRecordReads(messages)).toEqual(messages);
    expect(toNativeMessages(mediateReplayedRecordReads(messages)).at(-1)?.content).toBe("Semantic original");
  });
});
