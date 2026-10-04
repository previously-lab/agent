/**
 * Records path constants — the SINGLE place that knows where time slices live
 * (v0.19 §B.5 / §D.1).
 *
 * The records root moved from `memory/episodic/slices/YYYY/MM/DD/HHMM/` (with a
 * `timeline/` level inside) to `memory/records/YYYY/MM/DD/HHMM/` (flat:
 * core.md / agent.md / previously.md / attachments/). The rules:
 *
 * - WRITES go to the NEW root only. The legacy root is never written.
 * - READS dual-probe: new root first, legacy root on a miss (`*PathCandidates`
 *   lists are ordered that way; `readSlicePart*` walk them).
 * - Backfill-style maintenance writes (focus/summary on a closed slice) land
 *   IN PLACE — on whichever root the read hit (`readSlicePartResolved`).
 *
 * No other module may hardcode either root. The global projections
 * (`memory/episodic/timeline/*`) are retired since v0.19 R3 — nothing reads or
 * writes them; any file still on disk is inert legacy data.
 */
import { fsReadFile, type WriteBatch } from "./io-helpers";

/** New root: `memory/records/YYYY/MM/DD/HHMM/{core,agent,previously}.md`. */
export const RECORDS_ROOT = "memory/records";
/** Legacy root (read-only): `memory/episodic/slices/YYYY/MM/DD/HHMM/...`. */
export const LEGACY_SLICES_ROOT = "memory/episodic/slices";

export type SlicePart = "core" | "agent" | "previously";

/**
 * Derive the root-relative path (`YYYY/MM/DD/HHMM`) from a slice_id.
 * New format:  `YYYY-MM-DD-HHMM` → `YYYY/MM/DD/HHMM`
 * Legacy:      `YYYY-MM-DD`      → `YYYY/MM/DD`   (kept for robustness)
 */
export function sliceIdToRelPath(sliceId: string): string {
  const p = sliceId.split("-");
  return p.length >= 4
    ? `${p[0]}/${p[1]}/${p[2]}/${p[3]}`
    : `${p[0]}/${p[1]}/${p[2]}`;
}

/** Day directory under a root: `<root>/YYYY/MM/DD` for a UTC date. */
export function dayDirForDate(root: string, d: Date): string {
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${root}/${year}/${month}/${day}`;
}

// ─── Write targets (new root only) ───────────────────────────────────────

/** The slice's directory under the new root: `memory/records/YYYY/MM/DD/HHMM`. */
export function sliceDir(sliceId: string): string {
  return `${RECORDS_ROOT}/${sliceIdToRelPath(sliceId)}`;
}

/**
 * The WRITE path for one slice part — always the new root. The new layout is
 * flat (no `timeline/` level): core.md / agent.md / previously.md sit directly
 * in the slice directory.
 */
export function slicePartPath(sliceId: string, part: SlicePart): string {
  return `${sliceDir(sliceId)}/${part}.md`;
}

/** The new-root monthly index: `memory/records/YYYY/MM/_index.json`. */
export function recordsIndexPath(year: number, month: number): string {
  const mm = String(month).padStart(2, "0");
  return `${RECORDS_ROOT}/${year}/${mm}/_index.json`;
}

// ─── Legacy mapping (read-only) ──────────────────────────────────────────

/** The legacy path for one slice part (the pre-v0.19 layout). */
export function legacySlicePartPath(sliceId: string, part: SlicePart): string {
  const rel = sliceIdToRelPath(sliceId);
  return part === "previously"
    ? `${LEGACY_SLICES_ROOT}/${rel}/previously.md`
    : `${LEGACY_SLICES_ROOT}/${rel}/timeline/${part}.md`;
}

/** The legacy monthly index: `memory/episodic/slices/YYYY/MM/_index.json`. */
export function legacyIndexPath(year: number, month: number): string {
  const mm = String(month).padStart(2, "0");
  return `${LEGACY_SLICES_ROOT}/${year}/${mm}/_index.json`;
}

// ─── Dual-root reads ─────────────────────────────────────────────────────

/**
 * Read candidates for one slice part, in probe order: new root first, legacy
 * root on a miss.
 */
export function slicePartPathCandidates(
  sliceId: string,
  part: SlicePart,
): [string, string] {
  return [slicePartPath(sliceId, part), legacySlicePartPath(sliceId, part)];
}

/** Monthly index candidates in probe order (new first, legacy on a miss). */
export function indexPathCandidates(
  year: number,
  month: number,
): [string, string] {
  return [recordsIndexPath(year, month), legacyIndexPath(year, month)];
}

/**
 * Dual-root read: returns the part's content from the first root that has it.
 * Throws when neither root holds the file (same contract as a plain read of a
 * missing file), so existing catch-based callers degrade unchanged.
 */
export async function readSlicePart(
  sliceId: string,
  part: SlicePart,
  batch?: WriteBatch,
): Promise<string> {
  const [primary, fallback] = slicePartPathCandidates(sliceId, part);
  try {
    return await fsReadFile(primary, batch);
  } catch {
    return fsReadFile(fallback, batch);
  }
}

/**
 * Dual-root read that also reports WHICH path hit — for in-place maintenance
 * writes (backfill marks), which must land on the root the content came from.
 * Returns null when neither root holds the file.
 */
export async function readSlicePartResolved(
  sliceId: string,
  part: SlicePart,
  batch?: WriteBatch,
): Promise<{ path: string; content: string } | null> {
  for (const path of slicePartPathCandidates(sliceId, part)) {
    try {
      return { path, content: await fsReadFile(path, batch) };
    } catch {
      // miss on this root — probe the next
    }
  }
  return null;
}
