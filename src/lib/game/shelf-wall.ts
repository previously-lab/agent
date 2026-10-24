/**
 * Shelf wall geometry (v0.12 declarations audit, 2026-10 realism lane) —
 * the pure builder behind the room's bookcase wall: bay stiles, plinth,
 * top and shelf boards, the back panel, and the per-bay book rows, all
 * CUT AROUND the wall's real openings.
 *
 * WHY THIS MODULE EXISTS. The renderer's ShelfWallRun used to skip a
 * bay's BOOKS when a window landed near it while leaving the bay's
 * STILES and BOARDS running straight through the window frame — a
 * bookcase built through a hole. The cuts are a geometry problem, so
 * they live here, pure: every emitted rectangle is guaranteed disjoint
 * from every opening rectangle it truly intersects, books are split per
 * bay AND per row at their real y-ranges, and segments too narrow to
 * hold a book are omitted entirely.
 *
 * COORDINATES. The run's local frame: `along` is the run direction
 * measured from the run's center (meters, already wall-scaled by the
 * caller), y from the floor. The caller filters openings to the SAME
 * wall before calling; an opening that does not vertically or
 * horizontally intersect a piece simply does not cut it (a clerestory
 * band above the case height leaves the case untouched; a window sill
 * above a low book row leaves the row standing).
 *
 * Pure module: no three.js, no React, no wall clock, no seeding.
 */

import {
  SHELF_WALL_BAY,
  SHELF_WALL_BAY_MAX,
  SHELF_WALL_BOARD,
  SHELF_WALL_DEPTH,
  SHELF_WALL_HEIGHT,
  SHELF_WALL_MIN_H,
  SHELF_WALL_PLINTH,
  SHELF_WALL_SHELF_GAP,
  SHELF_WALL_STILE,
} from "./tuning/room";

/* ------------------------------------------------------------------ */
/* Intervals and rectangles                                            */
/* ------------------------------------------------------------------ */

/** Subtract [cutLo, cutHi] from every interval in `base` (bounded
 *  interval subtraction: what survives, in order, coalescing nothing —
 *  results may touch but never overlap the cut). An interval is kept
 *  only while it keeps a positive length beyond EPS. */
export function subtractIntervals(
  base: readonly (readonly [number, number])[],
  cutLo: number,
  cutHi: number,
): [number, number][] {
  const out: [number, number][] = [];
  for (const [lo, hi] of base) {
    if (cutHi <= lo + EPS || cutLo >= hi - EPS) {
      out.push([lo, hi]);
      continue;
    }
    if (cutLo > lo + EPS) out.push([lo, Math.min(cutLo, hi)]);
    if (cutHi < hi - EPS) out.push([Math.max(cutHi, lo), hi]);
  }
  return out.filter(([lo, hi]) => hi - lo > EPS);
}

/** One axis-aligned rectangle in (along, y) run space. */
export interface RunRect {
  along0: number;
  along1: number;
  y0: number;
  y1: number;
}

/** True when the two rectangles genuinely overlap (not merely touch). */
export function rectsIntersect(a: RunRect, b: RunRect): boolean {
  return (
    a.along0 < b.along1 - EPS &&
    a.along1 > b.along0 + EPS &&
    a.y0 < b.y1 - EPS &&
    a.y1 > b.y0 + EPS
  );
}

/**
 * Subtract one cut rectangle from a set of rectangles: each surviving
 * piece is one of left / right / below / above the cut. Applied
 * sequentially over many cuts, the result is a partition of the
 * original area with every cut's interior removed — no surviving
 * rectangle crosses a cut's edge, so a shelf board can never run
 * through a window frame.
 */
export function subtractRunRects(
  base: readonly RunRect[],
  cuts: readonly RunRect[],
): RunRect[] {
  let current = base.map((r) => ({ ...r }));
  for (const cut of cuts) {
    const next: RunRect[] = [];
    for (const r of current) {
      if (!rectsIntersect(r, cut)) {
        next.push(r);
        continue;
      }
      const aLo = r.along0;
      const aHi = r.along1;
      const yLo = r.y0;
      const yHi = r.y1;
      // Left / right of the cut, full height.
      if (cut.along0 > aLo + EPS) {
        next.push({ along0: aLo, along1: cut.along0, y0: yLo, y1: yHi });
      }
      if (cut.along1 < aHi - EPS) {
        next.push({ along0: cut.along1, along1: aHi, y0: yLo, y1: yHi });
      }
      // Below / above the cut, spanning only the cut's along-range.
      const midLo = Math.max(aLo, cut.along0);
      const midHi = Math.min(aHi, cut.along1);
      if (cut.y0 > yLo + EPS) {
        next.push({ along0: midLo, along1: midHi, y0: yLo, y1: cut.y0 });
      }
      if (cut.y1 < yHi - EPS) {
        next.push({ along0: midLo, along1: midHi, y0: cut.y1, y1: yHi });
      }
    }
    current = next;
  }
  return current;
}

const EPS = 1e-4;

/* ------------------------------------------------------------------ */
/* Openings                                                            */
/* ------------------------------------------------------------------ */

/** A real opening in THIS wall run (the caller filters other walls
 *  out): a window, a glass wall span, or a clerestory band. `along` is
 *  the opening's center in run coordinates; `width` is its FULL width
 *  INCLUDING frame; bottom/top are heights above the floor. */
export interface WallOpening {
  along: number;
  width: number;
  bottom: number;
  top: number;
}

function openingRect(o: WallOpening): RunRect {
  return {
    along0: o.along - o.width / 2,
    along1: o.along + o.width / 2,
    y0: o.bottom,
    y1: o.top,
  };
}

/* ------------------------------------------------------------------ */
/* The builder                                                         */
/* ------------------------------------------------------------------ */

/** The room's one window, as the shelf wall must cut around it —
 *  along-run range INCLUDING frame margin, and its sill/head heights
 *  (already wall-scaled by the caller). Same shape for a glass span or
 *  clerestory band. */
export interface ShelfWallInput {
  /** The run's length along the wall (m, scaled). */
  len: number;
  /** The host wall's DRAWN height — the case caps below it. */
  height: number;
  /** The wall scale ratio (dado/shelf constants are × this). */
  wallScale: number;
  /** A book row segment narrower than this (m, scaled) is omitted —
   *  a sliver of spines reads as a mistake. Default 0.16. */
  minBookSpan?: number;
}

export type ShelfRectKind = "stile" | "board" | "back" | "books";

/** One drawable rectangle of the bookcase, in (along, y) run space.
 *  `index` is a stable serial within the whole build (safe for React
 *  keys and book-row seed suffixes); books additionally carry their
 *  `bay` and `row`. */
export interface ShelfWallRect {
  kind: ShelfRectKind;
  index: number;
  along0: number;
  along1: number;
  y0: number;
  y1: number;
  bay?: number;
  row?: number;
}

export interface ShelfWallBuild {
  /** The resolved case height (capped under the wall's drawn top). */
  bookH: number;
  /** The case depth off the wall (scaled). */
  depth: number;
  bayCount: number;
  bayWidth: number;
  stile: number;
  board: number;
  plinth: number;
  /** Shelf board CENTERS, bottom to top (what the books stand on). */
  shelfYs: number[];
  stiles: ShelfWallRect[];
  boards: ShelfWallRect[];
  backs: ShelfWallRect[];
  books: ShelfWallRect[];
  rects: ShelfWallRect[];
}

/**
 * Build the shelf wall's rectangles. Returns null when the host cannot
 * hold a bookcase (the SHELF_WALL_MIN_H discipline — a case you could
 * not shelve reads as a crate).
 *
 * The cut rule: an opening cuts a piece only where the two rectangles
 * REALLY intersect. Vertically that means a high opening (clerestory
 * above the case) never touches the case, and a window with a sill
 * leaves every book row below the sill standing; horizontally the
 * surviving segments never cross the opening's frame edges.
 */
export function shelfWallBuild(
  input: ShelfWallInput,
  openings: readonly WallOpening[],
): ShelfWallBuild | null {
  const k = input.wallScale;
  const len = input.len;
  const bookH = Math.min(input.height - 0.06, SHELF_WALL_HEIGHT * k);
  if (bookH < SHELF_WALL_MIN_H * k) return null;

  const depth = SHELF_WALL_DEPTH * k;
  const n = Math.max(1, Math.min(SHELF_WALL_BAY_MAX, Math.round(len / (SHELF_WALL_BAY * k))));
  const bayW = len / n;
  const stile = SHELF_WALL_STILE * k;
  const board = SHELF_WALL_BOARD * k;
  const plinth = SHELF_WALL_PLINTH * k;
  const gap = SHELF_WALL_SHELF_GAP * k;
  const minBookSpan = (input.minBookSpan ?? 0.16) * k;

  const shelfYs: number[] = [];
  for (let y = plinth + gap; y <= bookH - board - 0.04; y += gap) {
    shelfYs.push(y);
  }

  // Only openings intersecting the case's vertical extent can cut
  // anything (a clerestory band above bookH is a no-op by construction).
  const cuts = openings
    .filter((o) => o.bottom < bookH - EPS && o.top > EPS)
    .map(openingRect);

  const stiles: ShelfWallRect[] = [];
  const boards: ShelfWallRect[] = [];
  const backs: ShelfWallRect[] = [];
  const books: ShelfWallRect[] = [];
  let serial = 0;
  const push = (
    list: ShelfWallRect[],
    kind: ShelfRectKind,
    pieces: RunRect[],
    bay?: number,
    row?: number,
  ): void => {
    for (const p of pieces) {
      list.push({
        kind,
        index: serial++,
        along0: p.along0,
        along1: p.along1,
        y0: p.y0,
        y1: p.y1,
        ...(bay === undefined ? {} : { bay }),
        ...(row === undefined ? {} : { row }),
      });
    }
  };

  // Bay-boundary stiles: full-height strips cut vertically by any
  // opening crossing their (thin) horizontal footprint.
  for (let i = 0; i <= n; i++) {
    const a = -len / 2 + i * bayW;
    const rect: RunRect = {
      along0: a - stile / 2,
      along1: a + stile / 2,
      y0: 0,
      y1: bookH,
    };
    const crossing = cuts.filter((c) => rectsIntersect(rect, c));
    push(stiles, "stile", subtractRunRects([rect], crossing), i);
  }

  // Run-length boards: plinth, top, and every shelf — cut horizontally
  // wherever an opening truly crosses the board's vertical band.
  const boardBands: { y: number; t: number; row: number }[] = [
    { y: plinth / 2, t: plinth, row: -1 },
    { y: bookH - board / 2, t: board, row: shelfYs.length },
    ...shelfYs.map((y, s) => ({ y, t: board, row: s })),
  ];
  for (const b of boardBands) {
    const rect: RunRect = {
      along0: -len / 2,
      along1: len / 2,
      y0: b.y - b.t / 2,
      y1: b.y + b.t / 2,
    };
    const crossing = cuts.filter((c) => rectsIntersect(rect, c));
    push(boards, "board", subtractRunRects([rect], crossing), undefined, b.row);
  }

  // The back panel: plinth-top to under the top board, full length —
  // explicitly emitted (the renderer draws it), cut on both axes.
  const backRect: RunRect = {
    along0: -len / 2,
    along1: len / 2,
    y0: plinth,
    y1: bookH - board,
  };
  const backCuts = cuts.filter((c) => rectsIntersect(backRect, c));
  push(backs, "back", subtractRunRects([backRect], backCuts));

  // Book rows: per bay per shelf gap, at the row's REAL y-range, cut
  // around openings; slivers too narrow for a book are omitted.
  for (let bay = 0; bay < n; bay++) {
    const along0 = -len / 2 + bay * bayW + stile / 2 + 0.02;
    const along1 = -len / 2 + (bay + 1) * bayW - stile / 2 - 0.02;
    if (along1 - along0 <= EPS) continue;
    for (let s = 0; s < shelfYs.length; s++) {
      const rowH = gap - board - 0.1 * k - 0.04 * k * (s % 2);
      if (rowH <= 0.05 * k) continue;
      const rect: RunRect = {
        along0,
        along1,
        y0: shelfYs[s] + board / 2,
        y1: shelfYs[s] + board / 2 + rowH,
      };
      const crossing = cuts.filter((c) => rectsIntersect(rect, c));
      const pieces = subtractRunRects([rect], crossing).filter(
        (p) => p.along1 - p.along0 >= minBookSpan - EPS,
      );
      push(books, "books", pieces, bay, s);
    }
  }

  return {
    bookH,
    depth,
    bayCount: n,
    bayWidth: bayW,
    stile,
    board,
    plinth,
    shelfYs,
    stiles,
    boards,
    backs,
    books,
    rects: [...stiles, ...boards, ...backs, ...books],
  };
}
