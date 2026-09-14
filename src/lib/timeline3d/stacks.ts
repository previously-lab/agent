/**
 * Stack rows for the Rev 8 timeline (doc/design/v0.10.0 §R8) — pure
 * functions, no React/R3F.
 *
 * The right field is a vertical DOM list whose ROW GRANULARITY is the zoom
 * level: L0 one slice per row, L1 one day-stack per row, L2 one week-stack
 * per row. A stack is a visual fiction — the top card is real, the depth is
 * 0-3 hash-posed shells plus a count badge, so a 700-slice week costs the
 * same as a 2-slice day.
 *
 * Row order follows the catalog: oldest at the top, newest at the bottom
 * (same reading direction as the chat stream; the list bottom-anchors).
 */
import type { TimelineSliceEntry } from "@/lib/episodic/timeline/types";
import { hashString } from "./layout";
import { normalizeStrandName } from "./ink";

/** Zoom levels: 0 = slice rows · 1 = day stacks · 2 = week stacks. */
export type StackLevel = 0 | 1 | 2;

/** Landing level (§R8): day stacks — overview with a readable top card. */
export const DEFAULT_LEVEL: StackLevel = 1;

export interface StackRow {
  /** Stable key: the slice id (L0), "d:YYYY-MM-DD" (L1), "w:YYYY-Www" (L2). */
  key: string;
  level: StackLevel;
  /** Newest entry of the group — its content heads the stack. */
  top: TimelineSliceEntry;
  /** Slices in the group (always 1 at L0). */
  count: number;
  /** Group members, oldest → newest. */
  entries: TimelineSliceEntry[];
  /** Union of member strands, first-seen order (stack accent dots). */
  strands: string[];
}

/** The row key a given entry falls into at a level. */
export function rowKeyFor(entry: TimelineSliceEntry, level: StackLevel): string {
  if (level === 0) return entry.id;
  if (level === 1) return `d:${entry.date}`;
  return `w:${isoWeekKey(entry.date)}`;
}

// ─── ISO week grouping (L2) ─────────────────────────────────────────────────

const DAY_MS = 86_400_000;

export interface IsoWeek {
  /** ISO week-numbering year (differs from the calendar year near Jan 1). */
  year: number;
  /** ISO week number, 1–53. */
  week: number;
  /** Monday of the week (UTC), "YYYY-MM-DD". */
  monday: string;
  /** Sunday of the week (UTC), "YYYY-MM-DD". */
  sunday: string;
}

/**
 * The ISO-8601 week (Monday start) a "YYYY-MM-DD" date falls into. Boundary
 * rule: a Sunday belongs to the week that started the PREVIOUS Monday (so
 * 2024-08-18 → the 8/12–8/18 week), and dates around Jan 1 roll into the
 * neighbouring ISO year (2024-12-30 → 2025-W01). Parsed at noon UTC so the
 * date string never shifts under a negative timezone offset.
 */
export function isoWeekFor(date: string): IsoWeek {
  const d = new Date(`${date}T12:00:00.000Z`);
  if (Number.isNaN(d.getTime())) {
    return { year: 0, week: 0, monday: date, sunday: date };
  }
  const isoDay = d.getUTCDay() || 7; // 1 Mon .. 7 Sun
  const mondayMs = d.getTime() - (isoDay - 1) * DAY_MS;
  const thursdayMs = mondayMs + 3 * DAY_MS; // a week's Thursday fixes its ISO year/week
  const year = new Date(thursdayMs).getUTCFullYear();
  const jan1Ms = Date.UTC(year, 0, 1);
  const week = Math.ceil(((thursdayMs - jan1Ms) / DAY_MS + 1) / 7);
  const fmt = (ms: number) => {
    const x = new Date(ms);
    return `${x.getUTCFullYear()}-${String(x.getUTCMonth() + 1).padStart(2, "0")}-${String(x.getUTCDate()).padStart(2, "0")}`;
  };
  return { year, week, monday: fmt(mondayMs), sunday: fmt(mondayMs + 6 * DAY_MS) };
}

/** "2026-W33" — the L2 row-key suffix. */
export function isoWeekKey(date: string): string {
  const { year, week } = isoWeekFor(date);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

/**
 * "2026 W33 · 8/12–8/18" (en) / "2026 第33周 · 8/12–8/18" (zh) — the L2
 * stack's corner label, the week analog of the day label "08/17 Sun".
 */
export function weekLabelFor(date: string, locale: string): string {
  const { year, week, monday, sunday } = isoWeekFor(date);
  const md = (s: string) => `${parseInt(s.slice(5, 7), 10)}/${parseInt(s.slice(8, 10), 10)}`;
  const range = `${md(monday)}–${md(sunday)}`;
  return locale.toLowerCase().startsWith("zh")
    ? `${year} 第${week}周 · ${range}`
    : `${year} W${String(week).padStart(2, "0")} · ${range}`;
}

/**
 * Partition the catalog window into rows for a level. Entries are sorted by
 * start defensively; groups inherit first-seen order so rows stay strictly
 * chronological.
 */
export function groupForLevel(
  entries: TimelineSliceEntry[],
  level: StackLevel,
): StackRow[] {
  const sorted = [...entries].sort((a, b) => a.start.localeCompare(b.start));
  const byKey = new Map<string, TimelineSliceEntry[]>();
  for (const e of sorted) {
    const key = rowKeyFor(e, level);
    const list = byKey.get(key);
    if (list) list.push(e);
    else byKey.set(key, [e]);
  }
  const rows: StackRow[] = [];
  for (const [key, members] of byKey) {
    const strands: string[] = [];
    for (const e of members) {
      for (const s of e.strands) if (!strands.includes(s)) strands.push(s);
    }
    rows.push({
      key,
      level,
      top: members[members.length - 1],
      count: members.length,
      entries: members,
      strands,
    });
  }
  return rows;
}

// ─── Card geometry (Rev 9: the card is a fixed-size playing card) ───────────

/**
 * The card face is a FIXED-SIZE playing card (§R9.1): same face at every
 * zoom level, in a few responsive width tiers (JS-side, because the 3D pile
 * field needs the same numbers — CSS-only breakpoints can't feed WebGL).
 * Rows are fixed-pitch too, so every row's screen rect is a pure function of
 * (rowIndex, scrollTop) — the pile canvas never measures the DOM.
 */
export interface CardGeometry {
  /** Card face px. */
  cardW: number;
  cardH: number;
  /** Gap below an L0 slice row's card. */
  gapSlice: number;
  /** Room below a stack row's card reserved for the 3D pile peek. */
  gapStack: number;
}

/** Card aspect — a landscape playing card (~1.76:1). */
export const CARD_RATIO = 1.76;

export function cardGeometryFor(viewportW: number): CardGeometry {
  const cardW =
    viewportW < 480
      ? Math.round(Math.min(Math.max(viewportW - 88, 260), 330))
      : viewportW < 1024
        ? 340
        : 380;
  return {
    cardW,
    cardH: Math.round(cardW / CARD_RATIO),
    gapSlice: 16,
    gapStack: 44,
  };
}

/** Row pitch (px) for a level under a geometry — the DOM row height AND the
 *  3D card-field row spacing; both sides must read this one source. */
export function rowPitchFor(level: StackLevel, geo: CardGeometry): number {
  return geo.cardH + (level === 0 ? geo.gapSlice : geo.gapStack);
}

// ─── Frame geometry (Rev 10: the card is a big film frame) ──────────────────

/**
 * The R3F card field's geometry: one card is a big PORTRAIT frame — roughly
 * 70% of the field height, wide but never edge-to-edge, so a screen holds
 * ~1.3 cards. Pure function of the field's pixel size; the scene never
 * measures the DOM.
 */
export interface FrameGeometry {
  /** Card face px. */
  cardW: number;
  cardH: number;
  /** Vertical pitch between row anchors (px). */
  pitch: number;
  /**
   * Which composition the card wears — carried on the geometry because the
   * card and everything measuring it must agree, and the SAME dimensions can
   * describe either face: the variant is what `frame-card.tsx` reads to pick
   * its type scale and its ledger length.
   *
   * The two are not interchangeable at one size. A single `em` divisor cannot
   * serve both — the dossier's short edge is its height and the portrait's is
   * its width — which is why `cardEmFor` reads this to pick one. The portrait
   * is a SHORTER DOCUMENT, not a smaller one.
   */
  variant: CardVariant;
}

/**
 * How a slice card composes itself. Not a size — a different DOCUMENT. The
 * dossier is the desktop face (ledger rows, quote, footer); the portrait drops
 * the rows a narrow card cannot read at a legible size and spends that room on
 * type.
 *
 * It lives here, beside the geometry, because it is decided from the PANE. It
 * was a field on `TierSpec` — a statement about the window — for a card that
 * lives in the pane; see `frameVariantFor`.
 */
export type CardVariant = "portrait" | "dossier";

/** Pane aspect at which the card turns portrait. 1.15 rather than 1 so a pane
 *  that is merely a little taller than wide stays with the dossier, whose
 *  ledger rows it has the width to read. */
export const FRAME_PORTRAIT_ABOVE = 1.15;

/**
 * WHICH COMPOSITION A CARD WEARS, decided from the PANE it sits in.
 *
 * This used to be read off the tier (`cardVariantFor(windowW)`), which is a
 * statement about the WINDOW — and the card does not live in the window, it
 * lives in the pane. The two agree almost everywhere, because the pane is the
 * window minus a rail; they part company on a TALL window, which is exactly the
 * family that was wrong (640x1130, and any window past 1024 that is taller than
 * it is wide). The pane rule restores the dossier's ledger rows to the first
 * and keeps them off the second.
 */
export function frameVariantFor(fieldW: number, fieldH: number): CardVariant {
  return fieldH > fieldW * FRAME_PORTRAIT_ABOVE ? "portrait" : "dossier";
}

/**
 * The card's root `em`, in px — ONE place, because the DOM face and the 3D
 * backing sheet have to agree on it (see `sheetRadiusPx`, which matches the
 * face's `rounded-[0.9em]`).
 *
 * IT IS BOUNDED, and that is the whole of what this function adds. The formula
 * was `min(cardW, cardH) / (portrait ? 17 : 26)` and nothing else, which is a
 * pure scale: type grew one-for-one with the card at every size, forever.
 * Measured across four viewports it ran 18.7 → 33.4 → 19.5 → 23.1 px, so a
 * 640px window — 1.6x wider than a phone — drew its body rows at 24.7px and its
 * turn bubbles at 24.1px, which is why they no longer fitted the frame that
 * clamps them.
 *
 * A card that gets bigger should get MORE ROOM, not bigger type, past the point
 * where the type is comfortably read. The divisors still say which document
 * this is (the portrait is a shorter one and spends its room on type); the
 * bounds say type has a size the reader actually reads at.
 */
export const CARD_EM_MIN_PX = 13;
export const CARD_EM_MAX_PX = 20;

export function cardEmFor(geo: FrameGeometry): number {
  const raw =
    Math.min(geo.cardW, geo.cardH) / (geo.variant === "portrait" ? 17 : 26);
  return Math.max(CARD_EM_MIN_PX, Math.min(raw, CARD_EM_MAX_PX));
}

/** Portrait aspect (W/H) of the frame card for narrow fields. */
export const FRAME_RATIO = 0.8;

/** Landscape aspect (W/H) of the frame card for wide desktop fields. */
export const FRAME_LANDSCAPE_RATIO = 1.5;

export function frameGeometryFor(
  variant: CardVariant,
  fieldW: number,
  fieldH: number,
): FrameGeometry {
  // The dossier: a landscape board, ~78% of the field width, capped at 900px,
  // with its height capped to ~82% of the field height.
  if (variant === "dossier") {
    let cardW = Math.round(Math.min(fieldW * 0.78, 900));
    let cardH = Math.round(Math.min(cardW / FRAME_LANDSCAPE_RATIO, fieldH * 0.82));
    if (cardH < 300) {
      cardH = 300;
      cardW = Math.round(cardH * FRAME_LANDSCAPE_RATIO);
    }
    return { cardW, cardH, pitch: Math.round(cardH * 1.12), variant };
  }

  // The portrait: taller than wide, never wider than the pane it sits in.
  const cardH = Math.round(Math.min(Math.max(fieldH * 0.7, 300), 720));
  const cardW = Math.round(
    Math.min(cardH * FRAME_RATIO, Math.max(fieldW - 40, 240), 600),
  );
  return { cardW, cardH, pitch: Math.round(cardH * 1.12), variant };
}

/** Row pitch per level: L0 rows leave an 8%-of-card gap; stack levels add
 *  a wider gap so the backing-sheet pile has room to peek out. Card height
 *  is fixed (geo.cardH), so these multipliers are the real visual gaps. */
export function framePitchFor(level: StackLevel, geo: FrameGeometry): number {
  return Math.round(geo.cardH * (level === 0 ? 1.08 : 1.16));
}

/**
 * Backing sheets under a stack's top card (Rev 10, user-specified tiers):
 * small piles show their REAL count (2–3 cards), mid piles always read as
 * five, big piles read as seven with the deepest sheets faded — the exact
 * count is never judged per render, only bucketed.
 */
export function backingSheets(count: number): number {
  if (count <= 1) return 0;
  if (count <= 3) return count - 1;
  if (count <= 8) return 4;
  return 6;
}

/** Scale the hash-stable shell/sheet poses (authored against the old 216px
 *  card) up to the frame card's size. */
export function poseScaleFor(geo: FrameGeometry): number {
  return geo.cardH / 216;
}

export interface SheetPose {
  /** Degrees — cumulative fan tilt, opposite sign of offsetX (a card that
   *  slipped down-right rotates with its right side lower). */
  rotate: number;
  /** px — cumulative lateral cascade, stable sign per pile. */
  offsetX: number;
  /** px — cumulative downward cascade (always positive). */
  offsetY: number;
}

/**
 * Hash-stable pose for 3D backing sheet `i` behind a stack's top card. A real
 * deck placed by hand CASCADES — each sheet slips a little further in one
 * stable direction — so the pose is cumulative in `i` (sheet 0 peeks least)
 * with a per-pile direction/step drawn from the group hash, plus small
 * per-sheet jitter. Fits inside `gapStack` (max |offsetY| ≈ 14px < 44px).
 */
export function sheetPose(groupKey: string, i: number): SheetPose {
  const pile = hashString(`s3d:${groupKey}`);
  const sign = pile & 1 ? 1 : -1;
  const step = 4.5 + (((pile >>> 5) % 1000) / 1000) * 3; // 4.5–7.5px per sheet
  const fan = 0.7 + (((pile >>> 15) % 1000) / 1000) * 0.9; // 0.7–1.6° per sheet
  const j = ((hashString(`s3d:${groupKey}#${i}`) >>> 5) % 1000) / 1000 - 0.5;
  const n = i + 1;
  return {
    rotate: -sign * fan * n + j * 0.6,
    offsetX: sign * step * n * 0.7 + j * 3,
    offsetY: step * n * 0.55 + Math.abs(j) * 2.5,
  };
}

// ─── Re-anchor across level / filter / paging changes ───────────────────────

/**
 * Find the row containing an anchor entry (the first visible row's top card
 * before the change). Exact containment first; when the entry left the window
 * (a strand filter can remove it), fall back to the nearest row by start time
 * so the list still lands somewhere sensible.
 */
export function indexForAnchor(rows: StackRow[], anchorId: string): number {
  const exact = rows.findIndex(
    (r) => r.top.id === anchorId || r.entries.some((e) => e.id === anchorId),
  );
  if (exact >= 0) return exact;
  if (rows.length === 0) return -1;
  // The anchor id starts with its date — lexical compare works on the id.
  let best = 0;
  let bestDist = Infinity;
  const anchorMs = anchorStartMs(anchorId);
  rows.forEach((r, i) => {
    const d = Math.abs(new Date(r.top.start).getTime() - anchorMs);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  });
  return best;
}

/** Anchor ids are slice ids ("YYYY-MM-DD-HHMM") — parse, else epoch. */
function anchorStartMs(anchorId: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})$/.exec(anchorId);
  if (!m) return 0;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
}

/**
 * Filter the catalog to the carriers of any selected strand — an empty list is
 * 核心时间线, no filter.
 *
 * UNION, not intersection: picking "running" and "work" asks for the slices
 * about either thread, which is the standard reading of a multi-select facet.
 * The band agrees — both threads light up — so requiring BOTH would leave the
 * reader looking at fewer cards than lines.
 */
export function filterByStrand(
  entries: TimelineSliceEntry[],
  strands: readonly string[],
): TimelineSliceEntry[] {
  if (strands.length === 0) return entries;
  // BOTH SIDES GO THROUGH `normalizeStrandName`, and that is not tidiness.
  // `strands.json` keeps the FIRST spelling it ever saw for a strand — so the
  // board bar offers "Fitness" — while a slice's own `tags` keep whatever the
  // agent wrote that turn, which may be "fitness". Comparing raw strings makes
  // the band and the field disagree about the same pick: the band (which does
  // normalise, see `ink.ts`) lights the thread for both spellings, and this
  // filter drops the slices carrying the other one. The strip then says "these
  // slices are in that strand" while the pane says "not here".
  const wanted = new Set(strands.map(normalizeStrandName));
  return entries.filter((e) =>
    e.strands.some((s) => wanted.has(normalizeStrandName(s))),
  );
}

// ─── Shared animation easing ────────────────────────────────────────────────

/**
 * smoothstep — deal progress → eased settle factor (0 = airborne, 1 = settled).
 * Kept here because both the R3F card field and the DOM fallback use it.
 */
export function settleEase(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
}
