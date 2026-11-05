import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelRequest } from "@/lib/deepseek/types";
import type { DialogueArtifactRef } from "@/lib/chat/dialogue-contract";
import type { ExpressionSnapshot } from "@/lib/dialogue/types";
import { requestDeepSeek } from "@/lib/deepseek/http";
import { buildExpressionContext, composeExpression } from "@/lib/dialogue/expression";

vi.mock("@/lib/deepseek/http", () => ({ requestDeepSeek: vi.fn() }));

const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, reasoningTokens: 0, cachedInputTokens: 0, uncachedInputTokens: 0 };
const artifact: DialogueArtifactRef = {
  artifactId: "artifact-original", sourceOwnerId: "work-one:1", revision: 1,
  sha256: "a".repeat(64), byteSize: 99, kind: "native_html", mediaType: "text/html", summary: "Offline calculator",
};

function snapshot(): ExpressionSnapshot {
  return {
    inputHighWater: 1, publicHighWater: 0, wakeVersion: 1, firstRecentUserSeq: 1,
    inputs: [{ inputId: "input-one", clientMessageId: "message-one", userSeq: 1, eventSeq: 1,
      acceptedAt: "2026-11-06T00:00:00.000Z", text: "Show the offline calculator." }],
    pending: [], publications: [],
    results: [{
      resultId: "work-one:1", productRevision: 1, workId: "work-one", inputIds: ["input-one"],
      producerRunId: "mock-run", sliceId: "2026-11-06-0000", availableAt: "2026-11-06T00:00:00.000Z",
      product: { version: 1, inputScope: { scopeKey: "fixture", workId: "work-one", inputIds: ["input-one"] },
        sourceRevision: null, asOf: "2026-11-06T00:00:00.000Z", status: "complete", readSet: [], dependencies: [], openQuestions: [],
        claims: [{ claimId: "supported", text: "Use the calculator.", kind: "observation", allowedPublicMode: "finding",
          evidenceIds: [], requiredReadRefs: [], missingReadRefs: [], adoptionEvidenceIds: [] }] },
      claims: [{ claimId: "supported", text: "Use the calculator.", allowedPublicMode: "finding", evidence: [], blockIds: ["calculator"] }],
      blocks: [{ kind: "artifact_ref", blockId: "calculator", artifact }],
    }],
  };
}

beforeEach(() => { vi.mocked(requestDeepSeek).mockReset(); });

describe("expression artifact projection", () => {
  it("sends only the stable artifact reference to a mocked model and preserves its block id", async () => {
    const rawHtml = "<!doctype html>\r\n<html><body><script>window.originalArtifact = 'do-not-read'</script></body></html>\r\n";
    const embedded = "data:text/html;base64,PHNjcmlwdD53aW5kb3cub3JpZ2luYWxBcnRpZmFjdDwvc2NyaXB0Pg==";
    const input = snapshot();
    // Extra persisted bytes must not leak even if an adapter accidentally
    // leaves them beside an otherwise valid reference.
    Object.assign(artifact, { body: rawHtml });
    input.results[0]!.claims[0]!.text += `\n${embedded}`;
    let captured: ModelRequest | undefined;
    vi.mocked(requestDeepSeek).mockImplementation(async (request) => {
      captured = request;
      return { message: { role: "assistant", content: JSON.stringify({
        sends: [{ text: "Here is the calculator.", sources: [{ resultId: "work-one:1", productRevision: 1,
          claimId: "supported", mode: "finding" }], blockIds: ["calculator"] }], decisions: [],
      }) }, toolCalls: [], finishReason: "stop", usage };
    });

    const plan = await composeExpression(input, "mock-expression");
    expect(captured).toBeDefined();
    const payload = JSON.stringify(captured);
    expect(payload).toContain("artifact-original");
    expect(payload).toContain("calculator");
    expect(payload).not.toContain("window.originalArtifact");
    expect(payload).not.toContain("do-not-read");
    expect(payload).not.toContain("base64,");
    expect(payload).not.toContain("<script>");
    expect(plan.sends[0]?.blockIds).toEqual(["calculator"]);
    expect(buildExpressionContext(input)).not.toContain(rawHtml);
  });

  it("completes with silence without a model round when no claim is publishable", async () => {
    const input = snapshot();
    input.results[0]!.claims = [];
    await expect(composeExpression(input, "mock-silence")).resolves.toEqual({ sends: [], decisions: [] });
    expect(requestDeepSeek).not.toHaveBeenCalled();
  });
});
