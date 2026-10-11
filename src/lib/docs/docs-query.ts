/**
 * Document query layer (v0.15 design §2.5, §4.2) — the reader side of the
 * document system. The directory-listing and point-read queries
 * (`listDocsQuery` / `readDocQuery`) were retired with their executors; what
 * remains is the slice-id extraction the doc_rework probe rides on.
 */

/** Slice ids embedded in text, e.g. `2026-07-24-1500` (the L0 evidence refs). */
const SLICE_ID_GLOBAL = /\b\d{4}-\d{2}-\d{2}-\d{4}\b/g;

/** Cap the recorded set per document — bound for instrumentation state. */
const MAX_EXTRACTED_SLICE_IDS = 100;

/**
 * Extract the slice ids a document references (design §4.1: documents cite
 * slices by id). Used by the doc_rework probe (§4.4): if the main agent
 * reads a document and then opens one of the slices THAT document pointed
 * at, the document was not credited for that fact — an implicit demerit
 * recorded against the memory-quality bucket.
 */
export function extractSliceIds(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(SLICE_ID_GLOBAL)) {
    found.add(match[0]);
    if (found.size >= MAX_EXTRACTED_SLICE_IDS) break;
  }
  return [...found];
}
