import type { PersistenceReceipt } from "./turn-types";

/** Canonical coverage matters as well as HEAD: deduped writes share a SHA. */
export function persistenceReceiptKey(receipt: PersistenceReceipt): string {
  const coverage = new Map<string, Set<string>>();
  for (const record of receipt.records) {
    const turns = coverage.get(record.sliceId) ?? new Set<string>();
    for (const id of record.turnIds) turns.add(id);
    coverage.set(record.sliceId, turns);
  }
  return JSON.stringify([receipt.commitSha, [...coverage].sort(([a], [b]) => a.localeCompare(b)).map(([sliceId, turns]) => [sliceId, [...turns].sort()])]);
}

export function mergePersistenceReceipts(receipts: PersistenceReceipt[]): PersistenceReceipt[] {
  const commits = new Map<string, Map<string, Set<string>>>();
  for (const receipt of receipts) {
    const coverage = commits.get(receipt.commitSha) ?? new Map<string, Set<string>>();
    for (const record of receipt.records) {
      const turns = coverage.get(record.sliceId) ?? new Set<string>();
      for (const id of record.turnIds) turns.add(id);
      coverage.set(record.sliceId, turns);
    }
    commits.set(receipt.commitSha, coverage);
  }
  return [...commits].map(([commitSha, coverage]) => ({ version: 1, commitSha, records: [...coverage].map(([sliceId, turns]) => ({ sliceId, turnIds: [...turns] })) }));
}
