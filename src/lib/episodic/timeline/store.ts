/**
 * Timeline store — the slice→entry conversion for the catalog.
 *
 * The projection writers (readTimelineIndex / writeTimelineIndex /
 * writeTimelineMd / upsertTimelineEntry) and the markdown renderer (render.ts)
 * were retired with the weave (v0.19 R3): the month directory is the index
 * now, and nothing reads timeline/index.json or timeline.md anymore. What
 * remains here: sliceEntryFromDisk, the live per-slice header read that
 * src/lib/episodic/actions.ts feeds the catalog UI from.
 *
 * Keep this module dependency-light (gray-matter + io-helpers + turn-parser
 * only) so it never forms a cycle with manager.ts.
 */
import matter from "gray-matter";
import type { WriteBatch } from "../io-helpers";
import { readSlicePart } from "../paths";
import { parseTurns } from "../turn-parser";
import type { TimelineSliceEntry } from "./types";

/** Coerce YAML values — gray-matter parses "A: B" strings as objects. */
function str(v: unknown): string {
  if (typeof v === "string") return v;
  if (v && typeof v === "object") return Object.keys(v)[0] ?? "";
  return "";
}
function strArr(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((e) => (typeof e === "string" ? e : str(e))).filter(Boolean);
}

/**
 * Build a catalog entry by reading a slice's core.md frontmatter.
 * Reads the full file (bounded — the catalog UI point-reads only the slices
 * it displays).
 */
export async function sliceEntryFromDisk(relPath: string, batch?: WriteBatch): Promise<TimelineSliceEntry | null> {
  const [y, m, d, hm] = relPath.split("/");
  try {
    // Dual-root (v0.19 R2): new records root first, legacy slices root on a miss.
    const raw = await readSlicePart(relPath.split("/").join("-"), "core", batch);
    const { data } = matter(raw);
    // parseTurns handles the frontmatter itself — pass the full file.
    const { turns } = parseTurns(raw);
    const focus = str(data.focus);
    const summary = str(data.summary);
    const tags = strArr(data.tags);
    const start = str(data.start);
    // v0.19 R2: status is derived, no longer written — a closed_by cause (or
    // a legacy explicit status: closed) means closed.
    const status = (data.status === "closed" || data.closed_by ? "closed" : "active") as
      | "closed"
      | "active";
    return {
      id: `${y}-${m}-${d}-${hm}`,
      date: `${y}-${m}-${d}`,
      start: start || `${y}-${m}-${d}T00:00:00.000Z`,
      ...(data.end ? { end: str(data.end) } : {}),
      turn_count: turns.length,
      status,
      focus,
      summary,
      tags,
      ...(data.emotional_tone ? { tone: str(data.emotional_tone) } : {}),
      // Continuity metadata — lets the pointer lines mark the checkpoint
      // chain (↳cont) and the close reason instead of rendering a checkpointed
      // conversation as several independent ones.
      ...(data.continues_from ? { continues_from: str(data.continues_from) } : {}),
      ...(data.closed_by ? { closed_by: str(data.closed_by) } : {}),
      open_loops: strArr(data.open_loops),
      decisions: strArr(data.decisions),
      // strands = the tags that exist in the global strand index — the strand
      // layer is retired (§A.2.4); entries are strandless now.
      strands: [],
      needs_marking: !focus && !summary,
    };
  } catch {
    return null; // core.md missing / unreadable — caller skips it
  }
}
