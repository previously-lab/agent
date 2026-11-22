import { describe, expect, it } from "vitest";
import { parseWorkUpdateEvent, projectWorkSnapshot, workUpdateAsDialogueCandidate, type WorkUpdateEvent } from "@/lib/dialogue/work-contract";

const checkpoint: WorkUpdateEvent = {
  type: "work_checkpoint", updateId: "work:progress-1", runId: "wrun_A", sourceInputId: "input-A", workId: "work-A",
  acceptedAt: "2026-11-16T00:00:01.000Z", text: "已核实百度成立时间，正在查原始来源。",
  relation: "related", dependsOnInputIds: ["input-B"],
};
const completed: WorkUpdateEvent = {
  type: "work_completed", updateId: "work:final", runId: "wrun_A", sourceInputId: "input-A", workId: "work-A",
  acceptedAt: "2026-11-16T00:00:05.000Z", text: "百度成立于 2000 年。",
  relation: "related", dependsOnInputIds: ["input-B"], responseMode: "focused",
};

describe("work-only event and snapshot contract", () => {
  it("validates work events without treating relations as ownership changes", () => {
    expect(parseWorkUpdateEvent(checkpoint)).toEqual(checkpoint);
    expect(parseWorkUpdateEvent(completed)).toEqual(completed);
    expect(parseWorkUpdateEvent({ ...checkpoint, relation: "takeover" })).toBeNull();
    expect(parseWorkUpdateEvent({ ...completed, responseMode: "takeover" })).toBeNull();
    expect(parseWorkUpdateEvent({ ...checkpoint, sourceInputId: "" })).toBeNull();
  });

  it("adapts work updates for the Actor without producing new offers", () => {
    expect(workUpdateAsDialogueCandidate(checkpoint)).toMatchObject({
      type: "offer", offerId: checkpoint.updateId, stage: "checkpoint", relation: "related",
      sourceInputId: "input-A", workId: "work-A",
    });
    expect(workUpdateAsDialogueCandidate(completed)).toMatchObject({ stage: "final", text: completed.text, responseMode: "focused" });
  });

  it("projects public progress and completion, not private reasoning", () => {
    const snapshot = projectWorkSnapshot({
      workId: "work-A", inputId: "input-A", runId: "wrun_A", status: "completed",
      acceptedAt: "2026-11-16T00:00:00.000Z", updates: [checkpoint, completed],
    });
    expect(snapshot).toMatchObject({
      latestStage: "completed", completedUpdateId: "work:final", relation: "related",
      dependsOnInputIds: ["input-B"], updatedAt: completed.acceptedAt,
    });
    expect(snapshot.publicHandoffs.map(handoff => handoff.stage)).toEqual(["checkpoint", "completed"]);
    expect(JSON.stringify(snapshot)).not.toContain("private reasoning");
  });

  it("keeps a pending checkpoint distinct from a completed result", () => {
    const snapshot = projectWorkSnapshot({
      workId: "work-A", inputId: "input-A", runId: "wrun_A", status: "running",
      acceptedAt: "2026-11-16T00:00:00.000Z", updates: [checkpoint],
    });
    expect(snapshot.latestStage).toBe("checkpoint");
    expect(snapshot.completedUpdateId).toBeUndefined();
  });

  it("keeps each finding's uncertainty when another work reads the snapshot", () => {
    const event: Extract<WorkUpdateEvent, { type: "work_completed" }>["event"] = { kind: "findings", findings: [
      { kind: "user_report", text: "The committee chose diffuse light.", uncertainty: "The record does not name the deciding member." },
      { kind: "user_report", text: "The stage crew took the lightbox assignment." },
    ] };
    const snapshot = projectWorkSnapshot({
      workId: completed.workId, inputId: completed.sourceInputId, runId: completed.runId, status: "completed",
      acceptedAt: completed.acceptedAt, updates: [{ ...completed, event }],
    });
    expect(snapshot.publicHandoffs.map(handoff => handoff.text)).toEqual([
      "The committee chose diffuse light.\nThe record does not name the deciding member.",
      "The stage crew took the lightbox assignment.",
    ]);
  });
});
