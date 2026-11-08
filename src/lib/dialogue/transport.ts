import { z } from "zod";
import type {
  DialogueArtifactRef,
  DialogueInput,
  PublicUtterance,
} from "@/lib/chat/dialogue-contract";
import type { ImageAttachmentEvidence } from "@/lib/chat/image-attachments";
import type { SliceLandingConfig } from "@/lib/chat/slice-landing";

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
export const OFFER_TEXT_MAX_CHARS = 200_000;
export const CHECKPOINT_TEXT_MAX_CHARS = 2400;

export type DialogueOfferStage = "checkpoint" | "final";

/** A genuine user-input blocker that only the user can clear. */
export const dialogueNeedsUserKindSchema = z.enum(["missing_file", "missing_information", "decision", "permission"]);
export const dialogueNeedsUserSchema = z.object({
  kind: dialogueNeedsUserKindSchema,
  detail: z.string().trim().min(1).max(600),
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
    evidenceCount: z.number().int().min(1).max(24),
  }).strict(),
  z.object({
    kind: z.literal("needs_user"),
    needsUser: dialogueNeedsUserSchema,
  }).strict(),
  z.object({
    kind: z.literal("findings"),
    findings: z.array(z.object({
      text: z.string().trim().min(1).max(8000),
      kind: z.enum(["conversation", "project_fact", "historical_fact", "user_report",
        "observation", "external_result", "interpretation", "recommendation", "status", "unknown", "question"]),
      uncertainty: z.string().trim().min(1).max(600).optional(),
      decision: z.enum(["proposed", "confirmed", "rejected", "unresolved"]).optional(),
    }).strict()).min(1).max(12),
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

/** Server-owned context carried through the tool boundary by value. */
export interface DialogueOfferContext {
  parentRunId: string;
  workId: string;
  sourceInputId: string;
  sourceTurnId: string;
  source: DialogueInput;
  priorContext: DialoguePriorContext[];
  locale: string;
  record: DialogueRecordEnvironment;
}

export interface DialogueRunInput {
  offerId: string;
  publicSeq: number;
  /** Model/host prose result; empty for host semantic event offers. */
  text: string;
  /** Host semantic input; when present it is the machine-labeled event. */
  event?: DialogueSemanticEvent;
  context: DialogueOfferContext;
  stage?: DialogueOfferStage;
  priorCheckpoints?: DialogueCheckpoint[];
}

export type OfferReplyResult =
  | {
      ok: true;
      kind: typeof DIALOGUE_OFFER_RESULT;
      offerId: string;
      runId: string;
      sourceInputId: string;
      stage?: DialogueOfferStage;
      publicSeq?: number;
      eventKind?: DialogueEventKind;
    }
  | { ok: false; kind: typeof DIALOGUE_OFFER_RESULT; offerId: string; reason: string };

export interface DialogueOfferEvent {
  type: "offer";
  offerId: string;
  runId: string;
  sourceInputId: string;
  stage?: DialogueOfferStage;
  publicSeq?: number;
  eventKind?: DialogueEventKind;
}

export interface DialogueOffersDoneEvent {
  type: "done";
  parentRunId: string;
  status: "running" | "completed" | "failed" | "cancelled";
  cursor: number;
  retryAfterMs?: number;
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
  };
}

export function parseDialogueOfferEvent(value: unknown): DialogueOfferEvent | null {
  if (!value || typeof value !== "object") return null;
  const event = value as Record<string, unknown>;
  if (event.type !== "offer" || typeof event.offerId !== "string" || !event.offerId
    || typeof event.runId !== "string" || !/^wrun_[A-Za-z0-9]+$/.test(event.runId)
    || typeof event.sourceInputId !== "string" || !event.sourceInputId) return null;
  return { type: "offer", offerId: event.offerId, runId: event.runId, sourceInputId: event.sourceInputId,
    ...offerControlFields(event) };
}
export function offerEventFromResult(result: Extract<OfferReplyResult, { ok: true }>): DialogueOfferEvent {
  return {
    type: "offer",
    offerId: result.offerId,
    runId: result.runId,
    sourceInputId: result.sourceInputId,
    ...offerControlFields(result),
  };
}
