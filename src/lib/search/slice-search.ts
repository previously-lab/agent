/**
 * Shared slice-catalog search — the retrieval implementation behind the
 * user-facing command palette.
 *
 * Pure functions only — no I/O. Callers feed `TimelineSliceEntry[]` in (from
 * the live enumeration's point-read headers, v0.19 R3b) and get scored hits
 * out. The searchable fields are the ones the case-model slice header still
 * carries: focus / summary / open_loops / decisions. `tags` stopped being
 * written in R2 and `strands` were a weave-resolved projection field — both
 * left the weight table with the projection deletion (§A.2.4), and the
 * palette's `#strand` filter syntax went with them. Cross-slice full-text
 * search is a later candidate.
 */

import type { TimelineSliceEntry } from "@/lib/episodic/timeline/types";

/** Catalog fields the keyword query runs against. */
export type SearchableField =
  | "focus"
  | "summary"
  | "open_loops"
  | "decisions";

/** Field weights — focus > summary > open_loops/decisions (§A.2.4). */
const FIELD_WEIGHTS: Record<SearchableField, number> = {
  focus: 4,
  summary: 3,
  open_loops: 2,
  decisions: 2,
};

/** Canonical display order for matchedFields (highest weight first). */
const FIELD_ORDER: SearchableField[] = [
  "focus",
  "summary",
  "open_loops",
  "decisions",
];

/** Snippets kept per field — enough for UI highlight, bounded payload. */
const MAX_SNIPPETS_PER_FIELD = 3;

/** Context radius around a match inside a long string field (summary). */
const SNIPPET_RADIUS = 40;

/** The matched fragments of one field, for UI highlighting. */
export interface FieldMatch {
  field: SearchableField;
  /** Matched text fragments — whole items for array fields (open_loops etc.),
   *  windowed excerpts for long string fields. */
  snippets: string[];
}

export interface SearchHit {
  entry: TimelineSliceEntry;
  /** Weighted score: sum over fields of weight × hit count. */
  score: number;
  /** Fields with at least one match, in weight order. */
  matchedFields: SearchableField[];
  /** Per-field matched fragments. */
  matches: FieldMatch[];
}

/**
 * Filter the entries to an inclusive YYYY-MM-DD date window: the slice id's
 * first 10 chars (its UTC date) are compared lexicographically; either bound
 * may be omitted. Input order is preserved.
 */
export function filterByWindow(
  entries: TimelineSliceEntry[],
  from?: string,
  to?: string,
): TimelineSliceEntry[] {
  return entries.filter((s) => {
    const date = s.id.slice(0, 10); // "YYYY-MM-DD"
    if (from && date < from) return false;
    if (to && date > to) return false;
    return true;
  });
}

/**
 * Newest-first ordering by slice id (the id's UTC timestamp sorts
 * lexicographically).
 */
export function sortNewestFirst(
  entries: readonly TimelineSliceEntry[],
): TimelineSliceEntry[] {
  return [...entries].sort((a, b) => b.id.localeCompare(a.id));
}

/** The keyword the command palette highlights inside snippets. With the
 *  `#strand` syntax gone this is simply the query, trimmed. */
export function queryKeyword(query: string): string {
  return query.trim();
}

/** All case-insensitive occurrences of `needle` in `text` (start indices). */
function occurrences(text: string, needle: string): number[] {
  const hay = text.toLowerCase();
  const out: number[] = [];
  let i = hay.indexOf(needle);
  while (i !== -1) {
    out.push(i);
    i = hay.indexOf(needle, i + needle.length);
  }
  return out;
}

/** Windowed excerpts around each occurrence of `needle` in a long string. */
function stringSnippets(text: string, needle: string): string[] {
  return occurrences(text, needle)
    .slice(0, MAX_SNIPPETS_PER_FIELD)
    .map((i) => {
      const start = Math.max(0, i - SNIPPET_RADIUS);
      const end = Math.min(text.length, i + needle.length + SNIPPET_RADIUS);
      const prefix = start > 0 ? "…" : "";
      const suffix = end < text.length ? "…" : "";
      return `${prefix}${text.slice(start, end)}${suffix}`;
    });
}

/** Score one string field; returns null on no match. */
function matchString(
  text: string,
  keyword: string,
): { count: number; snippets: string[] } | null {
  const hits = occurrences(text, keyword);
  if (hits.length === 0) return null;
  return { count: hits.length, snippets: stringSnippets(text, keyword) };
}

/** Score one array field; matching items are the snippets. */
function matchArray(
  items: string[],
  keyword: string,
): { count: number; snippets: string[] } | null {
  const matched = items.filter((it) => it.toLowerCase().includes(keyword));
  if (matched.length === 0) return null;
  return {
    count: matched.length,
    snippets: matched.slice(0, MAX_SNIPPETS_PER_FIELD),
  };
}

/**
 * Search the entries by keyword (case-insensitive substring over
 * focus/summary/open_loops/decisions).
 *
 * Scoring: per field, weight × hit count (occurrences in string fields,
 * matching items in array fields); summed across fields. Hits sort by score
 * descending, ties broken newest-first by id. An empty query returns [].
 */
export function searchCatalog(
  entries: TimelineSliceEntry[],
  query: string,
): SearchHit[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];

  const hits: SearchHit[] = [];
  for (const entry of entries) {
    const matches: FieldMatch[] = [];
    let score = 0;

    const fields: Array<[SearchableField, string | string[]]> = [
      ["focus", entry.focus],
      ["summary", entry.summary],
      ["open_loops", entry.open_loops],
      ["decisions", entry.decisions],
    ];
    for (const [field, value] of fields) {
      const result = Array.isArray(value)
        ? matchArray(value, needle)
        : matchString(value, needle);
      if (result) {
        score += FIELD_WEIGHTS[field] * result.count;
        matches.push({ field, snippets: result.snippets });
      }
    }

    if (score > 0) {
      // matchedFields in canonical weight order, not field-iteration order.
      const matchedFields = FIELD_ORDER.filter((f) =>
        matches.some((m) => m.field === f),
      );
      hits.push({ entry, score, matchedFields, matches });
    }
  }

  return hits.sort(
    (a, b) => b.score - a.score || b.entry.id.localeCompare(a.entry.id),
  );
}
