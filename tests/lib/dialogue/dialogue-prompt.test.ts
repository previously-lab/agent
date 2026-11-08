import { describe, expect, it } from "vitest";
import { buildDialoguePrompt } from "@/lib/dialogue/dialogue-prompt";
import type { DialogueRunInput, DialogueSemanticEvent } from "@/lib/dialogue/transport";

function runInput(event?: DialogueSemanticEvent): DialogueRunInput {
  return {
    offerId: "work-1:host-read-checkpoint",
    publicSeq: 1,
    text: "",
    ...(event ? { event } : {}),
    context: {
      parentRunId: "wrun_01JTESTPARENT0000000000000",
      workId: "work-1",
      sourceInputId: "input-1",
      sourceTurnId: "input-1",
      source: {
        inputId: "input-1", clientMessageId: "message-1", userSeq: 1, eventSeq: 1,
        acceptedAt: "2026-11-07T00:00:00.000Z", text: "给我一个计算器",
      },
      priorContext: [{ role: "user", text: "之前的上下文" }],
      locale: "zh",
      record: {
        useGithub: false, useDemo: false, owner: "local", repo: "local", timezone: "Asia/Shanghai",
        slicing: { idleGapMinutes: 30, maxSliceMinutes: 60, maxTurnsPerSlice: 40 },
        sliceId: "2026-11-07-0000",
      },
    },
  };
}

describe("buildDialoguePrompt semantic event field", () => {
  it("carries an explicit needs_user event without a prose result", () => {
    const event: DialogueSemanticEvent = {
      kind: "needs_user", needsUser: { kind: "decision", detail: "选 A 方案还是 B 方案？" },
    };
    const parsed = JSON.parse(buildDialoguePrompt(runInput(event), [], ""));
    expect(parsed.event).toEqual(event);
    expect(parsed).not.toHaveProperty("result");
  });

  it("uses only the semantic event when the host supplies one", () => {
    const parsed = JSON.parse(buildDialoguePrompt(
      runInput({ kind: "read_completed", sourceKind: "semantic_document", evidenceCount: 3 }),
      [], "阶段性结论",
    ));
    expect(Object.keys(parsed.event).sort()).toEqual(["evidenceCount", "kind", "sourceKind"]);
    expect(parsed.event).toEqual({ kind: "read_completed", sourceKind: "semantic_document", evidenceCount: 3 });
    expect(JSON.stringify(parsed)).not.toContain("阶段性结论");
  });

  it("presents offerReply notes as an event for the wording layer", () => {
    const parsed = JSON.parse(buildDialoguePrompt(runInput(), [], "普通结果"));
    expect(parsed.event).toEqual({ kind: "offer_reply", notes: "普通结果" });
    expect(parsed).not.toHaveProperty("result");
  });
});
