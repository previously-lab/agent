import type { DialogueWakeEvent } from "./transport";

export type DialogueRuntimeEvent =
  | { type: "lease_acquired"; at: string }
  | { type: "heartbeat"; at: string }
  | { type: "handoff_wait"; waitingForRunId: string; at: string }
  | { type: "exit_intent"; keys: string[]; at: string }
  | { type: "exit_commit"; at: string }
  | { type: "continued"; nextRunId: string }
  | { type: "delegated"; holderRunId: string }
  | { type: "expression_outcome"; status: "answered" | "intentionally_silent" | "failed"; candidateIds: string[]; inputIds: string[]; planId: string }
  | { type: "world_degraded"; reason: string };

export interface DialogueRunState {
  runId: string;
  status: string;
  createdAt: string;
  sessionId: string;
  events: DialogueRuntimeEvent[];
}

export function latestDialogueEvent<T extends DialogueRuntimeEvent["type"]>(
  run: DialogueRunState | undefined,
  type: T,
): Extract<DialogueRuntimeEvent, { type: T }> | undefined {
  return run?.events.findLast(event => event.type === type) as Extract<DialogueRuntimeEvent, { type: T }> | undefined;
}

export function dialogueHeartbeatAt(run: DialogueRunState): string {
  const latest = run.events.findLast(event => event.type === "heartbeat" || event.type === "handoff_wait");
  return latest?.at ?? run.createdAt;
}

/** Follow only forward responsibility edges. Handoff-wait is not a reverse edge. */
export function responsibleDialogueRun(
  run: DialogueRunState,
  runs: ReadonlyMap<string, DialogueRunState>,
): DialogueRunState {
  const visited = new Set<string>();
  let current = run;
  while (true) {
    if (visited.has(current.runId)) throw new Error("Dialogue responsibility cycle");
    visited.add(current.runId);
    const continued = latestDialogueEvent(current, "continued")?.nextRunId;
    const delegated = latestDialogueEvent(current, "delegated")?.holderRunId;
    const nextId = continued ?? delegated;
    const next = nextId ? runs.get(nextId) : undefined;
    if (!next) return current;
    current = next;
  }
}

export function sessionLastWakeAt(
  run: DialogueRunState,
  wakes: readonly DialogueWakeEvent[],
): string | undefined {
  const latest = wakes.filter(wake => wake.sessionId === run.sessionId)
    .map(wake => Date.parse(wake.wakeAt))
    .filter(Number.isFinite)
    .reduce((max, value) => Math.max(max, value), Date.parse(run.createdAt));
  return Number.isFinite(latest) ? new Date(latest).toISOString() : undefined;
}

export function dialogueCandidateFailed(run: DialogueRunState, candidateId: string): boolean {
  return run.events.some(event => event.type === "expression_outcome" && event.status === "failed" && event.candidateIds.includes(candidateId));
}

export function dialogueOpeningHandled(run: DialogueRunState, inputId: string): boolean {
  return run.events.some(event => event.type === "expression_outcome" && event.inputIds.includes(inputId));
}
