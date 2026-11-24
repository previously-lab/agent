import { describe, expect, it } from "vitest";
import {
  dialogueCandidateFailed,
  dialogueHeartbeatAt,
  dialogueOpeningHandled,
  responsibleDialogueRun,
  sessionLastWakeAt,
  type DialogueRunState,
} from "@/lib/dialogue/coordination";
import { dialogueRunStale } from "@/lib/dialogue/orchestrator";
import type { DialogueWakeEvent } from "@/lib/dialogue/transport";

function run(id: string, events: DialogueRunState["events"] = [], status = "running"): DialogueRunState {
  return { runId: id, status, createdAt: "2026-11-15T00:00:00.000Z", sessionId: "session", events };
}

describe("dialogue responsibility and lease state", () => {
  it("follows continued and delegated edges to the actual responsible run", () => {
    const old = run("old", [{ type: "continued", nextRunId: "successor" }], "completed");
    const successor = run("successor", [{ type: "delegated", holderRunId: "holder" }], "completed");
    const holder = run("holder", [{ type: "lease_acquired", at: "2026-11-15T00:01:00.000Z" }]);
    const runs = new Map([old, successor, holder].map(item => [item.runId, item]));
    expect(responsibleDialogueRun(old, runs).runId).toBe("holder");
  });

  it("rejects a responsibility cycle instead of spinning forever", () => {
    const a = run("a", [{ type: "continued", nextRunId: "b" }], "completed");
    const b = run("b", [{ type: "delegated", holderRunId: "a" }], "completed");
    expect(() => responsibleDialogueRun(a, new Map([a, b].map(item => [item.runId, item])))).toThrow("responsibility cycle");
  });

  it("uses pending creation time and the latest handoff heartbeat", () => {
    const pending = run("pending");
    expect(dialogueHeartbeatAt(pending)).toBe(pending.createdAt);
    const waiting = run("waiting", [{ type: "handoff_wait", waitingForRunId: "old", at: "2026-11-15T00:02:00.000Z" }]);
    expect(dialogueHeartbeatAt(waiting)).toBe("2026-11-15T00:02:00.000Z");
  });

  it("computes the session wake window from events rather than publication time", () => {
    const wake: DialogueWakeEvent = {
      type: "dialogue_wake", runId: "dialogue", parentRunId: "wrun_THOUGHT", sourceInputId: "input", workId: "work",
      sessionId: "session", triggerKey: "trigger", candidateKeys: ["candidate"],
      wakeAt: "2026-11-15T00:30:00.000Z", reused: true,
    };
    expect(sessionLastWakeAt(run("dialogue"), [wake])).toBe("2026-11-15T00:30:00.000Z");
  });

  it("expects progress after the first wake addressed to a sleeping Actor", () => {
    const start = "2026-11-15T00:00:00.000Z";
    const idle = run("holder", [{ type: "exit_intent", at: start, keys: [] }]);
    const wake: DialogueWakeEvent = {
      type: "dialogue_wake", runId: "holder", parentRunId: "thinking", sourceInputId: "input", workId: "work",
      sessionId: "session", triggerKey: "final", candidateKeys: ["final"], reused: true,
      wakeAt: "2026-11-15T00:03:00.000Z",
    };
    const now = Date.parse("2026-11-15T00:05:00.000Z");
    expect(dialogueRunStale(idle, [{ ...wake, runId: "other" }], now)).toBe(false);
    expect(dialogueRunStale(idle, [wake], now - 1)).toBe(false);
    expect(dialogueRunStale(idle, [wake, { ...wake, wakeAt: new Date(now).toISOString() }], now)).toBe(true);
    idle.events.push({ type: "heartbeat", at: new Date(now).toISOString() });
    expect(dialogueRunStale(idle, [wake], now)).toBe(false);
    expect(dialogueRunStale(idle, [wake], now + 3_600_000)).toBe(false);
  });

  it("uses explicit outcomes for failure and opening silence", () => {
    const current = run("dialogue", [{ type: "expression_outcome", status: "failed", candidateIds: ["A"], inputIds: ["input-A"], planId: "A" }]);
    expect(dialogueCandidateFailed(current, "A")).toBe(true);
    expect(dialogueOpeningHandled(current, "input-A")).toBe(true);
    expect(dialogueOpeningHandled(current, "input-B")).toBe(false);
  });
});

it("leaves a live wording attempt alone even after a long silent provider wait", () => {
  const at = "2026-11-15T00:00:00.000Z";
  const actor = run("busy", [{ type: "heartbeat", at }, { type: "wording_started", candidateIds: ["answer"], at }]);
  expect(dialogueRunStale(actor, [], Date.parse(at) + 3_600_000)).toBe(false);
});
