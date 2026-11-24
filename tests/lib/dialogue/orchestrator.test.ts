import { describe, expect, it } from "vitest";
import type { PublicUtterance } from "@/lib/chat/dialogue-contract";
import type { DialogueOfferEvent } from "@/lib/dialogue/transport";
import { DIALOGUE_SESSION_MS, dialogueRunUsable, selectDialogueOffer } from "@/lib/dialogue/orchestrator";

function offer(id: string, stage: "checkpoint" | "final", inputId = "input-A", workId = inputId): DialogueOfferEvent {
  return {
    type: "offer", offerId: id, runId: "wrun_TEST", sourceInputId: inputId, workId,
    stage, publicSeq: 1, text: id,
  };
}

function publication(id: string, phase: "commentary" | "final_answer", inputIds = ["input-A"]): PublicUtterance {
  return {
    utteranceId: id,
    publicSeq: 1,
    committedAt: "2026-11-15T00:00:00.000Z",
    inputIds,
    sourceResults: [{ resultId: id, productRevision: 1, claimIds: [] }],
    blocks: [{ kind: "markdown", blockId: `${id}:text`, text: id }],
    phase,
  };
}

describe("dialogue orchestrator selection", () => {
  it("prefers a final result and retires an unpublished older checkpoint", () => {
    const selected = selectDialogueOffer({
      offers: [offer("opening", "checkpoint"), offer("result", "final")],
      publications: [],
    });
    expect(selected?.offerId).toBe("result");
  });

  it("does not replay an offer already present in publication sources", () => {
    const selected = selectDialogueOffer({
      offers: [offer("opening", "checkpoint")],
      publications: [publication("opening", "commentary")],
    });
    expect(selected).toBeUndefined();
  });

  it("retires an old checkpoint once the final answer is already public", () => {
    const selected = selectDialogueOffer({
      offers: [offer("opening", "checkpoint"), offer("result", "final")],
      publications: [publication("result", "final_answer")],
    });
    expect(selected).toBeUndefined();
  });

  it("never replays a stale checkpoint after publishing a newer one from the same work", () => {
    const older = { ...offer("z-first", "checkpoint"), publicSeq: 1 };
    const newer = { ...offer("a-second", "checkpoint"), publicSeq: 2 };
    const other = offer("independent-first", "checkpoint", "input-B");
    expect(selectDialogueOffer({ offers: [newer, older], publications: [] })?.offerId).toBe("a-second");
    expect(selectDialogueOffer({ offers: [other, newer, older], publications: [publication("a-second", "commentary")] })?.offerId)
      .toBe("independent-first");
  });

  it("skips cancelled checkpoints and finals across Actor restarts while independent work continues", () => {
    const works = [{ status: "cancelled", runId: "parentA", workId: "work-A", inputId: "input-A" }];
    const old = { ...offer("A-old", "checkpoint", "input-A", "work-A"), parentRunId: "parentA" };
    const final = { ...offer("A-final", "final", "input-A", "work-A"), parentRunId: "parentA" };
    const active = { ...offer("B-next", "checkpoint", "input-B", "work-B"), parentRunId: "parentB" };
    expect(selectDialogueOffer({ offers: [old, final], works, publications: [] })).toBeUndefined();
    expect(selectDialogueOffer({ offers: [old, final, active], works, publications: [] })).toBe(active);
  });

  it("skips handled events and continues with another independent result", () => {
    const selected = selectDialogueOffer({
      offers: [offer("A-final", "final"), offer("B-final", "final", "input-B", "work-B")],
      publications: [publication("A-final", "final_answer")],
    });
    expect(selected?.offerId).toBe("B-final");
  });
});

describe("dialogue run time window", () => {
  const now = Date.parse("2026-11-15T01:00:00.000Z");
  it("allows a live run only inside the 30 minute window", () => {
    expect(dialogueRunUsable("running", new Date(now - DIALOGUE_SESSION_MS + 1).toISOString(), now)).toBe(true);
    expect(dialogueRunUsable("running", new Date(now - DIALOGUE_SESSION_MS - 1).toISOString(), now)).toBe(false);
  });

  it("never resumes completed, expired or undated runs", () => {
    expect(dialogueRunUsable("completed", new Date(now - 1).toISOString(), now)).toBe(false);
    expect(dialogueRunUsable("running", undefined, now)).toBe(false);
    expect(dialogueRunUsable("running", "invalid", now)).toBe(false);
  });
});

it("lets a fresh independent final publish ahead of a previous unsuccessful delivery", () => {
  const state = { offers: [offer("A", "final"), offer("B", "final", "input-B", "work-B")], publications: [],
    dialogueRuns: [{ runId: "old", sessionId: "session", status: "completed", createdAt: "",
      events: [{ type: "expression_outcome" as const, status: "failed" as const, candidateIds: ["A"], inputIds: ["input-A"], planId: "A" }] }] };
  expect(selectDialogueOffer(state)?.offerId).toBe("B");
  expect(selectDialogueOffer(state, new Set(["B"]))?.offerId).toBe("A");
});
