"use server";

import { getRun } from "workflow/api";
import { getWorld } from "workflow/runtime";
import type { PersistenceReceipt, SummaryRunOutcome, TurnRunResult } from "./turn-types";
import { mergePersistenceReceipts } from "./persistence-receipt";

export type PersistenceState =
  | { state: "pending" | "unknown" }
  | { state: "committed"; receipt: PersistenceReceipt }
  | { state: "failed"; error: string };

function receiptFrom(value: unknown): PersistenceReceipt | null {
  const receipt = value as PersistenceReceipt | undefined;
  return receipt?.version === 1 && typeof receipt.commitSha === "string" && receipt.commitSha.length > 0 &&
    Array.isArray(receipt.records) && receipt.records.every((record) =>
      typeof record.sliceId === "string" && Array.isArray(record.turnIds) && record.turnIds.every((id) => typeof id === "string"))
    ? receipt : null;
}

/** Run completion and successful persistence are separate facts. */
export async function getPersistenceState(summaryRunId: string): Promise<PersistenceState> {
  try {
    const run = getRun<SummaryRunOutcome>(summaryRunId);
    const status = await run.status;
    if (status === "pending" || status === "running") return { state: "pending" };
    if (status === "failed" || status === "cancelled") return { state: "failed", error: `Persistence ${status}` };
    const outcome = await run.returnValue;
    const receipt = receiptFrom(outcome?.receipt);
    if ((outcome?.kind === "committed" || outcome?.kind === "deduped") && receipt) return { state: "committed", receipt };
    if (outcome?.kind === "failed") return { state: "failed", error: outcome.error ?? "Persistence failed" };
    return { state: "unknown" };
  } catch {
    return { state: "unknown" };
  }
}

export interface ChatRecovery {
  records: Array<{ runId: string; record: TurnRunResult }>;
  activeRunIds: string[];
  savedRunIds: string[];
  savedSummaryRunIds?: string[];
  receipts: PersistenceReceipt[];
  unavailableRunIds: string[];
  failures: Array<{ runId: string; error: string }>;
}

/** Recover unacknowledged answers from durable runs, never from a browser transcript. */
export async function getChatRecovery(runIds: string[], summaryRunIds: string[] = []): Promise<ChatRecovery> {
  summaryRunIds = [...summaryRunIds];
  const result: ChatRecovery = { records: [], activeRunIds: [], savedRunIds: [], savedSummaryRunIds: [], receipts: [], unavailableRunIds: [], failures: [] };
  const summaries = new Map<string, Promise<PersistenceState>>();
  const readSummary = (id: string) => {
    let pending = summaries.get(id);
    if (!pending) { pending = getPersistenceState(id); summaries.set(id, pending); }
    return pending;
  };
  const records: Array<{ runId: string; record: TurnRunResult }> = [];
  const unreturned = new Map<string, string | undefined>();
  for (const runId of new Set(runIds)) {
    try {
      const run = getRun<TurnRunResult>(runId);
      const status = await run.status;
      if (status === "pending" || status === "running") { result.activeRunIds.push(runId); continue; }
      if (status !== "completed") {
        // A summary start can be accepted even when its response is lost. The
        // parent may fail without a return value while that child still commits.
        let turnId: string | undefined;
        try {
          const source = await (await getWorld()).runs.get(runId, { resolveData: "none" });
          turnId = (source as { attributes?: Record<string, string> }).attributes?.turn;
        } catch { /* unknown source metadata keeps the dependency pending */ }
        unreturned.set(runId, turnId);
        continue;
      }
      const record = await run.returnValue;
      if (!record || typeof record.turnId !== "string" || typeof record.userText !== "string" || typeof record.replyText !== "string") {
        result.unavailableRunIds.push(runId); continue;
      }
      records.push({ runId, record });
      if (record.summaryRunId) summaryRunIds.push(record.summaryRunId);
    } catch (error) {
      console.warn("[chat/recovery] run unavailable", runId, error instanceof Error ? error.message : String(error));
      result.unavailableRunIds.push(runId);
    }
  }
  // Exact turn/burst attributes recover a handoff whose response was lost, and
  // join earlier burst members to the last member's summary. A bounded registry
  // miss proves nothing: retain the pointer until a receipt covers its turn.
  if (unreturned.size > 0 || records.some(({ record }) => !record.summaryRunId)) {
    try {
      const page = await (await getWorld()).runs.list({ pagination: { limit: 100 }, resolveData: "none" });
      const bursts = new Set(records.map(({ record }) => record.burstId).filter(Boolean));
      const turns = new Set([...unreturned.values(), ...records.map(({ record }) => record.turnId)].filter(Boolean));
      for (const row of page.data) {
        const attrs = (row as { attributes?: Record<string, string> }).attributes;
        if (attrs?.role === "summary" && (turns.has(attrs.turn) || bursts.has(attrs.burst))) summaryRunIds.push(row.runId);
      }
    } catch { /* the carried records still remain recoverable */ }
  }
  for (const summaryRunId of new Set(summaryRunIds)) {
    const state = await readSummary(summaryRunId);
    if (state.state === "committed") result.savedSummaryRunIds!.push(summaryRunId);
    if (state.state === "committed") result.receipts.push(state.receipt);
    if (state.state === "failed") result.failures.push({ runId: summaryRunId, error: state.error });
  }
  result.receipts = mergePersistenceReceipts(result.receipts);
  const covered = new Set(result.receipts.flatMap((receipt) => receipt.records.flatMap((record) => record.turnIds)));
  for (const entry of records) {
    if (covered.has(entry.record.turnId)) result.savedRunIds.push(entry.runId);
    else result.records.push(entry);
  }
  for (const [runId, turnId] of unreturned) {
    if (turnId && covered.has(turnId)) result.savedRunIds.push(runId);
    else result.unavailableRunIds.push(runId);
  }
  return result;
}

/**
 * Whether the answer is still running. A completed answer can still have a
 * pending summary; getChatRecovery handles that separate persistence state.
 *
 * The client never guesses this from timestamps or silence windows; it asks
 * here. Unknown/expired runs answer false.
 */
export async function isChatRunActive(runId: string): Promise<boolean> {
  try {
    const status = await getRun(runId).status;
    return status === "pending" || status === "running";
  } catch {
    return false;
  }
}
