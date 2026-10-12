"use server";

import {
  filterByWindow,
  searchCatalog,
  type SearchHit,
} from "./slice-search";
import {
  getTimelineCatalog,
  getTimelineSkeleton,
} from "@/lib/episodic/actions";
import { sliceEntryFromDisk } from "@/lib/episodic/timeline/store";
import { sliceIdToRelPath } from "@/lib/episodic/paths";
import type { TimelineSliceEntry } from "@/lib/episodic/timeline/types";

/**
 * Point-read fan-out for the windowed path. A wide window is still a bounded
 * set, and a small cap keeps the tree/blob layer's per-read parallelism
 * predictable instead of bursting the whole window at once.
 */
const WINDOW_READ_CONCURRENCY = 12;

async function mapLimited<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next;
        next += 1;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

/**
 * Search the slice catalog for the user-facing command palette (v0.10 §3.2).
 *
 * Two read paths, picked by whether a window bounds the query:
 *
 * - UNWINDOWED (no `from`/`to`): a whole-corpus question pays a header read
 *   per slice via `getTimelineCatalog` (v0.19 R3b — the live enumeration, no
 *   projection). Those headers now ride the tree/blob layer's 24h
 *   closed-record TTL, so the steady state is bounded and repeats inside the
 *   TTL are free.
 * - WINDOWED: the tree-only skeleton (`getTimelineSkeleton`, zero point
 *   reads) is windowed first, then headers are point-read ONLY for the ids
 *   inside the window — a narrow window never pays for the whole corpus.
 *   Oldest → newest order is preserved, so match and ranking semantics are
 *   identical to the unwindowed path.
 *
 * The demo persona / MEMORY_ROOT dual-datasource behavior lives in the shared
 * fs layer underneath, so no persona handling is needed here.
 *
 * `from`/`to` bound the search to an inclusive YYYY-MM-DD window before
 * scoring. Returns scored hits (empty array when nothing matches or no
 * slices exist yet).
 */
export async function searchSlices(
  query: string,
  opts?: { from?: string; to?: string },
): Promise<SearchHit[]> {
  if (!opts?.from && !opts?.to) {
    const entries = await getTimelineCatalog();
    return searchCatalog(filterByWindow(entries), query);
  }
  const skeleton = await getTimelineSkeleton();
  const windowed = filterByWindow(skeleton, opts.from, opts.to);
  const entries = (
    await mapLimited(windowed, WINDOW_READ_CONCURRENCY, (entry) =>
      sliceEntryFromDisk(sliceIdToRelPath(entry.id)),
    )
  ).filter((entry): entry is TimelineSliceEntry => entry !== null);
  return searchCatalog(entries, query);
}
