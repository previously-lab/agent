/**
 * The archive's NON-case reference grammar (v0.25b §三) — the two ref kinds
 * that name papers which are not cases:
 *
 *   records/<sliceId>      → a slice's transcript (原文级, the turns as said)
 *   dossier/previously     → memory/episodic/current-previously.md
 *   dossier/direction      → memory/evolution/direction.md
 *
 * `records` and `dossier` are NOT case categories, so a ref in either kind
 * can never parse as a case — but `parseCaseRef`'s legacy fallback WOULD
 * read `records/2026-10-05-1430` as a legacy name (the last segment passes
 * the dated-piece validator), so every reader routes on these parsers FIRST
 * (the desk's `deskRefKind` below is the one place that orders it).
 *
 * Pure and server-free: the desk model (client + vitest) and the archive
 * actions (server) both import from here — a `"use server"` module may not
 * export sync functions, which is why this file exists.
 */

/** The `records/<sliceId>` grammar — four id segments, digits only (the live
 *  enumeration's own shape; the red line that keeps path traversal out of
 *  the slice read). */
const RECORD_REF_RE = /^records\/(\d{4}-\d{2}-\d{2}-\d{4})$/;

/** Parse a record reference; null when it is not one (or not a legal one). */
export function parseRecordRef(refText: string): { sliceId: string } | null {
  const m = RECORD_REF_RE.exec(refText.trim());
  return m ? { sliceId: m[1] } : null;
}

/** The Dossier's two documents (the library's pinned section). */
export type DossierDocName = "previously" | "direction";

/** Parse a dossier reference; null when it is not one. */
export function parseDossierRef(
  refText: string,
): { name: DossierDocName } | null {
  const s = refText.trim();
  if (!s.startsWith("dossier/")) return null;
  const name = s.slice("dossier/".length);
  return name === "previously" || name === "direction" ? { name } : null;
}

/** The desk's read-path routing: which vocabulary a ref speaks. "case" here
 *  means the case grammar's whole domain (case / piece / legacy). */
export type DeskRefKind = "record" | "dossier" | "case";

export function deskRefKind(refText: string): DeskRefKind {
  if (parseRecordRef(refText)) return "record";
  if (parseDossierRef(refText)) return "dossier";
  return "case";
}

/** The transcript paper's speaker labels — locale strings, handed to the
 *  record read by the client (the desk's injected texts), never hardcoded
 *  server-side. */
export interface RecordSpeakerLabels {
  user: string;
  agent: string;
}
