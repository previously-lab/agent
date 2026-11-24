import { z } from "zod";
import type {
  DialogueArtifactRef,
  DialogueInput,
  PublicUtterance,
} from "@/lib/chat/dialogue-contract";
import type { ImageAttachmentEvidence } from "@/lib/chat/image-attachments";
import type { SliceLandingConfig } from "@/lib/chat/slice-landing";
import { parseWorkUpdateEvent } from "./work-contract";
import type { WorkRelation, WorkResponseMode, WorkUpdateEvent } from "./work-contract";

export const DIALOGUE_TRANSPORT = "workflow-v2" as const;
export const DIALOGUE_THOUGHTS_NAMESPACE = "dialogue-thinking-v2";
export const DIALOGUE_OFFERS_NAMESPACE = "dialogue-offers-v2";
export const DIALOGUE_CHECKPOINT_NAMESPACE = "dialogue-checkpoint-draft-v2";
export const DIALOGUE_ARTIFACT_CHUNK = "data-dialogue-artifact";
export const DIALOGUE_PUBLICATION_CHUNK = "data-dialogue-publication";
export const DIALOGUE_OFFER_RESULT = "dialogue-offer" as const;
export const DIALOGUE_FALLBACK_TOOL_CALL_ID = "fallback";
/** Host-owned synthetic tool call ids for semantic event offers (never model-issued). */
export const DIALOGUE_HOST_READ_CHECKPOINT_TOOL_CALL_ID = "host-read-checkpoint";
export const DIALOGUE_HOST_NEEDS_USER_TOOL_CALL_ID = "host-needs-user";
export const DIALOGUE_HOST_STRUCTURED_REPORT_TOOL_CALL_ID = "host-structured-report";

export type DialogueOfferStage = "checkpoint" | "final";

/** A genuine user-input blocker that only the user can clear. */
export const dialogueNeedsUserKindSchema = z.enum(["missing_file", "missing_information", "decision", "permission"]);
export const dialogueNeedsUserSchema = z.object({
  kind: dialogueNeedsUserKindSchema,
  detail: z.string().trim().min(1),
}).strict();

/**
 * Host semantic dialogue input. Strictly validated at every boundary; carries
 * no evidence ids, openQuestions, nextAction, memoryDelta or raw thoughts —
 * only admitted public material with safe claim labels, or a user blocker.
 */
export const dialogueSemanticEventSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("read_completed"),
    sourceKind: z.enum(["semantic_document", "original_turn"]),
    evidenceCount: z.number().int().min(1),
  }).strict(),
  z.object({
    kind: z.literal("needs_user"),
    needsUser: dialogueNeedsUserSchema,
  }).strict(),
  z.object({
    kind: z.literal("findings"),
    findings: z.array(z.object({
      text: z.string().trim().min(1),
      kind: z.enum(["conversation", "project_fact", "historical_fact", "user_report",
        "observation", "external_result", "interpretation", "recommendation", "status", "unknown", "question"]),
      uncertainty: z.string().trim().min(1).optional(),
      decision: z.enum(["proposed", "confirmed", "rejected", "unresolved"]).optional(),
    }).strict()).min(1),
  }).strict(),
]);
export type DialogueNeedsUser = z.infer<typeof dialogueNeedsUserSchema>;
export type DialogueSemanticEvent = z.infer<typeof dialogueSemanticEventSchema>;
export type DialogueEventKind = DialogueSemanticEvent["kind"];

export interface DialogueCheckpoint {
  offerId: string;
  runId: string;
  text: string;
}

export interface DialoguePriorContext {
  role: "user" | "assistant";
  text: string;
}

export interface DialogueRecordEnvironment {
  useGithub: boolean;
  useDemo: boolean;
  owner: string;
  repo: string;
  timezone: string;
  slicing: SliceLandingConfig;
  sliceId?: string;
  images?: ImageAttachmentEvidence[];
}

export interface DialogueHolderReceipt {
  runId: string;
  sessionId: string;
}

/** Server-owned context carried through the tool boundary by value. */
export interface DialogueOfferContext {
  scopeKey: string;
  holder?: DialogueHolderReceipt;
  parentRunId: string;
  workId: string;
  sourceInputId: string;
  sourceTurnId: string;
  source: DialogueInput;
  priorContext: DialoguePriorContext[];
  locale: string;
  record: DialogueRecordEnvironment;
}

export type DialogueActorEvent = DialogueSemanticEvent | { kind: "work_update"; notes: string };

export interface DialogueRunInput {
  offerId: string;
  publicSeq: number;
  /** Server-started final reply from a completed thought run; no offer admission. */
  direct?: boolean;
  /** Model/host prose result; empty for host semantic event offers. */
  text: string;
  /** Per-input expression contract selected by the thinking role. */
  responseMode?: WorkResponseMode;
  /** Current work update or host semantic input, never a public reply draft. */
  event?: DialogueActorEvent;
  context: DialogueOfferContext;
  stage?: DialogueOfferStage;
  priorCheckpoints?: DialogueCheckpoint[];
  /** A merged utterance may answer more than the primary input. */
  publicationId?: string;
  publicationInputIds?: string[];
  /** Owning thought runs for an aggregate publication, for explicit cancellation. */
  publicationParentRunIds?: string[];
  publicationSourceResults?: PublicUtterance["sourceResults"];
  /** Workflow-native snapshot used by the independent dialogue orchestrator. */
  orchestration?: {
    works: Array<{ workId: string; inputId: string; status: string }>;
    offers: DialogueOfferEvent[];
    publications: PublicUtterance[];
  };
}

export type OfferReplyResult =
  | {
      ok: true;
      kind: typeof DIALOGUE_OFFER_RESULT;
      offerId: string;
      runId: string;
      sourceInputId: string;
      parentRunId?: string;
      locale?: string;
      workId?: string;
      aggregateInputIds?: string[];
      stage?: DialogueOfferStage;
      publicSeq?: number;
      eventKind?: DialogueEventKind;
      /** Durable offer payload, not a control-store record. */
      text?: string;
      event?: DialogueSemanticEvent;
      record?: DialogueRecordEnvironment;
    }
  | { ok: false; kind: typeof DIALOGUE_OFFER_RESULT; offerId: string; reason: string };

export interface DialogueOfferEvent {
  type: "offer";
  /** Native work handoffs are ordered across inputs by their acceptance time. */
  acceptedAt?: string;
  offerId: string;
  runId: string;
  sourceInputId: string;
  parentRunId?: string;
  locale?: string;
  workId?: string;
  aggregateInputIds?: string[];
  stage?: DialogueOfferStage;
  publicSeq?: number;
  eventKind?: DialogueEventKind;
  text?: string;
  event?: DialogueSemanticEvent;
  record?: DialogueRecordEnvironment;
  /** Advisory only: never permits reassignment of the candidate's input. */
  relation?: WorkRelation;
  dependsOnInputIds?: string[];
  responseMode?: WorkResponseMode;
}

export interface DialogueThoughtStartedEvent {
  type: "thought_started";
  runId: string;
  sourceInputId: string;
  workId: string;
  input: DialogueInput;
  record: DialogueRecordEnvironment;
  acceptedAt: string;
}

/** Written to the thought run's stream after an API-based dialogue wake. */
export interface DialogueWakeEvent {
  type: "dialogue_wake";
  runId: string;
  parentRunId: string;
  sourceInputId: string;
  workId: string;
  sessionId: string;
  triggerKey: string;
  candidateKeys: string[];
  wakeAt: string;
  reused: boolean;
}

/** A Workflow-forwarded writer for the originating thought's offers namespace. */
export type DialogueParentWritable = WritableStream<WorkUpdateEvent | DialogueWakeEvent>;

export interface DialogueDeliveryEvent {
  type: "thought_delivery_finished";
  runId: string;
  sourceInputId: string;
  candidateId: string;
  status: "delivered" | "failed";
  finishedAt: string;
}

export type DialogueControlEvent = DialogueOfferEvent | WorkUpdateEvent | DialogueThoughtStartedEvent | DialogueWakeEvent | DialogueDeliveryEvent;

export function parseDialogueControlEvent(value: unknown): DialogueControlEvent | null {
  if (!value || typeof value !== "object") return null;
  const event = value as Record<string, unknown>;
  if (event.type === "work_checkpoint" || event.type === "work_completed") {
    // Offer parsing below is retained only for previously persisted runs.
    return parseWorkUpdateEvent(value);
  }
  if (event.type === "offer") return parseDialogueOfferEvent(value);
  if (event.type === "thought_started") {
    if (typeof event.runId !== "string" || !/^wrun_[A-Za-z0-9]+$/.test(event.runId) ||
        typeof event.sourceInputId !== "string" || !event.sourceInputId ||
        typeof event.workId !== "string" || !event.workId ||
        !event.input || typeof event.input !== "object" ||
        !event.record || typeof event.record !== "object" ||
        typeof event.acceptedAt !== "string" || !Number.isFinite(Date.parse(event.acceptedAt))) return null;
    return event as unknown as DialogueThoughtStartedEvent;
  }
  if (event.type === "dialogue_wake") {
    if (typeof event.runId !== "string" || !/^wrun_[A-Za-z0-9]+$/.test(event.runId) ||
        typeof event.parentRunId !== "string" || !/^wrun_[A-Za-z0-9]+$/.test(event.parentRunId) ||
        typeof event.sourceInputId !== "string" || !event.sourceInputId ||
        typeof event.workId !== "string" || !event.workId || typeof event.sessionId !== "string" || !event.sessionId ||
        typeof event.triggerKey !== "string" || !event.triggerKey || !Array.isArray(event.candidateKeys) ||
        event.candidateKeys.some(key => typeof key !== "string") ||
        typeof event.wakeAt !== "string" || !Number.isFinite(Date.parse(event.wakeAt)) || typeof event.reused !== "boolean") return null;
    return event as unknown as DialogueWakeEvent;
  }
  if (event.type === "thought_delivery_finished") {
    if (typeof event.runId !== "string" || !/^wrun_[A-Za-z0-9]+$/.test(event.runId) ||
        typeof event.sourceInputId !== "string" || !event.sourceInputId ||
        typeof event.candidateId !== "string" || !event.candidateId ||
        (event.status !== "delivered" && event.status !== "failed") ||
        typeof event.finishedAt !== "string" || !Number.isFinite(Date.parse(event.finishedAt))) return null;
    return event as unknown as DialogueDeliveryEvent;
  }
  return null;
}

export interface DialogueOffersDoneEvent {
  type: "done";
  parentRunId: string;
  status: "running" | "completed" | "failed" | "cancelled";
  cursor: number;
  retryAfterMs?: number;
  deliveryStatus?: "delivered" | "unverified";
  error?: string;
}

export interface DialogueAcceptedV2 {
  version: 2;
  parentRunId: string;
  /** Compatibility alias for clients that already store a run ID. */
  runId: string;
  sourceInputId: string;
  workId: string;
  input: DialogueInput;
  offersUrl: string;
  thoughtsUrl: string;
}

export interface DialogueTypedArtifact {
  blockId: string;
  artifact: DialogueArtifactRef;
  /** Exact native source. Never included in the dialogue model prompt. */
  body: string;
}

export interface PreparedDialogueOffer {
  prompt: string;
  artifacts: DialogueTypedArtifact[];
  superseded?: boolean;
}

export interface DialogueRecordRequest {
  source: DialogueInput;
  sourceTurnId: string;
  environment: DialogueRecordEnvironment;
  /** A public actor may express multiple inputs, each with its own image evidence. */
  publicationInputs?: Array<{ input: DialogueInput; turnId: string; sliceId?: string; images?: ImageAttachmentEvidence[] }>;
  work?: import("@/lib/chat/turn-types").DialogueWorkResult;
  utterance?: PublicUtterance;
}

export interface DialogueRunResult {
  kind: "dialogue-reply";
  offerId: string;
  status: "completed" | "failed" | "not_admitted" | "admission_timeout";
  utterance?: PublicUtterance;
  held?: boolean;
  artifacts?: DialogueTypedArtifact[];
  recordRunId?: string;
  recordError?: string;
  error?: string;
}

export function dialogueOfferId(workId: string, toolCallId: string): string {
  return `${workId}:${toolCallId}`;
}

function offerControlFields(value: Record<string, unknown>): Pick<DialogueOfferEvent, "stage" | "publicSeq" | "eventKind"> {
  const eventKind = value.eventKind;
  return {
    ...(value.stage === "checkpoint" || value.stage === "final" ? { stage: value.stage } : {}),
    ...(typeof value.publicSeq === "number" && Number.isSafeInteger(value.publicSeq) && value.publicSeq > 0
      ? { publicSeq: value.publicSeq } : {}),
    ...(eventKind === "read_completed" || eventKind === "needs_user" || eventKind === "findings"
      ? { eventKind } : {}),
  };
}

function offerPayloadFields(value: Record<string, unknown>): Pick<DialogueOfferEvent, "parentRunId" | "locale" | "workId" | "aggregateInputIds" | "text" | "event" | "record"> {
  const semantic = value.event === undefined ? undefined : dialogueSemanticEventSchema.safeParse(value.event);
  const aggregateInputIds = Array.isArray(value.aggregateInputIds)
    ? value.aggregateInputIds.filter((id): id is string => typeof id === "string" && id.length > 0) : [];
  return {
    ...(typeof value.parentRunId === "string" && /^wrun_[A-Za-z0-9]+$/.test(value.parentRunId) ? { parentRunId: value.parentRunId } : {}),
    ...(typeof value.locale === "string" && value.locale ? { locale: value.locale } : {}),
    ...(typeof value.workId === "string" && value.workId ? { workId: value.workId } : {}),
    ...(aggregateInputIds.length ? { aggregateInputIds } : {}),
    ...(typeof value.text === "string" ? { text: value.text } : {}),
    ...(semantic?.success ? { event: semantic.data } : {}),
    ...(value.record && typeof value.record === "object" && !Array.isArray(value.record)
      ? { record: value.record as DialogueRecordEnvironment }
      : {}),
  };
}

export function parseOfferReplyResult(value: unknown): Extract<OfferReplyResult, { ok: true }> | null {
  if (!value || typeof value !== "object") return null;
  const result = value as Record<string, unknown>;
  if (result.ok !== true || result.kind !== DIALOGUE_OFFER_RESULT) return null;
  if (typeof result.offerId !== "string" || !result.offerId || result.offerId.length > 256) return null;
  if (typeof result.runId !== "string" || !/^wrun_[A-Za-z0-9]+$/.test(result.runId)) return null;
  if (typeof result.sourceInputId !== "string" || !result.sourceInputId || result.sourceInputId.length > 256) return null;
  return {
    ok: true,
    kind: DIALOGUE_OFFER_RESULT,
    offerId: result.offerId,
    runId: result.runId,
    sourceInputId: result.sourceInputId,
    ...offerControlFields(result),
    ...offerPayloadFields(result),
  };
}

export function parseDialogueOfferEvent(value: unknown): DialogueOfferEvent | null {
  if (!value || typeof value !== "object") return null;
  const event = value as Record<string, unknown>;
  if (event.type !== "offer" || typeof event.offerId !== "string" || !event.offerId
    || typeof event.runId !== "string" || !/^wrun_[A-Za-z0-9]+$/.test(event.runId)
    || typeof event.sourceInputId !== "string" || !event.sourceInputId) return null;
  return { type: "offer", offerId: event.offerId, runId: event.runId, sourceInputId: event.sourceInputId,
    ...offerControlFields(event), ...offerPayloadFields(event) };
}
export function offerEventFromResult(result: Extract<OfferReplyResult, { ok: true }>): DialogueOfferEvent {
  return {
    type: "offer",
    offerId: result.offerId,
    runId: result.runId,
    sourceInputId: result.sourceInputId,
    ...offerControlFields(result),
    ...offerPayloadFields(result),
  };
}
