import { parseReflectionRoundMessage, type ReflectionHistoryCheckpoint } from "./commit-contract";

export interface HistoryCommit {
  sha: string;
  message: string;
  committedAt: string | null;
  parents?: string[];
}

export interface SummaryMaterial {
  sha: string;
  sliceId: string;
  turnIds: string[];
}

/** Locator lines describe where records live; only changed material creates work. */
export function summaryMaterial(commit: HistoryCommit): SummaryMaterial[] {
  const prefix = /^Summary — (\d{4}-\d{2}-\d{2}-\d{4})(?:\r?\n|$)/.exec(commit.message);
  if (!prefix) return [];
  const locations = new Map<string, string>();
  for (const line of commit.message.split("\n")) {
    const match = /^- record (\S+) in (\d{4}-\d{2}-\d{2}-\d{4})$/.exec(line.trim());
    if (match) locations.set(match[1], match[2]);
  }
  const grouped = new Map<string, Set<string>>();
  for (const line of commit.message.split("\n")) {
    const match = /^- (?:user turn|reply|cognition|merge) (\S+)$/.exec(line.trim());
    if (!match) continue;
    const sliceId = locations.get(match[1]) ?? prefix[1];
    if (!grouped.has(sliceId)) grouped.set(sliceId, new Set());
    grouped.get(sliceId)!.add(match[1]);
  }
  return [...grouped].map(([sliceId, turns]) => ({ sha: commit.sha, sliceId, turnIds: [...turns] }));
}

/**
 * A checkpoint accounts for a complete ancestor set, with explicit pending
 * exceptions. A later summary is a NEW material version, even for an old turn.
 * Neither timestamps nor the panel's row limit determine acknowledgement.
 */
export function projectReflectionHistory(
  commits: HistoryCommit[],
  basis: string,
  checkpoint?: ReflectionHistoryCheckpoint,
): ReflectionHistoryCheckpoint {
  const pending = new Map<string, SummaryMaterial>();
  const prefixMaterial = new Set((checkpoint?.pending ?? []).map(m => m.sha));
  const key = (m: SummaryMaterial) => `${m.sha}:${m.sliceId}`;
  for (const material of checkpoint?.pending ?? []) pending.set(key(material), { ...material, turnIds: [...material.turnIds] });
  for (const commit of commits) {
    for (const material of summaryMaterial(commit)) pending.set(key(material), material);
  }

  const graph = new Map(commits.map(c => [c.sha, c]));
  const position = new Map(commits.map((c, i) => [c.sha, i]));
  const ancestorCache = new Map<string, Set<string>>();
  const ancestors = (sha: string) => {
    let result = ancestorCache.get(sha);
    if (result) return result;
    result = new Set<string>();
    const queue = [...(graph.get(sha)?.parents ?? [])];
    while (queue.length) {
      const next = queue.pop()!;
      if (result.has(next)) continue;
      result.add(next);
      queue.push(...(graph.get(next)?.parents ?? []));
    }
    ancestorCache.set(sha, result);
    return result;
  };
  let cursor = checkpoint?.cursor ?? null;
  let evolved = checkpoint?.evolved ?? null;
  let latestNote = checkpoint?.latestNote;
  let foundNote = false;
  for (const commit of commits) {
    const round = parseReflectionRoundMessage(commit.message);
    if (!foundNote && round?.note) {
      latestNote = { note: round.note, at: commit.committedAt ?? commit.sha };
      foundNote = true;
    }
    const trailer = round?.trailer;
    if (!trailer || trailer.superseded) continue;
    const furthest = trailer.seen?.map(m => m.sliceId).sort().at(-1);
    if (furthest && (!cursor || furthest > cursor)) cursor = furthest;
    if (trailer.evolved && (!evolved || trailer.evolved.date > evolved)) evolved = trailer.evolved.date;
    for (const material of pending.values()) {
      // Exact material receipts are safe across merges and late additions.
      const receipts = trailer.observed?.filter(m => m.sha === material.sha && m.sliceId === material.sliceId);
      if (receipts?.length) {
        const seen = new Set(receipts.flatMap(m => m.turnIds));
        material.turnIds = material.turnIds.filter(t => !seen.has(t));
        continue;
      }
      // Legacy seen lines only acknowledge material that existed in that
      // round's ancestry. Never let an older round consume a later reply.
      if (trailer.observed !== undefined || !trailer.seen?.length) continue;
      const existed = commit.parents !== undefined
        ? ancestors(commit.sha).has(material.sha) || Boolean(checkpoint && prefixMaterial.has(material.sha) && ancestors(commit.sha).has(checkpoint.basis))
        : (position.get(material.sha) ?? -1) > (position.get(commit.sha) ?? Infinity);
      if (!existed) continue;
      for (const mark of trailer.seen) {
        if (mark.turnIds === undefined && material.sliceId <= mark.sliceId) material.turnIds = [];
        else if (mark.sliceId === material.sliceId) material.turnIds = material.turnIds.filter(t => !mark.turnIds?.includes(t));
      }
    }
  }
  return { version: 1, basis, cursor, evolved, pending: [...pending.values()].filter(m => m.turnIds.length > 0), ...(latestNote ? { latestNote } : {}) };
}

/** Build the next prefix snapshot from this round's ORIGINAL read basis. */
export function settleHistoryCheckpoint(
  history: ReflectionHistoryCheckpoint,
  scope: Array<{ sliceId: string; turnIds: string[] }>,
  evolvedDate?: string,
): ReflectionHistoryCheckpoint {
  const processed = new Map(scope.map(s => [s.sliceId, new Set(s.turnIds)]));
  const cursor = scope.map(s => s.sliceId).concat(history.cursor ?? []).sort().at(-1) ?? null;
  return {
    ...history,
    cursor,
    evolved: evolvedDate && (!history.evolved || evolvedDate > history.evolved) ? evolvedDate : history.evolved,
    pending: history.pending.map(m => ({ ...m, turnIds: m.turnIds.filter(t => !processed.get(m.sliceId)?.has(t)) })).filter(m => m.turnIds.length > 0),
  };
}
