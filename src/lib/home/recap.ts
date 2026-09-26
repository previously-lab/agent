/**
 * Home recap (v0.13 §3) — the smallest honest memory summary the start screen
 * needs: how many slices exist, and when the last conversation left off.
 *
 * This is NOT a new reading path. It composes the two reads every other
 * surface already uses — the derived catalog (`readTimelineIndex`, one backend
 * round trip) and a single slice body (`loadSlice`) — and returns only what
 * the home renders: the last turn's instant and the slice's timezone, from
 * which the page formats the dateline (wall-clock + relative gap). No cache,
 * no store: the catalog is already the cheap derived index, and the demo
 * backend caches at the fs layer.
 *
 * One judgement call: the recap follows the NEWEST slice that actually holds
 * conversation, whatever its status — a still-active newest slice IS where
 * the last conversation left off, and pointing at an older closed slice
 * would describe a conversation the reader has already moved past.
 */
import { readTimelineIndex } from "@/lib/episodic/timeline/store";
import { loadSlice } from "@/lib/episodic/manager";

/** How far down the catalog tail to look for a readable, non-empty slice. */
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
  const idx = await readTimelineIndex().catch(() => null);
  const catalog = idx?.slices ?? [];
  if (catalog.length === 0) return { sliceCount: 0, recap: null };

  // Newest first. Catalog entries whose slice file is missing (phantoms) and
  // slices with no turns are skipped, never faked — bounded so a corrupt tail
  // can't turn one card into a full-history scan.
  const newestFirst = [...catalog].sort((a, b) =>
    b.start.localeCompare(a.start),
  );
  for (const entry of newestFirst.slice(0, PHANTOM_SKIP_CAP)) {
    const slice = await loadSlice(entry.id).catch(() => null);
    if (!slice || slice.turns.length === 0) continue;
    return {
      sliceCount: catalog.length,
      recap: {
        lastAt:
          slice.turns[slice.turns.length - 1]?.timestamp ??
          slice.end ??
          slice.start,
        timezone: slice.timezone,
      },
    };
  }
  return { sliceCount: catalog.length, recap: null };
}
