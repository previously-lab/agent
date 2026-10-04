/**
 * Home recap (v0.13 §3) — the smallest honest memory summary the start screen
 * needs: how many slices exist, and when the last conversation left off.
 *
 * Read path (v0.19 R3b / §A.2.4): LIVE ENUMERATION, no projection. The slice
 * set is enumerated from the tree (`enumerateSliceIds`, dual-root — the new
 * records root plus the legacy slices root, one GitHub Trees call or a local
 * walk), and only the newest few slice files are point-read (`loadSlice`,
 * dual-root via `readSlicePart`). The retired `timeline/index.json` projection
 * is never consulted. No cache, no store of its own.
 *
 * One judgement call: the recap follows the NEWEST slice that actually holds
 * conversation, whatever its status — a still-active newest slice IS where
 * the last conversation left off, and pointing at an older closed slice
 * would describe a conversation the reader has already moved past.
 */
import { loadSlice } from "@/lib/episodic/manager";
import { enumerateSliceIds } from "@/lib/episodic/timeline/enumerate";

/** How far down the tail to look for a readable, non-empty slice. */
const PHANTOM_SKIP_CAP = 3;

export interface HomeRecap {
  /** Where the conversation left off — its last turn's instant, UTC ISO. */
  lastAt: string;
  /** IANA timezone the slice recorded — the recap's clock is the reader's. */
  timezone: string;
}

export interface HomeMemoryState {
  sliceCount: number;
  recap: HomeRecap | null;
}

export async function getHomeMemoryState(): Promise<HomeMemoryState> {
  // Slice ids sort lexicographically = chronologically (the id encodes the
  // UTC start to the minute), so the enumeration's count IS the slice count
  // and its tail IS the newest end.
  const rels = await enumerateSliceIds().catch(() => [] as string[]);
  const ids = rels.map((rel) => rel.replaceAll("/", "-")).sort();
  if (ids.length === 0) return { sliceCount: 0, recap: null };

  // Newest first. Slice files that are missing (phantoms) or hold no turns
  // are skipped, never faked — bounded so a corrupt tail can't turn one card
  // into a full-history scan.
  const newestFirst = [...ids].reverse();
  for (const id of newestFirst.slice(0, PHANTOM_SKIP_CAP)) {
    const slice = await loadSlice(id).catch(() => null);
    if (!slice || slice.turns.length === 0) continue;
    return {
      sliceCount: ids.length,
      recap: {
        lastAt:
          slice.turns[slice.turns.length - 1]?.timestamp ??
          slice.end ??
          slice.start,
        timezone: slice.timezone,
      },
    };
  }
  return { sliceCount: ids.length, recap: null };
}
