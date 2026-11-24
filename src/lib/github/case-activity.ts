import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { cachedFetch, CACHE_TTLS } from "@/lib/cache/data-cache";
import { currentGitHubReadDeadline } from "@/lib/github/client";
import { readStoredCaseActivity, type CaseActivitySource } from "@/lib/memory/case-activity";
import { getRepoTreeEntry, readTextFromCompleteTree, type RepoTree } from "@/lib/tools/readFile";

type IndexedCase = CaseActivitySource & { indexPath: string };
type DateRow = [indexPath: string, date: string];
type DateTable = { rows: DateRow[]; complete: boolean };

class IncompleteTable extends Error {
  constructor(readonly table: DateTable) { super("Incomplete case activity dates"); }
}

const pendingTables = new Map<string, Promise<DateTable>>();

/** A failed header read may degrade this search's order, never subsequent searches. */
async function cachedTable(key: string[], build: () => Promise<DateTable>): Promise<DateTable> {
  // Distinct searches can build the same immutable category or group on a cold
  // instance. Share only in-flight work for this owner, repo, object and budget.
  const flightKey = JSON.stringify([key, currentGitHubReadDeadline()]);
  const existing = pendingTables.get(flightKey);
  if (existing) return existing;
  // Next bypasses cache hits for unstable_cache calls nested inside a miss.
  // Run the immutable dependencies in the caller's original read context, so
  // an updated category can still reuse cached groups and warm Git blobs.
  const loadDependencies = AsyncLocalStorage.bind(build);
  const pending = cachedFetch(key, CACHE_TTLS.BLOB_SECONDS, [], async () => {
    const table = await loadDependencies();
    if (!table.complete) throw new IncompleteTable(table);
    return table;
  }).catch((error: unknown) => {
    if (error instanceof IncompleteTable) return error.table;
    throw error;
  });
  pendingTables.set(flightKey, pending);
  try {
    return await pending;
  } finally {
    pendingTables.delete(flightKey);
  }
}

function groups<K, V>(items: V[], keyOf: (item: V) => K): Map<K, V[]> {
  const result = new Map<K, V[]>();
  for (const item of items) {
    const key = keyOf(item);
    const group = result.get(key);
    if (group) group.push(item);
    else result.set(key, [item]);
  }
  return result;
}

/** The category tree identifies the complete set of active case headers. Within
 * it, hash-partition the paths so a rename or edit rebuilds only small groups.
 * Callers supply all cases in each requested category from this exact tree.
 */
export async function gitHubCaseActivityDates(
  tree: RepoTree, sources: CaseActivitySource[], repo: string, owner: string,
): Promise<Map<string, string> | undefined> {
  if (tree.truncated) return undefined;
  const indexed = sources.filter((node): node is IndexedCase => node.indexPath !== null);
  const categories = groups(indexed, node => node.treeDir);
  // Schedule individual headers across categories. A single large group can
  // never monopolize the eight GitHub read lanes for its entire rebuild.
  const lanes: Promise<void>[] = Array.from({ length: 8 }, () => Promise.resolve());
  let nextLane = 0;
  const read = (path: string) => {
    const lane = nextLane++ % lanes.length;
    const pending = lanes[lane]!.then(() => readTextFromCompleteTree(tree, path, repo, owner));
    lanes[lane] = pending.then(() => {}, () => {});
    return pending;
  };
  const tables = await Promise.all([...categories].map(async ([category, nodes]) => {
    const subtree = getRepoTreeEntry(tree, `memory/${category}`);
    if (subtree?.type !== "tree") return { rows: [], complete: false } satisfies DateTable;
    return cachedTable(["github", "case-dates-v1", owner, repo, category, subtree.sha], async () => {
      const buckets = groups(nodes, node => createHash("sha256").update(node.indexPath).digest()[0]! % 32);
      const parts = await Promise.all([...buckets.values()].map(bucket => {
        // Piece dates are folded into the sort order directly from the live tree.
        const headers = bucket.map(node => [node.indexPath, getRepoTreeEntry(tree, node.indexPath)?.sha,
          node.currentPath && getRepoTreeEntry(tree, node.currentPath)?.sha]);
        const signature = createHash("sha256").update(JSON.stringify(headers)).digest("hex");
        return cachedTable(["github", "case-date-group-v1", owner, repo, signature], async () => {
          const rows: DateRow[] = [];
          let complete = true;
          for (const node of bucket) {
            const activity = await readStoredCaseActivity(node, read);
            rows.push([node.indexPath, activity.date]);
            if (!activity.complete) complete = false;
          }
          return { rows, complete };
        });
      }));
      return { rows: parts.flatMap(part => part.rows), complete: parts.every(part => part.complete) };
    });
  }));
  return new Map(tables.flatMap(table => table.rows));
}
