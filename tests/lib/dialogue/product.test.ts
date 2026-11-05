import { describe, expect, it } from "vitest";
import type { ModelMessage } from "@/lib/deepseek/types";
import type { ThinkingClaim, ThinkingProduct } from "@/lib/agents/thinking-product";
import type { ThinkingRead } from "@/lib/agents/thinking-read-receipt";
import { buildWorkContextSection, dialogueClaimsFromProduct, draftBlocksFromWorkText, extractThinkingReport } from "@/lib/dialogue/product";
import type { DialogueInput, PublicUtterance } from "@/lib/chat/dialogue-contract";

const read = (over: Partial<ThinkingRead>): ThinkingRead => ({
  evidenceId: "call:1", ref: "records/2026-11-06-0000", sourceKind: "original_turn",
  revision: "abc123", asOf: "2026-11-06T00:00:00.000Z", coverage: "full", ...over,
});

const claim = (over: Partial<ThinkingClaim>): ThinkingClaim => ({
  claimId: "claim-1", text: "A finding.", kind: "interpretation", allowedPublicMode: "finding",
  evidenceIds: [], requiredReadRefs: [], missingReadRefs: [], adoptionEvidenceIds: [], ...over,
});

function product(claims: ThinkingClaim[], reads: ThinkingRead[] = []): ThinkingProduct {
  return {
    version: 1, inputScope: { scopeKey: "scope", workId: "work-1", inputIds: ["input-1"] },
    sourceRevision: null, asOf: "2026-11-06T00:00:00.000Z", status: "complete",
    claims, readSet: reads, dependencies: [], openQuestions: [],
  };
}

describe("dialogueClaimsFromProduct", () => {
  it("drops blocked claims and projects evidence from the immutable read set", () => {
    const claims = dialogueClaimsFromProduct(product([
      claim({ claimId: "ok", evidenceIds: ["call:1"], text: "Sourced." }),
      claim({ claimId: "blocked", allowedPublicMode: "none", text: "Not for the public." }),
      claim({ claimId: "status", allowedPublicMode: "status", kind: "status", text: "Working on it." }),
    ], [read({ evidenceId: "call:1", coverage: "full" })]));
    expect(claims.map((entry) => entry.claimId)).toEqual(["ok", "status"]);
    expect(claims[0]?.evidence).toEqual([{ ref: "records/2026-11-06-0000", sourceRevision: "abc123",
      asOf: "2026-11-06T00:00:00.000Z", coverage: "complete" }]);
  });

  it("maps partial coverage honestly and attaches reusable artifact block ids only when present", () => {
    const claims = dialogueClaimsFromProduct(product([
      claim({ evidenceIds: ["call:1"] }),
    ], [read({ coverage: "outline" })]), ["work-1:artifact-1"]);
    expect(claims[0]?.evidence[0]?.coverage).toBe("partial");
    expect(claims[0]?.blockIds).toEqual(["work-1:artifact-1"]);
    expect(dialogueClaimsFromProduct(product([claim({})]))[0]?.blockIds).toBeUndefined();
  });
});

describe("draftBlocksFromWorkText", () => {
  it("keeps plain prose in one markdown block", () => {
    const { blocks, artifactBlockIds } = draftBlocksFromWorkText("work-1", "Just an answer.");
    expect(blocks).toEqual([{ kind: "markdown", blockId: "work-1:text", text: "Just an answer." }]);
    expect(artifactBlockIds).toEqual([]);
  });

  it("mints a host-owned artifact source for a complete native document and strips it from prose", () => {
    const html = "<!doctype html>\n<html><body><script>window.x = 1</script></body></html>\n";
    const fenced = `Before.\n\n\`\`\`html live\n${html}\`\`\`\n\nAfter.`;
    const { blocks, artifactBlockIds } = draftBlocksFromWorkText("work-1", fenced);
    expect(artifactBlockIds).toEqual(["work-1:artifact-1"]);
    expect(blocks).toHaveLength(2);
    const artifact = blocks.find((block) => block.kind === "artifact_source");
    expect(artifact).toMatchObject({ kind: "artifact_source", blockId: "work-1:artifact-1", artifactKind: "native_html", mediaType: "text/html", body: html });
    const prose = blocks.find((block) => block.kind === "markdown");
    expect(prose?.kind === "markdown" ? prose.text : "").not.toContain("<script>");
    expect(prose?.kind === "markdown" ? prose.text : "").toContain("[interactive artifact #1]");
  });
});

describe("buildWorkContextSection", () => {
  const input = (inputId: string, userSeq: number, text: string): DialogueInput => ({
    inputId, clientMessageId: `msg-${inputId}`, userSeq, eventSeq: userSeq, acceptedAt: "2026-11-06T00:00:00.000Z", text,
  });

  it("fences the server window: own input, other recent inputs, pending and the public prefix", () => {
    const section = buildWorkContextSection({
      scopeKey: "scope", workId: "work-2", ownInputId: "input-2",
      inputs: [input("input-1", 1, "Choose an apple."), input("input-2", 2, "Compare speakers."), input("input-3", 3, "Late note.")],
      pending: [{ workId: "work-3", inputId: "input-3", userSeq: 3, status: "queued" }],
      publications: [{
        utteranceId: "round:1", publicSeq: 1, committedAt: "2026-11-06T00:01:00.000Z",
        inputIds: ["input-1"], sourceResults: [], blocks: [{ kind: "markdown", blockId: "u1:text", text: "Apple noted." }],
      } satisfies PublicUtterance],
      firstRecentUserSeq: 1,
    });
    expect(section).toContain("[Dialogue context");
    const payload = JSON.parse(section.slice(section.indexOf("{"), section.lastIndexOf("}") + 1));
    expect(payload.ownInput.inputId).toBe("input-2");
    expect(payload.otherRecentInputs.map((entry: { inputId: string }) => entry.inputId)).toEqual(["input-1", "input-3"]);
    expect(payload.otherRecentInputs.find((entry: { inputId: string }) => entry.inputId === "input-3").pending).toBe(true);
    expect(payload.pending).toEqual([{ workId: "work-3", inputId: "input-3", userSeq: 3, status: "queued" }]);
    expect(payload.alreadyPublic[0].text).toBe("Apple noted.");
  });
});

describe("extractThinkingReport", () => {
  it("takes the last finishThinking tool-call input", () => {
    const messages: ModelMessage[] = [
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "c1", toolName: "finishThinking", input: { findings: [{ text: "First", kind: "status" }] } }] },
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "c2", toolName: "finishThinking", input: { findings: [{ text: "Final", kind: "observation" }] } }] },
      { role: "assistant", content: "plain" },
    ];
    expect(extractThinkingReport(messages)).toEqual({ findings: [{ text: "Final", kind: "observation" }] });
    expect(extractThinkingReport([{ role: "user", content: "hi" }])).toBeUndefined();
  });
});
