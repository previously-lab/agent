import type { ContentBlockV1, DialogueClaim, DialogueInput, DialogueWork, PublicUtterance } from "@/lib/chat/dialogue-contract";
import type { TurnInput } from "@/lib/chat/turn-types";
import type { ThinkingProduct } from "@/lib/agents/thinking-product";

export interface DialogueLaunch {
  scopeKey: string;
  workId: string;
  /** Native offer transport; omitted on legacy store-backed runs. */
  transport?: "workflow-v2";
  sourceInputId?: string;
}

export interface DialogueWorkRecord extends DialogueWork {
  launch: TurnInput;
  acceptedAt: string;
  sliceId?: string;
}

export type DraftContentBlock = ContentBlockV1 | {
  kind: "artifact_source";
  blockId: string;
  artifactKind: "native_html" | "document";
  mediaType: string;
  body: string;
  summary?: string;
};

export interface DialogueResult {
  resultId: string;
  productRevision: number;
  workId: string;
  inputIds: string[];
  producerRunId: string;
  sliceId: string;
  availableAt: string;
  product: ThinkingProduct;
  claims: DialogueClaim[];
  blocks: ContentBlockV1[];
  /** Verified reportTaskFollowup intents: task results this work asserts its
   *  publication will deliver. Settled against the ledger when a committed
   *  publication citing this result is projected to the record plane. */
  deliveryIntents?: TaskDeliveryIntent[];
}

export interface ExpressionFence { holder: string; epoch: number }

export interface ExpressionSnapshot {
  inputHighWater: number;
  publicHighWater: number;
  wakeVersion: number;
  inputs: DialogueInput[];
  pending: DialogueWork[];
  publications: PublicUtterance[];
  results: DialogueResult[];
  /** Explicit prefix coverage: older inputs remain durable, not read in full. */
  firstRecentUserSeq: number;
}

export type ExpressionBasis = Pick<ExpressionSnapshot, "inputHighWater" | "publicHighWater" | "wakeVersion">;
export interface SavedExpressionPlan { id: string; basis: ExpressionBasis; plan: ExpressionPlan; admitted: string[] }

export interface ExpressionSend {
  text: string;
  sources: Array<{ resultId: string; productRevision: number; claimId: string; mode: "finding" | "status" }>;
  blockIds: string[];
}

export interface ExpressionPlan {
  sends: ExpressionSend[];
  decisions: Array<{ resultId: string; productRevision: number; kind: "deferred" | "covered"; byUtteranceId?: string }>;
}

export type OutboxPayload =
  | { kind: "start_work"; workId: string }
  | { kind: "watch_work"; workId: string }
  | { kind: "express" }
  | { kind: "project"; eventSeq: number }
  | { kind: "project_result"; resultId: string };

/** An explicit, host-verified delivery assertion made by the work (via the
 *  reportTaskFollowup tool): the named task-ledger result was delivered by
 *  THIS work's eventual public publication. expectedRevision is minted by the
 *  tool executor from the ledger, never by the model. */
export interface TaskDeliveryIntent {
  resultId: string;
  expectedRevision: number;
  taskRef: string;
}

export interface DialogueOutboxJob {
  id: string;
  payload: OutboxPayload;
  attempts: number;
  lease?: string;
}
