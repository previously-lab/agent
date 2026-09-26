/**
 * Home recap (v0.13 §3) — the smallest honest memory summary the start screen
 * needs: how many slices exist, and where the last conversation left off.
 *
 * This is NOT a new reading path. It composes the two reads every other
 * surface already uses — the derived catalog (`readTimelineIndex`, one backend
 * round trip) and a single slice body (`loadSlice`) — and returns only what
 * the home renders. No cache, no store: the catalog is already the cheap
 * derived index, and the demo backend caches at the fs layer. The quotes
 * come back as styled runs (subtitle-line's parser), so the home paints
 * emphasis instead of leaking markdown markers.
 *
 * One judgement call: the recap follows the NEWEST slice that actually holds
 * conversation, whatever its status — a still-active newest slice IS where
 * the last conversation left off, and pointing at an older closed slice
 * would describe a conversation the reader has already moved past.
 */
import { readTimelineIndex } from "@/lib/episodic/timeline/store";
import { loadSlice } from "@/lib/episodic/manager";
import type { Turn } from "@/lib/episodic/types";
import {
  collapseSubtitleWhitespace,
  parseSubtitleRuns,
  truncateSubtitleText,
  type SubtitleRun,
} from "@/lib/chat/subtitle-line";

/** The opening words of one side of the last exchange — verbatim but cut,
 *  returned as styled runs so the home can paint emphasis. */
const QUOTE_CHARS = 80;

/** How far down the catalog tail to look for a readable, non-empty slice. */
const PHANTOM_SKIP_CAP = 3;

export interface HomeRecap {
  sliceId: string;
  status: "active" | "closed";
  /** Where the conversation left off — its last turn's instant, UTC ISO. */
  lastAt: string;
  /** IANA timezone the slice recorded — the recap's clock is the reader's. */
  timezone: string;
  focus: string;
  /** The reader's last line as styled runs (markers already resolved — a `**`
   *  pair can never leak). Null when the slice has none. */
  lastUser: SubtitleRun[] | null;
  /** Previously's last line, same shape. Null when the slice has none. */
  lastAgent: SubtitleRun[] | null;
}

export interface HomeMemoryState {
  sliceCount: number;
  recap: HomeRecap | null;
}

function lastOf(turns: Turn[], role: Turn["role"]): Turn | undefined {
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].role === role) return turns[i];
  }
  return undefined;
}

/**
 * One side of the last exchange as styled runs: whitespace collapsed, the
 * spoken-line markdown subset resolved (strong / em / code paint, markers
 * gone), cut at a word boundary near QUOTE_CHARS. Parsing happens BEFORE
 * the cut — the same rule the subtitle strip lives by — so the cut can
 * never split a `**` pair and leak a marker into the serif type.
 */
function quote(turn: Turn | undefined): SubtitleRun[] | null {
  if (!turn) return null;
  const collapsed = collapseSubtitleWhitespace(turn.content);
  if (!collapsed) return null;
  const allRuns = parseSubtitleRuns(collapsed);
  const plain = allRuns.map((run) => run.text).join("");
  const { text, truncated } = truncateSubtitleText(plain, QUOTE_CHARS);
  const runs: SubtitleRun[] = [];
  let used = 0;
  for (const run of allRuns) {
    if (used >= text.length) break;
    if (used + run.text.length <= text.length) {
      runs.push(run);
      used += run.text.length;
      continue;
    }
    // A run straddling the cut is SPLIT — its head keeps its emphasis.
    runs.push({
      text: run.text.slice(0, text.length - used),
      emphasis: run.emphasis,
    });
    used = text.length;
  }
  if (truncated) runs.push({ text: "…", emphasis: null });
  return runs;
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
        sliceId: slice.slice_id,
        status: slice.status,
        lastAt:
          slice.turns[slice.turns.length - 1]?.timestamp ??
          slice.end ??
          slice.start,
        timezone: slice.timezone,
        focus: entry.focus,
        lastUser: quote(lastOf(slice.turns, "user")),
        lastAgent: quote(lastOf(slice.turns, "agent")),
      },
    };
  }
  return { sliceCount: catalog.length, recap: null };
}
