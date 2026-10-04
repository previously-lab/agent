"use server";

import {
  filterByWindow,
  searchCatalog,
  type SearchHit,
} from "./slice-search";
import { getTimelineCatalog } from "@/lib/episodic/actions";

/**
 * Search the slice catalog for the user-facing command palette (v0.10 §3.2).
 *
 * The corpus is the LIVE enumeration's point-read headers (v0.19 R3b —
 * `getTimelineCatalog`, no projection). A search is a whole-corpus question,
 * so this is one of the read paths that pays a header read per slice; the
 * Data Cache absorbs repeats within its TTL. The demo persona / MEMORY_ROOT
 * dual-datasource behavior lives in the shared fs layer underneath, so no
 * persona handling is needed here.
 *
 * `from`/`to` bound the search to an inclusive YYYY-MM-DD window before
 * scoring. Returns scored hits (empty array when nothing matches or no
 * slices exist yet).
 */
export async function searchSlices(
  query: string,
  opts?: { from?: string; to?: string },
): Promise<SearchHit[]> {
  const entries = await getTimelineCatalog();
  const windowed = filterByWindow(entries, opts?.from, opts?.to);
  return searchCatalog(windowed, query);
}
