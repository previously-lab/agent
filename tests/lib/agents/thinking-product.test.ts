import { describe, expect, it } from "vitest";
import type { ModelMessage } from "@/lib/deepseek/types";
import { buildThinkingProduct, permitsThinkingClaim, thinkingExpressionClaims, type ThinkingInputScope } from "@/lib/agents/thinking-product";
import { createThinkingReadReceipt, wrapThinkingRead, type ThinkingRead } from "@/lib/agents/thinking-read-receipt";

const asOf = "2026-11-06T00:00:00.000Z";
const inputScope: ThinkingInputScope = { scopeKey: "fixture", workId: "work", inputIds: ["u1"],
  inputText: "新房是 B 户型。", readScopeId: "scope", locale: "zh" };
const doc = (ref: string, coverage: ThinkingRead["coverage"] = "full", revision: string | null = "bytes-v1") => ({
  ref, sourceKind: "semantic_document" as const, edition: "current" as const, revision, asOf, coverage,
});
function returned(read: Omit<ThinkingRead, "evidenceId">, callId = "read", scope = "scope", toolName = "recallRead"): ModelMessage[] {
  return [{ role: "assistant", content: [{ type: "tool-call", toolCallId: callId, toolName, input: { ref: read.ref } }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId: callId, toolName,
      output: { type: "text", value: wrapThinkingRead(createThinkingReadReceipt(scope, callId, [read]), "Observed source") } }] }];
}

describe("一期 thinking claim admission", () => {
  it("keeps a simple reply short without a report or an invented memory write", () => {
    const product = buildThinkingProduct({ text: "没问题", messages: [], inputScope, asOf });
    expect(product.claims).toMatchObject([{ text: "没问题", kind: "conversation", allowedPublicMode: "finding" }]);
    expect(product.memoryDelta).toBeUndefined();
  });

  it.each(["outline", "range", "failed", "stale"] as const)("does not release a bound project claim on %s, even with model-declared empty or independent deps", (coverage) => {
    const product = buildThinkingProduct({ text: "", messages: returned(doc("research/new-home", coverage)),
      inputScope: { ...inputScope, entityRefs: ["research/new-home"] }, asOf,
      report: { findings: [{ text: "The old measurements fit.", kind: "project_fact", requiredReadRefs: [], scopeId: "independent", evidenceIds: ["read:1"] },
        { text: "新房是 B 户型。", kind: "user_report" }] } });
    expect(product.status).toBe("incomplete");
    expect(permitsThinkingClaim(product, "claim-1", "finding")).toBe(false);
    expect(thinkingExpressionClaims(product).map((claim) => claim.text)).toEqual(["新房是 B 户型。", "相关依据还没核实。"]);
  });

  it("releases an independently scoped and genuinely read finding without waiting for another project", () => {
    const product = buildThinkingProduct({ text: "", messages: returned(doc("research/audio")), asOf,
      inputScope: { ...inputScope, independentScopes: [{ id: "audio", refs: ["research/audio"] }] },
      dependencies: [{ ref: "research/new-home", scopeId: "home" }, { ref: "research/audio", scopeId: "audio" }],
      report: { findings: [{ text: "Audio options are compared in the study.", kind: "observation", scopeId: "audio", evidenceIds: ["read:1"] },
        { text: "The new home's dimensions are settled.", kind: "project_fact", scopeId: "home", evidenceIds: ["read:1"] }] } });
    expect(product.status).toBe("incomplete");
    expect(permitsThinkingClaim(product, "claim-1", "finding")).toBe(true);
    expect(permitsThinkingClaim(product, "claim-2", "finding")).toBe(false);
  });

  it("does not let an original case index satisfy a default current dependency when current is stale", () => {
    const ref = "research/new-home";
    const messages = [
      ...returned({ ...doc(ref, "full", "index-v1"), edition: "original" }, "index"),
      ...returned({ ...doc(ref, "stale", "current-v1"), edition: "current" }, "current"),
    ];
    const product = buildThinkingProduct({ text: "", messages, asOf,
      inputScope: { ...inputScope, entityRefs: [ref] },
      report: { findings: [{ text: "The current dimensions are settled.", kind: "project_fact",
        evidenceIds: ["index:1", "current:1"] }] } });
    expect(product.claims[0]).toMatchObject({ allowedPublicMode: "none", missingReadRefs: [ref] });
    expect(permitsThinkingClaim(product, "claim-1", "finding")).toBe(false);
  });

  it("still permits a claim explicitly bound to the original index edition", () => {
    const ref = "research/new-home";
    const product = buildThinkingProduct({ text: "", asOf,
      messages: returned({ ...doc(ref, "full", "index-v1"), edition: "original" }),
      inputScope: { ...inputScope, entityRefs: [ref] }, dependencies: [{ ref, edition: "original" }],
      report: { findings: [{ text: "The original overview lists two options.", kind: "historical_fact",
        evidenceIds: ["read:1"] }] } });
    expect(permitsThinkingClaim(product, "claim-1", "finding")).toBe(true);
  });

  it("requires the selected edition, turn and role, and never takes an assistant quote as adoption", () => {
    const ref = "records/2026-11-05-1329";
    const messages = returned({ ref, sourceKind: "original_turn", edition: "original", coverage: "excerpt", asOf,
      revision: "record-v1", turnId: "u42", role: "assistant", excerpt: "I suggest it." }, "recall", "scope", "recallScenario");
    const product = buildThinkingProduct({ text: "", messages, asOf,
      inputScope: { ...inputScope, documentContext: [{ ref, turnId: "u42", role: "user" }] },
      report: { findings: [{ text: "The user decided.", kind: "historical_fact", decision: "confirmed",
        evidenceIds: ["recall:1"], adoptionEvidenceIds: ["recall:1"] }] } });
    expect(product.claims[0]).toMatchObject({ allowedPublicMode: "none", missingReadRefs: [ref], adoptionEvidenceIds: [] });
  });

  it("ignores a different attempt, duplicates, and source revisions that moved", () => {
    const ref = "research/new-home";
    const foreign = returned(doc(ref), "foreign", "other-work");
    const duplicate = returned(doc(ref), "same");
    const product = buildThinkingProduct({ text: "The old result applies", messages: [...foreign, ...duplicate, ...duplicate,
      ...returned(doc(ref), "valid-old")], inputScope, dependencies: [{ ref, revision: "bytes-v2" }], asOf });
    expect(product.readSet.map((read) => read.evidenceId)).toEqual(["valid-old:1"]);
    expect(permitsThinkingClaim(product, "claim-1", "finding")).toBe(false);
  });
});
