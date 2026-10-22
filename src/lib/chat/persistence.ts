import type { ChatRecovery } from "./actions";
import type { PersistenceReceipt } from "./turn-types";
import { persistenceReceiptKey } from "./persistence-receipt";

const KEY = "previously:pending-persistence:v1";
type Pending = { runIds: string[]; summaryRunIds: string[] };
const changes = new Set<() => void>();
const commits = new Set<(receipt: PersistenceReceipt) => void>();
const seen = new Set<string>();

export function readPendingPersistence(): Pending {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? "null") as Pending | null;
    const ids = (input: unknown) => Array.isArray(input) ? [...new Set(input.filter((id): id is string => typeof id === "string"))] : [];
    return { runIds: ids(value?.runIds), summaryRunIds: ids(value?.summaryRunIds) };
  } catch { return { runIds: [], summaryRunIds: [] }; }
}

function writePending(value: Pending, notify = true) {
  try { localStorage.setItem(KEY, JSON.stringify(value)); } catch { /* private browsing */ }
  if (notify) for (const listener of changes) listener();
}

/** Persist dependency identifiers only; completed conversation text comes from the run. */
export function rememberTurnRun(runId: string) {
  const pending = readPendingPersistence();
  writePending({ ...pending, runIds: [...new Set([...pending.runIds, runId])] });
}

export function rememberSummaryRun(summaryRunId: string) {
  const pending = readPendingPersistence();
  writePending({ ...pending, summaryRunIds: [...new Set([...pending.summaryRunIds, summaryRunId])] });
}

export function acceptPersistenceRecovery(recovery: ChatRecovery) {
  const pending = readPendingPersistence();
  const acknowledged = new Set(recovery.savedRunIds);
  // A summary can cover many turns. Keep its pointer while any carried record
  // still depends on it; failed/legacy runs without a receipt remain recoverable.
  const confirmedSummaries = new Set(recovery.savedSummaryRunIds ?? []);
  writePending({
    runIds: pending.runIds.filter((id) => !acknowledged.has(id)),
    summaryRunIds: pending.summaryRunIds.filter((id) => !confirmedSummaries.has(id)),
  }, false);
  for (const receipt of recovery.receipts) {
    const key = persistenceReceiptKey(receipt);
    if (seen.has(key)) continue;
    seen.add(key);
    if (seen.size > 500) seen.delete(seen.values().next().value!);
    for (const listener of commits) listener(receipt);
  }
}

export function subscribePendingPersistence(listener: () => void) {
  changes.add(listener);
  return () => { changes.delete(listener); };
}

export function subscribePersistenceCommits(listener: (receipt: PersistenceReceipt) => void) {
  commits.add(listener);
  return () => { commits.delete(listener); };
}
