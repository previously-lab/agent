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
      scopeKey: "scope-1",
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
  it("carries the selected per-input response mode into public wording", () => {
    const chat = runInput();
    chat.responseMode = "chat";
    expect(JSON.parse(buildDialoguePrompt(chat, [], "你好")).currentTaskContract).toMatchObject({
      responseMode: "chat",
      modeGuidance: expect.stringContaining("Do not recap memory"),
    });
    const legacy = JSON.parse(buildDialoguePrompt(runInput(), [], "结果"));
    expect(legacy.currentTaskContract.responseMode).toBe("focused");
    const rewrite = runInput();
    rewrite.responseMode = "rewrite";
    expect(JSON.parse(buildDialoguePrompt(rewrite, [], "改写")).currentTaskContract.modeGuidance).toContain("Transform only the referenced material");
  });

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

  it("presents a work update as an event for the wording layer", () => {
    const parsed = JSON.parse(buildDialoguePrompt(runInput(), [], "普通结果"));
    expect(parsed.event).toEqual({ kind: "work_update", notes: "普通结果" });
    expect(parsed).not.toHaveProperty("result");
  });

  it("keeps other inputs out of the current wording task by default", () => {
    const input = runInput();
    input.orchestration = {
      works: [
        { workId: "work-1", inputId: "input-1", status: "running" },
        { workId: "work-2", inputId: "input-2", status: "running" },
      ],
      offers: [
        { type: "offer", offerId: "work-1:final", runId: "wrun_A", sourceInputId: "input-1", stage: "final", text: "current" },
        { type: "offer", offerId: "work-2:final", runId: "wrun_B", sourceInputId: "input-2", stage: "final", text: "other" },
      ],
      publications: [],
    };
    const parsed = JSON.parse(buildDialoguePrompt(input, [], ""));
    expect(parsed.otherOffers.map((offer: { sourceInputId: string }) => offer.sourceInputId)).toEqual(["input-1"]);
    expect(parsed.currentTaskContract).toMatchObject({ sourceInputId: "input-1", candidateIds: ["work-1:host-read-checkpoint"] });
    expect(parsed.currentTaskContract.instruction).toContain("read-only background");
  });

  it("admits another input only when the publication explicitly aggregates it", () => {
    const input = runInput();
    input.publicationInputIds = ["input-1", "input-2"];
    input.orchestration = {
      works: [],
      offers: [{ type: "offer", offerId: "work-2:final", runId: "wrun_B", sourceInputId: "input-2", stage: "final", text: "grouped" }],
      publications: [],
    };
    const parsed = JSON.parse(buildDialoguePrompt(input, [], ""));
    expect(parsed.otherOffers.map((offer: { sourceInputId: string }) => offer.sourceInputId)).toEqual(["input-2"]);
  });
});
