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
export const DIALOGUE_ARTIFACT_CHUNK = "data-dialogue-artifact";
export const DIALOGUE_PUBLICATION_CHUNK = "data-dialogue-publication";
export const DIALOGUE_OFFER_RESULT = "dialogue-offer" as const;
export const DIALOGUE_FALLBACK_TOOL_CALL_ID = "fallback";
export const OFFER_TEXT_MAX_CHARS = 200_000;

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
  text: string;
  context: DialogueOfferContext;
}

export type OfferReplyResult =
  | {
      ok: true;
      kind: typeof DIALOGUE_OFFER_RESULT;
      offerId: string;
      runId: string;
      sourceInputId: string;
    }
  | { ok: false; kind: typeof DIALOGUE_OFFER_RESULT; offerId: string; reason: string };

export interface DialogueOfferEvent {
  type: "offer";
  offerId: string;
  runId: string;
  sourceInputId: string;
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
  artifacts?: DialogueTypedArtifact[];
  recordRunId?: string;
  recordError?: string;
  error?: string;
}

export function dialogueOfferId(workId: string, toolCallId: string): string {
  return `${workId}:${toolCallId}`;
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
  };
}

export function parseDialogueOfferEvent(value: unknown): DialogueOfferEvent | null {
  if (!value || typeof value !== "object") return null;
  const event = value as Record<string, unknown>;
  if (event.type !== "offer" || typeof event.offerId !== "string" || !event.offerId
    || typeof event.runId !== "string" || !/^wrun_[A-Za-z0-9]+$/.test(event.runId)
    || typeof event.sourceInputId !== "string" || !event.sourceInputId) return null;
  return { type: "offer", offerId: event.offerId, runId: event.runId, sourceInputId: event.sourceInputId };
}
export function offerEventFromResult(result: Extract<OfferReplyResult, { ok: true }>): DialogueOfferEvent {
  return {
    type: "offer",
    offerId: result.offerId,
    runId: result.runId,
    sourceInputId: result.sourceInputId,
  };
}