import type { DocumentContextSnapshot } from "./document-context";
import type { ImageAttachmentSnapshot } from "./image-attachments";

/** Shared by the manuscript client, workflow contracts, and control store. */
export interface DialogueArtifactRef {
  artifactId: string;
  sourceOwnerId: string;
  revision: 1;
  sha256: string;
  kind: "native_html" | "document";
  mediaType: string;
  byteSize: number;
  summary?: string;
  width?: number;
  height?: number;
}

export type ContentBlockV1 =
  | { kind: "markdown"; blockId: string; text: string }
  | { kind: "artifact_ref"; blockId: string; artifact: DialogueArtifactRef }
  | { kind: "image_ref"; blockId: string; image: ImageAttachmentSnapshot }
  | { kind: "citation_ref"; blockId: string; ref: string; label?: string };

export interface DialogueInput {
  inputId: string;
  clientMessageId: string;
  userSeq: number;
  eventSeq: number;
  acceptedAt: string;
  text: string;
  attachments?: ImageAttachmentSnapshot[];
  documentContext?: DocumentContextSnapshot;
}

export interface DialogueWork {
  workId: string;
  inputId: string;
  userSeq: number;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  runId?: string;
  summary?: string;
  artifacts?: DialogueArtifactRef[];
}

export interface DialogueAccepted {
  version: 1;
  input: DialogueInput;
  workId: string;
  runId?: string;
}

export interface DialogueEvidenceSnapshot {
  ref: string;
  sourceRevision: string;
  asOf: string;
  coverage: "complete" | "partial";
}

export interface DialogueClaim {
  claimId: string;
  text: string;
  allowedPublicMode: "finding" | "status" | "none";
  evidence: DialogueEvidenceSnapshot[];
  /** Only these exact blocks may be reused when this claim is selected. */
  blockIds?: string[];
}

export interface DialogueResultUse {
  resultId: string;
  productRevision: number;
  claimIds: string[];
}

export interface PublicUtterance {
  utteranceId: string;
  publicSeq: number;
  committedAt: string;
  inputIds: string[];
  sourceResults: DialogueResultUse[];
  blocks: ContentBlockV1[];
}

export type DialogueEvent =
  | { eventSeq: number; type: "input.accepted"; input: DialogueInput }
  | { eventSeq: number; type: "work.status"; work: DialogueWork }
  | { eventSeq: number; type: "manuscript.append"; utterance: PublicUtterance }
  | { eventSeq: number; type: "projection.receipt"; inputIds: string[]; utteranceIds: string[]; sliceId: string };

export interface DialoguePage {
  version: 1;
  events: DialogueEvent[];
  cursor: number;
  hasMore: boolean;
  expression: "idle" | "running" | "paused";
}
