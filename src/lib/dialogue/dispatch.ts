/**
 * The durable outbox dispatcher. The control store is the queue of record:
 * every accepted input, completed result and expression wake lands an outbox
 * job BEFORE the API answers, so a lost HTTP acknowledgement, a crashed
 * process or a dead scheduler never loses the intent. This engine is pure
 * orchestration — storage comes from the store, side effects (starting runs,
 * cancelling, projecting to the record plane) come from an injected runner,
 * which keeps the whole loop unit-testable without a workflow runtime.
 *
 * Job semantics:
 *   start_work      start the work's turn run once; a recorded runId means the
 *                   start already happened (lost ack) — just re-arm the watch.
 *   watch_work      poll the attempt run; still live → retry later, terminal
 *                   without a durable result → fail the work honestly.
 *   express         ask the store whether a drain may start (lease CAS); the
 *                   store decides, this engine only acts on the decision.
 *   project         project one accepted input / committed publication to the
 *                   record plane, then record the receipt (idempotent key =
 *                   the outbox job id).
 *   project_result  same for one immutable research result.
 */
import type { TurnInput } from "@/lib/chat/turn-types";
import type { DialogueStore } from "./store";
import type { DialogueOutboxJob, OutboxPayload } from "./types";
import { buildDeliveryConfirmations, confirmDeliveredTaskResults, type DeliveryConfirmation } from "./task-delivery";

export type ProjectJobPayload = Extract<OutboxPayload, { kind: "project" } | { kind: "project_result" }>;

export interface ProjectedReceipt {
  inputIds: string[];
  utteranceIds: string[];
  sliceId: string;
  reflection: Array<{ sliceId: string; turnIds: string[] }>;
  commitSha: string | null;
}

/** Side-effect surface the host supplies (workflow starts, cancels, record
 *  projection, the reflection bell). Never implemented by this module. */
export interface DialogueRunner {
  startWork(launch: TurnInput): Promise<{ runId: string }>;
  startExpression(scopeKey: string): Promise<"started" | "busy">;
  cancelRun(runId: string): Promise<void>;
  runStatus(runId: string): Promise<"live" | "completed" | "failed" | "cancelled" | "gone">;
  project(scope: string, payload: ProjectJobPayload): Promise<ProjectedReceipt | null>;
  ringReflection(ranges: Array<{ sliceId: string; turnIds: string[] }>): Promise<void>;
}

export interface DispatchLog {
  warn(message: string, ...details: unknown[]): void;
}

const NOOP_LOG: DispatchLog = { warn: () => {} };

/** Where committed-publication delivery confirmations go. The default sink
 *  confirms against the Git task ledger; tests and isolated environments
 *  inject a fake or pass null to disable. */
export interface DeliverySink {
  confirm(confirmations: readonly DeliveryConfirmation[]): Promise<void>;
}

export interface DispatchOptions {
  scopeLimit?: number;
  jobsPerScope?: number;
  /** undefined = the real task-ledger confirmer; null = disabled. */
  deliveries?: DeliverySink | null;
}

export interface JobOutcome {
  ok: boolean;
  /** Settle back to "ready" after this delay instead of the store's backoff. */
  retryMs?: number;
}

export async function runDialogueJob(
  store: DialogueStore,
  runner: DialogueRunner,
  scope: string,
  job: DialogueOutboxJob,
  log: DispatchLog = NOOP_LOG,
  options: DispatchOptions = {},
): Promise<JobOutcome> {
  const payload = job.payload;
  switch (payload.kind) {
    case "start_work": {
      const work = await store.work(scope, payload.workId);
      // Cancelled before the dispatcher got to it, or already launched (the
      // original ack was lost — the runId IS the idempotence record).
      if (!work || work.status !== "queued") return { ok: true };
      if (work.runId) {
        await store.noteLaunch(scope, payload.workId, work.runId);
        return { ok: true };
      }
      try {
        const run = await runner.startWork(work.launch);
        await store.noteLaunch(scope, payload.workId, run.runId);
        return { ok: true };
      } catch (error) {
        log.warn(`[Dialogue] start_work ${payload.workId} failed (will retry):`, error);
        return { ok: false, retryMs: 1_500 };
      }
    }
    case "watch_work": {
      const work = await store.work(scope, payload.workId);
      if (!work || !work.runId) return { ok: true };
      const status = await runner.runStatus(work.runId);
      if (status === "live") return { ok: false, retryMs: 8_000 };
      if (status === "completed") return { ok: true };
      // Terminal (or gone) without a durable result — the work owes an honest
      // failure status; the expression may say so.
      await store.failWork(scope, payload.workId, work.runId);
      return { ok: true };
    }
    case "express": {
      const decision = await store.expressionDispatch(scope);
      if (decision !== "start") return { ok: true };
      const outcome = await runner.startExpression(scope);
      if (outcome === "busy") return { ok: false, retryMs: 5_000 };
      return { ok: true };
    }
    case "project":
    case "project_result": {
      const receipt = await runner.project(scope, payload);
      if (!receipt) return { ok: true };
      // A committed publication citing delivery-bound results settles the
      // task-ledger delivery with the REAL persisted public turn as reply
      // evidence — after the projection returned, BEFORE the receipt settles,
      // so a failure re-runs the whole idempotent chain instead of skipping.
      if (payload.kind === "project" && receipt.utteranceIds.length && options.deliveries !== null) {
        const event = await store.event(scope, payload.eventSeq);
        if (event?.type === "manuscript.append" && receipt.utteranceIds.includes(event.utterance.utteranceId)) {
          const confirmations = await buildDeliveryConfirmations(
            store, scope, event.utterance, receipt.sliceId, new Date().toISOString(),
          );
          if (confirmations.length) {
            const sink: DeliverySink = options.deliveries ?? { confirm: (list) => confirmDeliveredTaskResults(list, log) };
            await sink.confirm(confirmations);
          }
        }
      }
      await store.recordProjection(scope, job.id, {
        inputIds: receipt.inputIds,
        utteranceIds: receipt.utteranceIds,
        sliceId: receipt.sliceId,
      });
      if (receipt.reflection.length > 0) {
        await runner.ringReflection(receipt.reflection).catch((error: unknown) =>
          log.warn("[Dialogue] reflection ring failed (ignored):", error));
      }
      return { ok: true };
    }
  }
}

async function claimRunSettle(
  store: DialogueStore,
  runner: DialogueRunner,
  scope: string,
  log: DispatchLog,
  options: DispatchOptions,
): Promise<"none" | "ok" | "failed"> {
  const job = await store.claimOutbox(scope);
  if (!job) return "none";
  try {
    const outcome = await runDialogueJob(store, runner, scope, job, log, options);
    await store.settleOutbox(scope, job, outcome.ok, outcome.retryMs);
    return outcome.ok ? "ok" : "failed";
  } catch (error) {
    log.warn(`[Dialogue] job ${job.id} (${job.payload.kind}) failed (will retry):`, error);
    await store.settleOutbox(scope, job, false).catch(() => {});
    return "failed";
  }
}

/**
 * One dispatch sweep: every scope with due work gets a bounded share, so one
 * busy scope cannot starve the rest. Jobs are leased by the store, so a
 * second process sweeping the same scopes simply finds fewer ready jobs.
 */
export async function dispatchDialogueStore(
  store: DialogueStore,
  runner: DialogueRunner,
  log: DispatchLog = NOOP_LOG,
  options: DispatchOptions = {},
): Promise<{ scopes: number; ran: number; failed: number }> {
  const scopes = await store.dueScopes(options.scopeLimit ?? 16);
  const jobsPerScope = options.jobsPerScope ?? 4;
  let ran = 0;
  let failed = 0;
  for (const scope of scopes) {
    for (let lap = 0; lap < jobsPerScope; lap++) {
      const outcome = await claimRunSettle(store, runner, scope, log, options);
      if (outcome === "none") break;
      if (outcome === "ok") ran++;
      else failed++;
    }
  }
  return { scopes: scopes.length, ran, failed };
}
