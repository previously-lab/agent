/**
 * Dialogue steps — the "use step" bridge between the durable workflows and
 * the dialogue control store. Every function here runs in full Node (fs-backed
 * store, model call for expression); the deterministic workflow bodies call
 * them by reference only, exactly like steps.ts.
 *
 * Two step families:
 *   - expression (expression-workflow.ts): lease-guarded drain rounds. One
 *     round reads the fenced snapshot, asks the expression model for a bounded
 *     plan ONCE, checkpoints it, then publishes complete short segments one
 *     transaction at a time so a crash keeps the committed prefix and the
 *     remainder is rebased, never replayed as new text.
 *   - thinking work (turn-workflow.ts): the work attempt fence (only one run
 *     is admitted per work), the slice binding, and the terminal product
 *     handoff (claims, artifact blocks, immutable result).
 */
import type { ModelMessage } from "@/lib/deepseek/types";
import type { DialogueClaim } from "@/lib/chat/dialogue-contract";
import type { DocumentContextSnapshot } from "@/lib/chat/document-context";
import type { DialogueLaunch, ExpressionBasis, ExpressionFence, ExpressionPlan, DialogueResult, SavedExpressionPlan } from "@/lib/dialogue/types";
import { DialogueConflict, type DialogueStore } from "@/lib/dialogue/store";
import { composeExpression } from "@/lib/dialogue/expression";
import { getDialogueStore } from "@/lib/dialogue/runtime";
import { buildThinkingProduct } from "@/lib/agents/thinking-product";
import { dialogueClaimsFromProduct, draftBlocksFromWorkText } from "@/lib/dialogue/product";
import { deriveWorkScopeBindings } from "@/lib/dialogue/scopes";
import { collectTaskAckIntents } from "@/lib/chat/task-followups";
import { readTaskLedger } from "@/lib/tasks/store";
import type { TaskDeliveryIntent } from "@/lib/dialogue/types";
import { dispatchDialogueDueScopes } from "./dialogue/dispatch-host";

// ─── Expression drain steps (expression-workflow.ts) ──────────────────────

export async function acquireExpressionStep(
  scopeKey: string,
  holder: string,
): Promise<ExpressionFence | null> {
  "use step";
  return (await getDialogueStore()).acquireExpression(scopeKey, holder);
}

/**
 * One drain round: recover a checkpointed plan, or snapshot → compose →
 * checkpoint. A model failure defers to the next wake (results stay ready,
 * the lease watch re-rings) instead of burning the step's retry budget on a
 * billed call. Null means this run owns nothing more.
 */
export async function expressionRoundStep(
  scopeKey: string,
  fence: ExpressionFence,
  callId: string,
): Promise<{ saved: SavedExpressionPlan; observedWake: number } | null> {
  "use step";
  const store = await getDialogueStore();
  const active = await store.activePlan(scopeKey, fence);
  if (active) return { saved: active, observedWake: active.basis.wakeVersion };
  const snapshot = await store.expressionSnapshot(scopeKey, fence);
  if (!snapshot) return null;
  let plan: ExpressionPlan;
  try {
    plan = await composeExpression(snapshot, `${callId}:${snapshot.wakeVersion}`);
  } catch (error) {
    console.warn(
      "[Expression] compose failed — results stay ready for the next wake:",
      error instanceof Error ? error.message : error,
    );
    return null;
  }
  const admitted = snapshot.results.map((result) => result.resultId);
  const saved = await store.savePlan(scopeKey, fence, snapshot, plan, admitted);
  return saved ? { saved, observedWake: snapshot.wakeVersion } : null;
}

/**
 * Publish ONE plan segment in its own transaction. The round id embeds the
 * checkpointed plan id and the segment ordinal, so a redelivery of an
 * already-committed segment returns the original utterance instead of a new
 * publication. Decisions ride the final segment. A conflict means the plan is
 * invalid against the store (unadmitted source, reused claim, executable
 * content in prose) — reported back so the caller settles the plan instead of
 * retrying a deterministic rejection.
 */
export async function publishExpressionSegmentStep(
  scopeKey: string,
  fence: ExpressionFence,
  saved: SavedExpressionPlan,
  index: number,
  publicHighWater: number,
): Promise<{ status: "committed" | "stale" | "invalid"; utterances: Awaited<ReturnType<DialogueStore["publish"]>>["utterances"] }> {
  "use step";
  const store = await getDialogueStore();
  const send = saved.plan.sends[index];
  if (!send) return { status: "invalid", utterances: [] };
  const basis: ExpressionBasis = {
    inputHighWater: saved.basis.inputHighWater,
    publicHighWater,
    wakeVersion: saved.basis.wakeVersion,
  };
  try {
    const result = await store.publish(scopeKey, fence, `${saved.id}:${index + 1}`, basis, {
      sends: [send],
      decisions: index === saved.plan.sends.length - 1 ? saved.plan.decisions : [],
    });
    return result;
  } catch (error) {
    if (error instanceof DialogueConflict) return { status: "invalid", utterances: [] };
    throw error;
  }
}

export async function settleExpressionPlanStep(
  scopeKey: string,
  fence: ExpressionFence,
  savedId: string,
  defer: boolean,
): Promise<void> {
  "use step";
  await (await getDialogueStore()).finishPlan(scopeKey, fence, savedId, defer);
}

export async function releaseExpressionStep(
  scopeKey: string,
  fence: ExpressionFence,
  observedWake: number,
  yieldWithWork = false,
): Promise<"released" | "continue" | "lost"> {
  "use step";
  return (await getDialogueStore()).releaseExpression(scopeKey, fence, observedWake, yieldWithWork);
}

// ─── Thinking-work steps (turn-workflow.ts) ────────────────────────────────

export type DialogueWorkAdmission = NonNullable<
  Awaited<ReturnType<DialogueStore["beginWork"]>>
>;

/**
 * The attempt fence: exactly one run owns a live work. Returns the
 * server-authoritative window (accepted inputs, pending works, recent public
 * manuscript) or null when this attempt is a duplicate/stale runner — the
 * workflow then exits without answering.
 */
export async function beginDialogueWorkStep(
  launch: DialogueLaunch,
  runId: string,
): Promise<DialogueWorkAdmission | null> {
  "use step";
  const window = await (await getDialogueStore()).beginWork(launch.scopeKey, launch.workId, runId);
  if (!window) return null;
  return window;
}

export interface CompleteDialogueWorkArgs {
  launch: DialogueLaunch;
  /** The original input this work answers (launch.turnId — a regenerate keeps
   *  the original input id, not the retry work id). */
  inputIds: string[];
  runId: string;
  sliceId: string;
  /** All assistant messages this attempt produced (native replay exact). */
  messages: ModelMessage[];
  /** The final joined work text (internal product, never published as-is). */
  text: string;
  locale?: string;
  documentContext?: DocumentContextSnapshot;
  /** finishThinking report, when the model filed one. */
  report: unknown;
  /** Non-stop finish or an error — the product records an honest status. */
  interrupted: boolean;
}

/**
 * The terminal handoff, in ONE step: build the immutable product from this
 * attempt's real messages (host-fixed input scope — the model cannot rebind
 * it), split the text into durable blocks (native documents become
 * host-minted artifacts), map admitted claims with their evidence snapshots,
 * and register the result + expression wake atomically. Timestamps are
 * stamped here — the workflow body has no clock.
 */
export async function completeDialogueWorkStep(
  args: CompleteDialogueWorkArgs,
): Promise<DialogueResult | null> {
  "use step";
  const store = await getDialogueStore();
  await store.bindWorkSlice(args.launch.scopeKey, args.launch.workId, args.runId, args.sliceId);
  // Host-owned explicit scope: only the user-attached (server-validated)
  // document context enters the saved work scope — one independent scope per
  // trusted ref — so a correction bound to the same ref rebuts only that
  // ref's claims, never the independent speaker task (T02). A regenerate
  // work copies the original launch: the retry is judged against the
  // ORIGINAL spec versions, never the attempt's.
  const { independentScopes } = deriveWorkScopeBindings(args.documentContext);
  // Explicit delivery assertions: reportTaskFollowup intents minted by the
  // tool executor (ledger-read expectedRevision, already-delivered rejected
  // on the spot). Only results still pending at THIS completion persist on
  // the immutable result record; the publication settles them later.
  const ackIntents = collectTaskAckIntents(args.messages).filter(
    (intent) => intent.kind === "result",
  );
  let deliveryIntents: TaskDeliveryIntent[] | undefined;
  let taskRef: string | undefined;
  if (ackIntents.length) {
    const read = await readTaskLedger().catch(() => null);
    const ledgerResults = read?.status === "ready" ? read.ledger.results : [];
    deliveryIntents = ackIntents.flatMap((intent) => {
      const ledgerResult = ledgerResults.find((entry) => entry.id === intent.resultId);
      return ledgerResult &&
        ledgerResult.delivery.state === "pending" &&
        ledgerResult.revision === intent.expectedRevision
        ? [{ resultId: ledgerResult.id, expectedRevision: ledgerResult.revision, taskRef: ledgerResult.taskRef }]
        : [];
    });
    const taskRefs = new Set((deliveryIntents ?? []).map((intent) => intent.taskRef));
    taskRef = taskRefs.size === 1 ? [...taskRefs][0] : undefined;
  }
  const product = buildThinkingProduct({
    text: args.text,
    messages: args.messages,
    inputScope: {
      scopeKey: args.launch.scopeKey,
      workId: args.launch.workId,
      inputIds: args.inputIds,
      inputText: args.text,
      readScopeId: args.launch.workId,
      ...(args.locale ? { locale: args.locale } : {}),
      ...(args.documentContext?.length ? { documentContext: args.documentContext } : {}),
      ...(independentScopes.length ? { independentScopes } : {}),
      ...(taskRef ? { taskRef } : {}),
    },
    asOf: new Date().toISOString(),
    report: args.report,
    interrupted: args.interrupted,
  });
  const { blocks, artifactBlockIds } = draftBlocksFromWorkText(args.launch.workId, args.text);
  const claims: DialogueClaim[] = dialogueClaimsFromProduct(product, artifactBlockIds);
  const result = await store.completeWork(args.launch.scopeKey, {
    workId: args.launch.workId,
    runId: args.runId,
    sliceId: args.sliceId,
    product,
    claims,
    blocks,
    status: args.interrupted ? "failed" : "completed",
    ...(deliveryIntents?.length ? { deliveryIntents } : {}),
  });
  // This is a Node Workflow step, not a request context: await the same
  // bounded entry directly so the durable result wakes expression immediately.
  await dispatchDialogueDueScopes();
  return result;
}

export async function failDialogueWorkStep(
  launch: DialogueLaunch,
  runId: string,
): Promise<void> {
  "use step";
  await (await getDialogueStore()).failWork(launch.scopeKey, launch.workId, runId);
}
