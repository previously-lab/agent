import type { ChatRecovery } from "./actions";
import type { PersistenceReceipt } from "./turn-types";
import { persistenceReceiptKey } from "./persistence-receipt";
import { recoveryMessages } from "./reconnect";
import { rememberNativeReplay } from "./native-replay";

const KEY = "previously:pending-persistence:v1";
export const ACTIVE_RUN_ID_KEY = "previously:activeRunId";
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
  rememberNativeReplay(recoveryMessages(recovery.records.map(({ record }) => record)));
  const pending = readPendingPersistence();
  const released = new Set([...recovery.savedRunIds, ...(recovery.missingRunIds ?? []), ...(recovery.abandonedRunIds ?? [])]);
  // A missing workflow is abandoned, not saved. Only receipts below publish
  // commits; transient failures and still-running dependencies remain pending.
  const releasedSummaries = new Set([...(recovery.savedSummaryRunIds ?? []), ...(recovery.missingSummaryRunIds ?? [])]);
  writePending({
    runIds: pending.runIds.filter((id) => !released.has(id)),
    summaryRunIds: pending.summaryRunIds.filter((id) => !releasedSummaries.has(id)),
  }, false);
  // Background recovery can discover a missing active run after arrival has
  // already proceeded. Invalidate that exact pointer too, so a later mount
  // cannot reintroduce the dead ID into the now-clean pending queue.
  try {
    const active = localStorage.getItem(ACTIVE_RUN_ID_KEY);
    if (active && [...(recovery.missingRunIds ?? []), ...(recovery.abandonedRunIds ?? [])].includes(active)) localStorage.removeItem(ACTIVE_RUN_ID_KEY);
  } catch { /* Private browsing; recovery remains best-effort. */ }
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
