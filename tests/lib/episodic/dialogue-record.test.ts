import { describe, expect, it } from "vitest";
import {
  dialogueResearchMaterialId,
  dialogueSourceTurnId,
  selectDialogueResearchProducts,
  type DialogueResearchRecord,
} from "@/lib/episodic/dialogue-record";

function research(resultId: string, productRevision: number): DialogueResearchRecord {
  return {
    kind: "research_result", resultId, productRevision, workId: `work-${resultId}`,
    inputIds: ["input-1"], sourceTurnId: "u1", asOf: "2026-11-06T03:00:00.000Z",
    sourceRevision: null, status: "complete", artifacts: [],
    delta: { readerQuestion: "What changed?", newInformation: `Revision ${productRevision}`,
      targetRefs: [], claims: [{ claimId: "claim-1", text: "Bounded finding", kind: "observation", sources: [] }] },
  };
}

describe("exact dialogue reflection material", () => {
  it("binds material to its source turn and immutable result version", () => {
    const record = research("result/a one", 1);
    const material = dialogueResearchMaterialId(record);
    expect(material).toBe("u1@research:result%2Fa%20one:1");
    expect(dialogueSourceTurnId(material)).toBe("u1");
    expect(dialogueSourceTurnId("legacy-turn")).toBe("legacy-turn");
  });

  it("selects an owed old version without silently substituting the newer one", () => {
    const v1 = research("result-a", 1);
    const v2 = research("result-a", 2);
    const other = research("result-b", 1);
    const records = [v2, other, v1];
    expect(selectDialogueResearchProducts(records, [dialogueResearchMaterialId(v1)])).toEqual([v1]);
    expect(selectDialogueResearchProducts(records,
      [dialogueResearchMaterialId(v1), dialogueResearchMaterialId(v2)])).toEqual([v1, v2]);
  });

  it("keeps legacy turn wakes compatible and ignores records without a delta", () => {
    const v1 = research("result-a", 1);
    const v2 = research("result-a", 2);
    const other = research("result-b", 1);
    const withoutDelta = { ...research("result-c", 1), delta: undefined };
    expect(selectDialogueResearchProducts([v1, withoutDelta, other, v2], ["u1"])).toEqual([v2, other]);
  });
});
