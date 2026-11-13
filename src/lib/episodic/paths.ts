/**
 * Original conversation records live only under
 * `memory/records/YYYY/MM/DD/HHMM/` (core.md / agent.md / previously.md /
 * attachments/). Every reader and writer uses this root. Migration from the
 * retired slices tree is an explicit offline operation, never a runtime probe.
 */
import { fsReadFile, type WriteBatch } from "./io-helpers";

export const RECORDS_ROOT = "memory/records";

export type SlicePart = "core" | "agent" | "previously";

/** Derive the root-relative path (`YYYY/MM/DD/HHMM`) from a slice_id. */
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

export function sliceDir(sliceId: string): string {
  return `${RECORDS_ROOT}/${sliceIdToRelPath(sliceId)}`;
}

export function slicePartPath(sliceId: string, part: SlicePart): string {
  return `${sliceDir(sliceId)}/${part}.md`;
}

export async function readSlicePart(
  sliceId: string,
  part: SlicePart,
  batch?: WriteBatch,
): Promise<string> {
  return fsReadFile(slicePartPath(sliceId, part), batch);
}

/**
 * Resolve the current-root path for maintenance writes. Returns null when the
 * part is absent or unreadable, matching the existing caller contract.
 */
export async function readSlicePartResolved(
  sliceId: string,
  part: SlicePart,
  batch?: WriteBatch,
  /**
   * Reads that feed a write bypass the Data Cache. Display-only reads keep the
   * default cached path. The local backend always reads fresh already.
   */
  opts?: { fresh?: boolean },
): Promise<{ path: string; content: string } | null> {
  const path = slicePartPath(sliceId, part);
  try {
    return { path, content: await fsReadFile(path, batch, opts) };
  } catch {
    return null;
  }
}
