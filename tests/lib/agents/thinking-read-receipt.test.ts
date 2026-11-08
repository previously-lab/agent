import { describe, expect, it } from "vitest";
import {
  createThinkingReadReceipt,
  substantiveThinkingReadCheckpoint,
  wrapThinkingRead,
  type ThinkingRead,
} from "@/lib/agents/thinking-read-receipt";

const asOf = "2026-11-06T00:00:00.000Z";
const doc = (ref: string, coverage: ThinkingRead["coverage"] = "full", revision: string | null = "bytes-v1"): Omit<ThinkingRead, "evidenceId"> => ({
  ref, sourceKind: "semantic_document", edition: "current", revision, asOf, coverage,
});
const turn = (ref: string, coverage: ThinkingRead["coverage"] = "excerpt"): Omit<ThinkingRead, "evidenceId"> => ({
  ref, sourceKind: "original_turn", edition: "original", revision: "record-v1", asOf, coverage,
  turnId: "u42", role: "user", excerpt: "原始记录说静音车厢更安静。",
});
/** A hand-built envelope (bypasses createThinkingReadReceipt) for malformed-receipt cases. */
function rawWrapped(scopeId: string, toolCallId: string, reads: unknown[]): string {
  return `<!-- PREVIOUSLY_THINKING_READ_V1\n${JSON.stringify({ version: 1, scopeId, toolCallId, reads })}\n-->\n`;
}
/** The returned object must be exactly this safe metadata and nothing else. */
function expectSafeCheckpoint(result: unknown, expected: { kind: "read_completed"; sourceKind: string; evidenceCount: number }, raw: string[]): void {
  expect(result).toEqual(expected);
  expect(Object.keys(result as object).sort()).toEqual(["evidenceCount", "kind", "sourceKind"]);
  const json = JSON.stringify(result);
  for (const leak of raw) expect(json).not.toContain(leak);
}

describe("substantiveThinkingReadCheckpoint", () => {
  it("admits a real recallRead full-coverage wrapped receipt and strips every raw field", () => {
    const ref = "research/audio";
    const excerpt = "A 方案报价更低。";
    const receipt = createThinkingReadReceipt("scope", "read-1", [
      { ...doc(ref), excerpt },
      doc("research/audio-history"),
    ]);
    const output = wrapThinkingRead(receipt, "Observed source body that must not leak");
    const result = substantiveThinkingReadCheckpoint(output, "scope", "recallRead", "read-1");
    expectSafeCheckpoint(result, { kind: "read_completed", sourceKind: "semantic_document", evidenceCount: 2 },
      [ref, "research/audio-history", excerpt, "Observed source body"]);
  });

  it("admits a real recallScenario excerpt receipt from the thinkingReceipt object field", () => {
    const ref = "records/2026-11-05-1329";
    const receipt = createThinkingReadReceipt("scope", "rec-1", [turn(ref)]);
    const output = { answer: "用户当时倾向静音车厢。", thinkingReceipt: receipt };
    const result = substantiveThinkingReadCheckpoint(output, "scope", "recallScenario", "rec-1");
    expectSafeCheckpoint(result, { kind: "read_completed", sourceKind: "original_turn", evidenceCount: 1 },
      [ref, "u42", "静音车厢", "用户当时倾向"]);
  });

  it.each(["outline", "range", "failed", "stale"] as const)("returns null for %s coverage", (coverage) => {
    const read = coverage === "range"
      ? { ...doc("research/audio", "range"), range: { start: 1, end: 5 } }
      : doc("research/audio", coverage);
    const output = wrapThinkingRead(createThinkingReadReceipt("scope", "read-1", [read]), "body");
    expect(substantiveThinkingReadCheckpoint(output, "scope", "recallRead", "read-1")).toBeNull();
  });

  it("returns null for a null source revision", () => {
    const output = wrapThinkingRead(createThinkingReadReceipt("scope", "read-1", [doc("research/audio", "full", null)]), "body");
    expect(substantiveThinkingReadCheckpoint(output, "scope", "recallRead", "read-1")).toBeNull();
  });

  it("requires the exact scope and tool call pairing", () => {
    const output = wrapThinkingRead(createThinkingReadReceipt("scope", "read-1", [doc("research/audio")]), "body");
    expect(substantiveThinkingReadCheckpoint(output, "other-scope", "recallRead", "read-1")).toBeNull();
    expect(substantiveThinkingReadCheckpoint(output, "scope", "recallRead", "read-2")).toBeNull();
  });

  it("never pairs a semantic receipt with recallScenario, an original receipt with recallRead, or either with another tool", () => {
    const semantic = createThinkingReadReceipt("scope", "call-1", [doc("research/audio")]);
    const original = createThinkingReadReceipt("scope", "call-2", [turn("records/2026-11-05-1329")]);
    expect(substantiveThinkingReadCheckpoint({ thinkingReceipt: semantic }, "scope", "recallScenario", "call-1")).toBeNull();
    expect(substantiveThinkingReadCheckpoint(wrapThinkingRead(original, "body"), "scope", "recallRead", "call-2")).toBeNull();
    expect(substantiveThinkingReadCheckpoint(wrapThinkingRead(semantic, "body"), "scope", "webSearch", "call-1")).toBeNull();
    expect(substantiveThinkingReadCheckpoint(wrapThinkingRead(original, "body"), "scope", "viewImage", "call-2")).toBeNull();
  });

  it("requires sequential evidence ids minted by the host", () => {
    const read = { ...doc("research/audio"), evidenceId: "read-1:2" };
    const output = rawWrapped("scope", "read-1", [read]);
    expect(substantiveThinkingReadCheckpoint(output, "scope", "recallRead", "read-1")).toBeNull();
  });

  it("returns null for raw output that never passed through the receipt makers", () => {
    const receipt = createThinkingReadReceipt("scope", "read-1", [doc("research/audio")]);
    expect(substantiveThinkingReadCheckpoint("plain observation text", "scope", "recallRead", "read-1")).toBeNull();
    expect(substantiveThinkingReadCheckpoint(JSON.stringify(receipt), "scope", "recallRead", "read-1")).toBeNull();
    expect(substantiveThinkingReadCheckpoint({ thinkingReceipt: { version: 1 } }, "scope", "recallRead", "read-1")).toBeNull();
    expect(substantiveThinkingReadCheckpoint(42, "scope", "recallRead", "read-1")).toBeNull();
    expect(substantiveThinkingReadCheckpoint(null, "scope", "recallRead", "read-1")).toBeNull();
  });
});
