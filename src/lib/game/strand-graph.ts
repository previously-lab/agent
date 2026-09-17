/**
 * Strand graph — the data foundation for strand doors (v0.11-hotel-rooms 附录 B).
 *
 * A strand (线索) is a long-running theme in the user's life; `strands.json`
 * maps each strand name to the slices where it was active. In the hotel,
 * every room (slice) grows one door per strand passing through it, leading to
 * the NEXT slice on that strand — or standing unlit when the thread has no
 * further active position yet (B.4: an unlit door, not a missing one).
 *
 * This module is the pure computation layer over that index: position
 * normalisation, a chronologically sorted + de-duplicated graph with a
 * reverse index, O(1) neighbour lookup, and the per-slice door set. No I/O,
 * no React, no randomness, no wall clock — the same input always yields the
 * same doors, which is what keeps "the same memory always looks the same"
 * (axiom A6) true between visits.
 *
 * Deterministic door ordering rule: by strand activity (total positions on
 * the strand) DESCENDING, ties broken by strand name in code-unit order.
 * Activity-first matches the product rule that the most-confirmed strands are
 * the most trustworthy (B.7 硬前提; strand-field §2.4 already sorts top-N by
 * activity with a name tiebreak for the same flicker-prevention reason), and
 * the name tiebreak keeps the order total — a door order that flickered
 * between visits would break A6's promise. Code-unit comparison (<), not
 * localeCompare, so the order cannot drift across environments/ICU builds.
 */

// ─── Position / slice-id normalisation ─────────────────────────────────────

/**
 * A strand position as stored in `strands.json`: `"2026/06/22/1400"`
 * (slash-separated `YYYY/MM/DD/HHMM`, UTC).
 */
const POSITION_RE = /^(\d{4})\/(\d{2})\/(\d{2})\/(\d{4})$/;

/** A slice id: `"2026-06-22-1400"` (dash-separated `YYYY-MM-DD-HHMM`). */
const SLICE_ID_RE = /^(\d{4})-(\d{2})-(\d{2})-(\d{4})$/;

/** Calendar-validate the captured fields (rejects month 13, Feb 30, 25:00). */
function validDateTime(y: string, mo: string, d: string, hhmm: string): boolean {
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const hour = Number(hhmm.slice(0, 2));
  const min = Number(hhmm.slice(2, 4));
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || min > 59) {
    return false;
  }
  const ms = Date.UTC(year, month - 1, day, hour, min);
  const dt = new Date(ms);
  return (
    dt.getUTCFullYear() === year &&
    dt.getUTCMonth() === month - 1 &&
    dt.getUTCDate() === day
  );
}

/**
 * Normalise a strand position (`"2026/06/22/1400"`) into a slice id
 * (`"2026-06-22-1400"`). Returns null for anything malformed — bad shape,
 * out-of-range fields, or a non-existent calendar date.
 */
export function parseStrandPosition(position: string): string | null {
  const m = POSITION_RE.exec(position);
  if (!m) return null;
  const [, y, mo, d, hhmm] = m;
  if (!validDateTime(y, mo, d, hhmm)) return null;
  return `${y}-${mo}-${d}-${hhmm}`;
}

/**
 * The reverse of {@link parseStrandPosition}: slice id → strand position.
 * Returns null for malformed ids.
 */
export function sliceIdToPosition(sliceId: string): string | null {
  const m = SLICE_ID_RE.exec(sliceId);
  if (!m) return null;
  const [, y, mo, d, hhmm] = m;
  if (!validDateTime(y, mo, d, hhmm)) return null;
  return `${y}/${mo}/${d}/${hhmm}`;
}

/**
 * Parse a slice id into a UTC millisecond timestamp. Returns null for
 * malformed ids. All strand/slice timestamps are UTC, so day gaps computed
 * from this never cross DST.
 */
export function sliceIdToMs(sliceId: string): number | null {
  const m = SLICE_ID_RE.exec(sliceId);
  if (!m) return null;
  const [, y, mo, d, hhmm] = m;
  if (!validDateTime(y, mo, d, hhmm)) return null;
  return Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(hhmm.slice(0, 2)), Number(hhmm.slice(2, 4)));
}

// ─── Gap ────────────────────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Whole days from slice `from` to slice `to` — the "this thread was quiet for
 * four months" number. Truncated toward zero (two positions 25 hours apart
 * are 1 day, 23 hours are 0); negative when `to` is earlier than `from`.
 * Returns null when either id is malformed.
 */
export function gapDaysBetween(from: string, to: string): number | null {
  const a = sliceIdToMs(from);
  const b = sliceIdToMs(to);
  if (a === null || b === null) return null;
  const days = Math.trunc((b - a) / DAY_MS);
  return days === 0 ? 0 : days; // no -0
}

// ─── Graph ──────────────────────────────────────────────────────────────────

/** Raw strand entries, as read from `strands.json`: name → positions. */
export type RawStrandEntries = Readonly<Record<string, readonly string[]>>;

export interface StrandGraph {
  /**
   * Strand name → its path: chronologically sorted, de-duplicated slice ids.
   * Malformed positions are dropped at build time. Strands whose positions
   * were ALL malformed are absent from the graph entirely.
   */
  readonly paths: ReadonlyMap<string, readonly string[]>;
  /**
   * Reverse index: slice id → the strands passing through it, in the SAME
   * deterministic door order as {@link strandDoorsForSlice} (activity desc,
   * then name asc).
   */
  readonly bySlice: ReadonlyMap<string, readonly string[]>;
  /**
   * Per-strand slice id → index in its path, making neighbour lookup O(1)
   * instead of a linear scan per query.
   */
  readonly positionIndex: ReadonlyMap<string, ReadonlyMap<string, number>>;
}

/** Total order used everywhere a strand sequence is user-visible. */
function compareStrands(graphPaths: ReadonlyMap<string, readonly string[]>, a: string, b: string): number {
  const lenA = graphPaths.get(a)?.length ?? 0;
  const lenB = graphPaths.get(b)?.length ?? 0;
  if (lenA !== lenB) return lenB - lenA; // activity desc
  return a < b ? -1 : a > b ? 1 : 0; // name asc, code-unit order
}

/**
 * Build the strand graph from raw `strands.json` entries.
 *
 * Per strand: positions are normalised to slice ids (malformed ones dropped),
 * de-duplicated, and sorted chronologically — zero-padded `YYYY-MM-DD-HHMM`
 * sorts chronologically as plain strings. The reverse index and the per-
 * strand position lookup tables are built in the same pass; the whole dataset
 * is KB-scale, so the game builds this once and queries it per room.
 */
export function buildStrandGraph(entries: RawStrandEntries): StrandGraph {
  const paths = new Map<string, readonly string[]>();
  for (const [name, positions] of Object.entries(entries)) {
    const seen = new Set<string>();
    for (const p of positions) {
      const id = parseStrandPosition(p);
      if (id !== null) seen.add(id);
    }
    if (seen.size === 0) continue;
    paths.set(name, [...seen].sort());
  }

  const positionIndex = new Map<string, ReadonlyMap<string, number>>();
  const bySlice = new Map<string, string[]>();
  for (const [name, path] of paths) {
    const index = new Map<string, number>();
    path.forEach((id, i) => {
      index.set(id, i);
      const carriers = bySlice.get(id);
      if (carriers) carriers.push(name);
      else bySlice.set(id, [name]);
    });
    positionIndex.set(name, index);
  }

  const sortedBySlice = new Map<string, readonly string[]>();
  for (const [id, carriers] of bySlice) {
    sortedBySlice.set(id, carriers.sort((a, b) => compareStrands(paths, a, b)));
  }

  return { paths, bySlice: sortedBySlice, positionIndex };
}

// ─── Neighbour lookup ───────────────────────────────────────────────────────

/**
 * The next slice on a strand after `sliceId` — the strand door's destination.
 * Returns null when the strand or slice is unknown, or when the thread has no
 * further active position: that is an UNLIT door (B.4), not a missing one.
 */
export function nextOnStrand(
  graph: StrandGraph,
  strand: string,
  sliceId: string,
): string | null {
  const path = graph.paths.get(strand);
  const i = graph.positionIndex.get(strand)?.get(sliceId);
  if (!path || i === undefined) return null;
  return path[i + 1] ?? null;
}

/**
 * The previous slice on a strand before `sliceId`, or null when unknown /
 * at the strand's first active position. Direction of travel is forward-only
 * (B.4: 回退走走廊) — this exists for narrator context, not navigation.
 */
export function previousOnStrand(
  graph: StrandGraph,
  strand: string,
  sliceId: string,
): string | null {
  const path = graph.paths.get(strand);
  const i = graph.positionIndex.get(strand)?.get(sliceId);
  if (!path || i === undefined) return null;
  return i > 0 ? path[i - 1] : null;
}

// ─── Doors ──────────────────────────────────────────────────────────────────

/** One strand door in a room. */
export interface StrandDoor {
  /** The strand this door follows. */
  readonly strand: string;
  /** Destination: the next slice on the strand, or null = unlit door. */
  readonly next: string | null;
  /**
   * Whole days from this slice to `next` — the "quiet for four months" gap.
   * Null when the door is unlit.
   */
  readonly gapDays: number | null;
}

/**
 * The strand door set for one room: one entry per strand passing through
 * `sliceId`, unlit doors included. Empty when no strand passes through the
 * slice. Order is the module's deterministic rule (activity desc, name asc) —
 * see the file header for why.
 */
export function strandDoorsForSlice(
  graph: StrandGraph,
  sliceId: string,
): StrandDoor[] {
  const strands = graph.bySlice.get(sliceId);
  if (!strands) return [];
  return strands.map((strand) => {
    const next = nextOnStrand(graph, strand, sliceId);
    return {
      strand,
      next,
      gapDays: next === null ? null : gapDaysBetween(sliceId, next),
    };
  });
}
