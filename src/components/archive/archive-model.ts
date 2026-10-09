/**
 * The archive field's model (v0.25a §四) — every decision the field makes,
 * as pure functions over the aggregated piles. No React, no DOM: the field
 * component wires these to the scroll rig, and the unit tests live here.
 *
 * THE GRID. Rows = time buckets, columns = the case categories, a cell = one
 * pile (one case). A case's bucket derives from its LAST WRITE (`updated` —
 * the newest of its birth stamp and its pieces' dates): an archive shelf is
 * ordered by when you last touched a dossier, not when it was born.
 *
 * TIME BUCKETS. The trailing seven days bucket by DAY (recent work deserves
 * its own row); anything older buckets by its ISO week (Monday start);
 * anything dateless sits in one undated row at the far end. Buckets order
 * newest first — the top of the field is NOW, scrolling walks into the past.
 *
 * THICKNESS (Q-B, resolved 2026-10): a pile's sheet count is its VOLUME in
 * documents (the index + its pieces), tiered 薄/中/厚 and CAPPED — a long
 * case must not become a column. This table is the one place the tiers live;
 * the visual only renders it.
 *
 * GEOMETRY. The virtual scroll needs numeric heights, so the geometry is
 * computed here and flows to the DOM as CSS variables (the card field's
 * `frameGeometryFor` pattern) — the pile's PRINT scale (type, margins) then
 * derives from the pile's own height in CSS (`--archive-mm`, archive.css),
 * never from the screen (§九).
 */
import type { ArchivePile } from "@/lib/archive/actions";
import { CASE_CATEGORIES, type CaseCategory } from "@/lib/docs";

// ─── Thickness tiers — THE one place ────────────────────────────────────────

export type PileTier = "thin" | "medium" | "thick";

/** Pages per tier's upper bound, and the sheets each tier renders. The cap
 *  is the hard ruling: no pile ever shows more than 10 layers. */
export const PILE_TIERS: readonly {
  tier: PileTier;
  /** Inclusive upper bound of the tier's volume in pages. */
  maxPages: number;
  /** The sheets the pile renders (the cover plus the buried blanks). */
  sheets: number;
}[] = [
  { tier: "thin", maxPages: 3, sheets: 3 },
  { tier: "medium", maxPages: 9, sheets: 6 },
  { tier: "thick", maxPages: Number.POSITIVE_INFINITY, sheets: 10 },
];

export function tierForPages(pages: number): PileTier {
  for (const { tier, maxPages } of PILE_TIERS) {
    if (pages <= maxPages) return tier;
  }
  return "thick";
}

export function sheetsForTier(tier: PileTier): number {
  return PILE_TIERS.find((t) => t.tier === tier)?.sheets ?? 3;
}

// ─── Time buckets ───────────────────────────────────────────────────────────

export type BucketKind = "day" | "week" | "undated";

export interface ArchiveBucket {
  /** Stable identity: `d:2026-10-06` / `w:2026-10-05` (the Monday) / `u:`. */
  key: string;
  kind: BucketKind;
  /** The label's date source: the day itself, or the week's Monday. "" for
   *  the undated row. */
  date: string;
  /** Newest-touched first inside the bucket, then by name. */
  piles: ArchivePile[];
}

/** A write within the trailing week gets its own day; older writes week up. */
export const RECENT_DAYS = 7;

const DAY_MS = 86_400_000;

/** Parse a `YYYY-MM-DD` as a LOCAL midnight (the dates are calendar facts,
 *  not instants — the reader's own day is the honest frame). */
function localDayMs(date: string): number {
  const d = new Date(`${date}T00:00:00`);
  return Number.isNaN(d.getTime()) ? Number.NaN : d.getTime();
}

function isoOf(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** The reader's own today, `YYYY-MM-DD` local — the bucket frame's NOW. */
export function localTodayIso(): string {
  return isoOf(Date.now());
}

/** The Monday of `date`'s week, as a `YYYY-MM-DD`. */
export function weekStartFor(date: string): string {
  const ms = localDayMs(date);
  const dow = (new Date(ms).getDay() + 6) % 7; // Monday = 0
  return isoOf(ms - dow * DAY_MS);
}

export function bucketKeyFor(
  date: string,
  today: string,
): { key: string; kind: BucketKind; date: string } {
  const ms = localDayMs(date);
  if (!date || Number.isNaN(ms)) return { key: "u:", kind: "undated", date: "" };
  const ageDays = Math.floor((localDayMs(today) - ms) / DAY_MS);
  if (ageDays >= 0 && ageDays < RECENT_DAYS) {
    return { key: `d:${date}`, kind: "day", date };
  }
  const monday = weekStartFor(date);
  return { key: `w:${monday}`, kind: "week", date: monday };
}

/**
 * Group the (already filtered) piles into buckets, newest first; the undated
 * row always sorts last — a case with no date has no claim to any when.
 */
export function buildBuckets(
  piles: readonly ArchivePile[],
  today: string,
): ArchiveBucket[] {
  const byKey = new Map<string, ArchiveBucket>();
  for (const pile of piles) {
    const { key, kind, date } = bucketKeyFor(pile.updated, today);
    let bucket = byKey.get(key);
    if (!bucket) {
      bucket = { key, kind, date, piles: [] };
      byKey.set(key, bucket);
    }
    bucket.piles.push(pile);
  }
  const buckets = [...byKey.values()];
  for (const bucket of buckets) {
    bucket.piles.sort(
      (a, b) => b.updated.localeCompare(a.updated) || a.name.localeCompare(b.name),
    );
  }
  return buckets.sort((a, b) => {
    if (a.kind === "undated") return 1;
    if (b.kind === "undated") return -1;
    return b.date.localeCompare(a.date);
  });
}

// ─── Columns ────────────────────────────────────────────────────────────────

/**
 * The field's columns, in the category table's own order, EMPTY CATEGORIES
 * REMOVED (the dispatch's ruling: empty categories do not produce empty
 * piles — a category with nothing in the current data has no column).
 */
export function archiveColumns(piles: readonly ArchivePile[]): CaseCategory[] {
  const present = new Set(piles.map((p) => p.category));
  return CASE_CATEGORIES.filter((c) => present.has(c));
}

/** One bucket's cells in column order — only non-empty cells exist, and a
 *  collision (two cases sharing a bucket × category) keeps BOTH piles: the
 *  cell holds them side by side, shrinking to fit. Hiding one would be a
 *  lie about the archive's contents. `column` is the index into the field's
 *  column list — the row's grid placement reads it. */
export interface ArchiveCell {
  column: number;
  piles: ArchivePile[];
}

export function bucketCells(
  bucket: ArchiveBucket,
  columns: readonly CaseCategory[],
): ArchiveCell[] {
  const rank = new Map(columns.map((c, i) => [c, i]));
  const cells = new Map<number, ArchivePile[]>();
  for (const pile of bucket.piles) {
    const r = rank.get(pile.category);
    if (r === undefined) continue;
    const cell = cells.get(r) ?? [];
    cell.push(pile);
    cells.set(r, cell);
  }
  return [...cells.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([column, piles]) => ({ column, piles }));
}

// ─── Geometry ───────────────────────────────────────────────────────────────

/** The cascade's room below a pile: the deepest buried sheet's peek (the
 *  cap's 9 steps) plus its contact shadow. The pile constants are the lab
 *  recipe's own (the lab is untracked — the numbers are copied, never
 *  imported). */
export const PILE_SHEET_STEP = { x: 5, y: 4, r: 0.35 } as const;
const CASCADE_ROOM = (PILE_TIERS[2].sheets - 1) * PILE_SHEET_STEP.y + 12;

/** The top chrome's room (the board bar floats over the field's top edge):
 *  the bar's seat and height, plus air. Mobile parks it lower (top-13). */
export function archiveInsetTop(fieldW: number): number {
  return fieldW < 640 ? 100 : 72;
}

export interface ArchiveGeometry {
  /** The row-label column's width (desktop; 0 in the single-column layout). */
  labelW: number;
  pileW: number;
  pileH: number;
  /** The column header row's extent (desktop only). */
  headerH: number;
  /** A bucket row's extent (desktop): pad + pile + cascade room + air. */
  rowH: number;
  /** Mobile: a bucket label unit's extent. */
  bucketH: number;
  /** Mobile: one pile unit's extent. */
  pileUnitH: number;
}

/**
 * The field's one geometry, from the pane's measured box. Below `md` the
 * grid lies flat into a single column (the dispatch's mobile ruling: same
 * field, one pile per screen, vertical swipe — not a second layout).
 */
export function archiveGeometry(
  fieldW: number,
  columns: number,
): ArchiveGeometry {
  if (fieldW < 768 || columns <= 1) {
    const pileW = Math.round(Math.min(Math.max(fieldW * 0.72, 200), 300));
    const pileH = Math.round((pileW * 297) / 210);
    return {
      labelW: 0,
      pileW,
      pileH,
      headerH: 0,
      rowH: 0,
      bucketH: 44,
      pileUnitH: pileH + CASCADE_ROOM + 28,
    };
  }
  const labelW = 96;
  const colW = (fieldW - labelW - 48) / Math.max(columns, 1);
  // A collision splits the cell's width; the single-pile width is the cap.
  const pileW = Math.round(Math.min(Math.max(colW * 0.52, 104), 180));
  const pileH = Math.round((pileW * 297) / 210);
  return {
    labelW,
    pileW,
    pileH,
    headerH: 40,
    rowH: 20 + pileH + CASCADE_ROOM + 24,
    bucketH: 0,
    pileUnitH: 0,
  };
}

// ─── Units — what the virtual scroller lays out ─────────────────────────────

export type ArchiveUnit =
  | { kind: "header"; key: string; height: number; columns: CaseCategory[] }
  | {
      kind: "row";
      key: string;
      height: number;
      bucket: ArchiveBucket;
      cells: ArchiveCell[];
    }
  | {
      kind: "bucket";
      key: string;
      height: number;
      bucket: ArchiveBucket;
    }
  | { kind: "pile"; key: string; height: number; pile: ArchivePile };

/**
 * Flatten the buckets into the scroll units. Desktop: a column-header unit,
 * then one row per bucket. Single-column: one label unit per bucket, then
 * one unit per pile — the same field, one pile per screen.
 */
export function buildArchiveUnits(
  buckets: readonly ArchiveBucket[],
  columns: readonly CaseCategory[],
  geo: ArchiveGeometry,
  singleColumn: boolean,
): ArchiveUnit[] {
  const units: ArchiveUnit[] = [];
  if (!singleColumn) {
    units.push({
      kind: "header",
      key: "header",
      height: geo.headerH,
      columns: [...columns],
    });
  }
  for (const bucket of buckets) {
    if (singleColumn) {
      units.push({
        kind: "bucket",
        key: `b:${bucket.key}`,
        height: geo.bucketH,
        bucket,
      });
      for (const pile of bucket.piles) {
        units.push({
          kind: "pile",
          key: `p:${bucket.key}:${pile.ref}`,
          height: geo.pileUnitH,
          pile,
        });
      }
    } else {
      units.push({
        kind: "row",
        key: `r:${bucket.key}`,
        height: geo.rowH,
        bucket,
        cells: bucketCells(bucket, columns),
      });
    }
  }
  return units;
}
