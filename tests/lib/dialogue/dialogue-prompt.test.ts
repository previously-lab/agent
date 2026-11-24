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
    chat.context.source.text = "以后终于能在家睡午觉了。";
    chat.context.priorContext = [{ role: "assistant", text: "记得你提过以前那套房的噪声。" }];
    const handoff = "The user is looking forward to being able to nap at home.";
    const payload = JSON.parse(buildDialoguePrompt(chat, [], handoff));
    expect(payload).toMatchObject({
      sourceInput: { text: chat.context.source.text },
      priorContext: chat.context.priorContext,
      currentTaskContract: { responseMode: "chat", modeGuidance: expect.stringContaining("Let familiar context inform it") },
      event: { kind: "work_update", notes: handoff },
    });
    expect(payload.currentTaskContract.instruction).not.toMatch(/only new information|return empty/i);
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

  it("continues after published answers to this input and lets another input ask the same question", () => {
    const input = runInput();
    input.stage = "final";
    const publication = {
      utteranceId: "spoken", publicSeq: 1, committedAt: "2026-11-07T00:01:00Z", sourceResults: [],
      inputIds: ["input-1"], blocks: [{ kind: "markdown" as const, blockId: "time", text: "下午三点开始。" }],
    };
    input.orchestration = { works: [], offers: [], publications: [publication] };
    const followUp = JSON.parse(buildDialoguePrompt(input, [], "下午三点开始。请从东门进。"));
    expect(followUp.alreadySaid).toEqual(["下午三点开始。"]);
    expect(followUp.currentTaskContract.instruction).toContain("remaining answer or correction");

    input.orchestration.publications = [{ ...publication, inputIds: ["older-input"] }];
    const fresh = JSON.parse(buildDialoguePrompt(input, [], "下午三点开始。"));
    expect(fresh.alreadySaid).toEqual([]);
    expect(fresh.currentTaskContract.instruction).not.toContain("remaining answer");
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
