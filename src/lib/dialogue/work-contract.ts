import type { DialogueOfferEvent, DialogueRecordEnvironment, DialogueSemanticEvent } from "./transport";

/** Public-safe task relationships, never permission to change result ownership. */
export const WORK_RELATIONS = ["new", "related", "continuation", "unclear"] as const;
export type WorkRelation = typeof WORK_RELATIONS[number];

/** Selected per input by the thinking role; unrelated to task dependency. */
export const WORK_RESPONSE_MODES = ["chat", "focused", "research", "rewrite"] as const;
export type WorkResponseMode = typeof WORK_RESPONSE_MODES[number];
export const WORK_RESPONSE_MODE_GUIDANCE: Record<WorkResponseMode, string> = {
  chat: "Give a brief natural social reply. Do not recap memory, investigate without a request, or append unrelated tasks, findings or offers.",
  focused: "Answer the exact ask directly and only that. Keep the facts and caveats needed for this answer. Omit incidental chronology, side findings and unasked comparisons. Honor the user's scope and length. Never invent personal facts such as location, preferences or dietary restrictions; use a neutral suggestion when they are unknown.",
  research: "Investigate only the requested breadth and depth. Organize the evidence needed for the research ask without exhaustive tangents or unrelated findings.",
  rewrite: "Transform only the referenced material for the requested audience and shape. Do not restart research, repeat unrelated context or add a new topic.",
};
function responseMode(value: unknown): WorkResponseMode | undefined {
  return typeof value === "string" && (WORK_RESPONSE_MODES as readonly string[]).includes(value)
    ? value as WorkResponseMode : undefined;
}

interface WorkEventBase {
  updateId: string;
  runId: string;
  sourceInputId: string;
  workId: string;
  acceptedAt: string;
  publicSeq?: number;
  locale?: string;
  relation?: WorkRelation;
  dependsOnInputIds?: string[];
  record?: DialogueRecordEnvironment;
}

export interface WorkCheckpointEvent extends WorkEventBase {
  type: "work_checkpoint";
  text: string;
}

export interface WorkCompletedEvent extends WorkEventBase {
  type: "work_completed";
  text?: string;
  event?: DialogueSemanticEvent;
  responseMode?: WorkResponseMode;
}

export type WorkUpdateEvent = WorkCheckpointEvent | WorkCompletedEvent;

export interface WorkHandoff {
  updateId: string;
  stage: "checkpoint" | "completed";
  text: string;
  at: string;
}

/** A read-only projection of Workflow facts, not another state store. */
export interface WorkSnapshot {
  workId: string;
  inputId: string;
  runId: string;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  acceptedAt: string;
  latestStage: "started" | "checkpoint" | "completed";
  publicHandoffs: WorkHandoff[];
  completedUpdateId?: string;
  relation?: WorkRelation;
  dependsOnInputIds?: string[];
  updatedAt: string;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function relation(value: unknown): WorkRelation | undefined {
  return typeof value === "string" && (WORK_RELATIONS as readonly string[]).includes(value)
    ? value as WorkRelation : undefined;
}

function dependencies(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const ids = [...new Set(value.filter(nonEmpty))];
  return ids.length ? ids : undefined;
}

function base(value: Record<string, unknown>): WorkEventBase | null {
  if (!nonEmpty(value.updateId) || !nonEmpty(value.runId) || !nonEmpty(value.sourceInputId) ||
      !nonEmpty(value.workId) || !nonEmpty(value.acceptedAt) || !Number.isFinite(Date.parse(value.acceptedAt))) return null;
  const related = relation(value.relation);
  if (value.relation !== undefined && !related) return null;
  const depends = dependencies(value.dependsOnInputIds);
  return {
    updateId: value.updateId, runId: value.runId, sourceInputId: value.sourceInputId,
    workId: value.workId, acceptedAt: value.acceptedAt,
    ...(typeof value.publicSeq === "number" && Number.isSafeInteger(value.publicSeq) && value.publicSeq > 0
      ? { publicSeq: value.publicSeq } : {}),
    ...(nonEmpty(value.locale) ? { locale: value.locale } : {}),
    ...(related ? { relation: related } : {}),
    ...(depends ? { dependsOnInputIds: depends } : {}),
    ...(value.record && typeof value.record === "object" ? { record: value.record as DialogueRecordEnvironment } : {}),
  };
}

export function parseWorkUpdateEvent(value: unknown): WorkUpdateEvent | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  const shared = base(candidate);
  if (!shared) return null;
  if (candidate.type === "work_checkpoint" && nonEmpty(candidate.text)) {
    return { ...shared, type: "work_checkpoint", text: candidate.text };
  }
  if (candidate.type === "work_completed") {
    const mode = responseMode(candidate.responseMode);
    if (candidate.responseMode !== undefined && !mode) return null;
    return {
      ...shared, type: "work_completed",
      ...(typeof candidate.text === "string" ? { text: candidate.text } : {}),
      ...(candidate.event && typeof candidate.event === "object" ? { event: candidate.event as DialogueSemanticEvent } : {}),
      ...(mode ? { responseMode: mode } : {}),
    };
  }
  return null;
}

/** The Actor still consumes the old candidate shape while new thought runs
 * emit only work events. No new offer is produced by this adapter. */
export function workUpdateAsDialogueCandidate(update: WorkUpdateEvent): DialogueOfferEvent {
  return {
    type: "offer",
    offerId: update.updateId,
    runId: update.runId,
    sourceInputId: update.sourceInputId,
    parentRunId: update.runId,
    workId: update.workId,
    acceptedAt: update.acceptedAt,
    publicSeq: update.publicSeq,
    locale: update.locale,
    stage: update.type === "work_checkpoint" ? "checkpoint" : "final",
    text: update.text,
    ...(update.type === "work_completed" && update.event ? { event: update.event, eventKind: update.event.kind } : {}),
    ...(update.type === "work_completed" && update.responseMode ? { responseMode: update.responseMode } : {}),
    ...(update.record ? { record: update.record } : {}),
    ...(update.relation ? { relation: update.relation } : {}),
    ...(update.dependsOnInputIds ? { dependsOnInputIds: update.dependsOnInputIds } : {}),
  };
}

export function projectWorkSnapshot(input: {
  workId: string;
  inputId: string;
  runId: string;
  status: WorkSnapshot["status"];
  acceptedAt: string;
  updates: readonly WorkUpdateEvent[];
}): WorkSnapshot {
  const updates = input.updates.filter(update => update.workId === input.workId && update.sourceInputId === input.inputId)
    .sort((a, b) => a.acceptedAt.localeCompare(b.acceptedAt) || a.updateId.localeCompare(b.updateId));
  const publicHandoffs = updates.flatMap((update): WorkHandoff[] => {
    const texts = update.type === "work_completed" && update.event?.kind === "findings"
      ? update.event.findings.map(finding => finding.uncertainty ? `${finding.text}\n${finding.uncertainty}` : finding.text)
      : update.text ? [update.text] : [];
    return texts.map(text => ({
      updateId: update.updateId, stage: update.type === "work_checkpoint" ? "checkpoint" as const : "completed" as const,
      text, at: update.acceptedAt,
    }));
  });
  const completed = updates.findLast(update => update.type === "work_completed");
  const latest = updates.at(-1);
  return {
    workId: input.workId, inputId: input.inputId, runId: input.runId,
    status: input.status, acceptedAt: input.acceptedAt,
    latestStage: completed ? "completed" : updates.length ? "checkpoint" : "started",
    publicHandoffs,
    ...(completed ? { completedUpdateId: completed.updateId } : {}),
    ...(latest?.relation ? { relation: latest.relation } : {}),
    ...(latest?.dependsOnInputIds ? { dependsOnInputIds: latest.dependsOnInputIds } : {}),
    updatedAt: latest?.acceptedAt ?? input.acceptedAt,
  };
}

export type WorkUpdateResult =
  // A durable update may precede acknowledgement by its public Actor.
  | { ok: true; kind: "work-update"; updateId: string; runId?: string; sourceInputId: string }
  | { ok: false; kind: "work-update"; updateId: string; reason: string };
