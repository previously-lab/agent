/**
 * Tests for the shelf wall builder (src/lib/game/shelf-wall.ts) — the
 * pure geometry behind the room's bookcase wall. The contract under
 * test:
 *
 *  - Interval/rectangle subtraction is bounded: survivors never overlap
 *    the cut, and touching edges survive.
 *  - Every emitted rectangle (stiles, boards, back panel, book rows) is
 *    DISJOINT from every opening it truly intersects — asserted as real
 *    rectangle intersection, per rect, not as a snapshot.
 *  - Cuts happen only where the vertical ranges really meet: a
 *    clerestory band above the case changes nothing; a window with a
 *    sill leaves every book row below the sill standing.
 *  - Books are split per bay AND per row at their real y-ranges; slivers
 *    too narrow for a book are omitted, not emitted.
 *  - Openings on the reversed (negative) along side and multiple
 *    openings cut symmetrically.
 */
import { describe, it, expect } from "vitest";
import {
  shelfWallBuild,
  subtractIntervals,
  subtractRunRects,
  rectsIntersect,
  type RunRect,
  type WallOpening,
} from "@/lib/game/shelf-wall";

const K = 1;
const LEN = 6;
const HEIGHT = 4;

/** The standard build: 6m run, 4m wall, scale 1 → 2.6m case, 5 bays,
 *  4 shelf rows. No openings. */
function build(openings: readonly WallOpening[] = []) {
  const b = shelfWallBuild({ len: LEN, height: HEIGHT, wallScale: K }, openings);
  expect(b).not.toBeNull();
  return b!;
}

/** Assert NO emitted rect truly intersects ANY opening (the core
 *  invariant — horizontal segments never cross an opening frame, the
 *  back panel is holed, books break around the glass). */
function expectDisjointFromOpenings(
  b: ReturnType<typeof build>,
  openings: readonly WallOpening[],
) {
  const cutRects = openings.map(
    (o): RunRect => ({
      along0: o.along - o.width / 2,
      along1: o.along + o.width / 2,
      y0: o.bottom,
      y1: o.top,
    }),
  );
  for (const r of b.rects) {
    for (const c of cutRects) {
      expect(
        rectsIntersect(
          { along0: r.along0, along1: r.along1, y0: r.y0, y1: r.y1 },
          c,
        ),
        `${r.kind}#${r.index} [${r.along0},${r.along1}]×[${r.y0},${r.y1}] crosses an opening`,
      ).toBe(false);
    }
  }
}

describe("interval subtraction", () => {
  it("removes the cut and keeps both survivors", () => {
    expect(subtractIntervals([[0, 10]], 3, 6)).toEqual([
      [0, 3],
      [6, 10],
    ]);
  });

  it("keeps intervals outside the cut untouched", () => {
    expect(
      subtractIntervals(
        [
          [0, 2],
          [4, 8],
        ],
        2.5,
        3,
      ),
    ).toEqual([
      [0, 2],
      [4, 8],
    ]);
  });

  it("a cut spanning several intervals empties them", () => {
    expect(
      subtractIntervals(
        [
          [0, 1],
          [2, 3],
        ],
        -1,
        5,
      ),
    ).toEqual([]);
  });

  it("a touching cut does not erode the neighbor", () => {
    expect(subtractIntervals([[0, 3]], 3, 9)).toEqual([[0, 3]]);
  });
});

describe("rectangle subtraction", () => {
  it("splits into left/right/below/above", () => {
    const out = subtractRunRects(
      [{ along0: 0, along1: 10, y0: 0, y1: 10 }],
      [{ along0: 4, along1: 6, y0: 3, y1: 7 }],
    );
    expect(out).toHaveLength(4);
    const area = out.reduce((s, r) => s + (r.along1 - r.along0) * (r.y1 - r.y0), 0);
    expect(area).toBeCloseTo(100 - 4 * 2, 6);
    for (const r of out) {
      expect(rectsIntersect(r, { along0: 4, along1: 6, y0: 3, y1: 7 })).toBe(false);
    }
  });
});

describe("the uncut shelf wall", () => {
  const b = build();

  it("resolves the 2.6m case on a 4m wall with 5 bays", () => {
    expect(b.bookH).toBeCloseTo(2.6, 6);
    expect(b.bayCount).toBe(5);
    expect(b.bayWidth).toBeCloseTo(1.2, 6);
  });

  it("emits n+1 stiles, plinth + top + 4 shelves, one back panel", () => {
    expect(b.stiles).toHaveLength(6);
    expect(b.boards).toHaveLength(6); // plinth + 4 shelves + top
    expect(b.backs).toHaveLength(1);
    expect(b.backs[0].along0).toBeCloseTo(-3, 6);
    expect(b.backs[0].along1).toBeCloseTo(3, 6);
    expect(b.backs[0].y0).toBeCloseTo(0.14, 6);
    expect(b.backs[0].y1).toBeCloseTo(2.55, 6);
  });

  it("emits a book row per bay per shelf, inside the bay and above its shelf", () => {
    expect(b.books).toHaveLength(5 * 4);
    for (const book of b.books) {
      expect(book.kind).toBe("books");
      const bayLo = -3 + (book.bay ?? 0) * 1.2 + 0.05;
      const bayHi = -3 + ((book.bay ?? 0) + 1) * 1.2 - 0.05;
      expect(book.along0).toBeGreaterThanOrEqual(bayLo - 1e-6);
      expect(book.along1).toBeLessThanOrEqual(bayHi + 1e-6);
      const shelfY = b.shelfYs[book.row ?? 0];
      expect(book.y0).toBeCloseTo(shelfY + b.board / 2, 6);
    }
  });

  it("stiles stand full height at the bay boundaries", () => {
    for (let i = 0; i <= 5; i++) {
      const st = b.stiles[i];
      expect(st.along0).toBeCloseTo(-3 + i * 1.2 - b.stile / 2, 6);
      expect(st.y0).toBe(0);
      expect(st.y1).toBeCloseTo(b.bookH, 6);
    }
  });
});

describe("cutting around openings", () => {
  it("a host shorter than the minimum shelves nothing", () => {
    // height 1.0 → bookH 0.94, under SHELF_WALL_MIN_H (1.0).
    expect(
      shelfWallBuild({ len: LEN, height: 1.0, wallScale: K }, []),
    ).toBeNull();
  });

  it("a window centered ON a stile cuts the stile below the sill and stops there", () => {
    // along 0.6 is exactly a bay boundary (stile #3).
    const openings: WallOpening[] = [{ along: 0.6, width: 1.5, bottom: 1.0, top: 2.9 }];
    const b = build(openings);
    expectDisjointFromOpenings(b, openings);
    const cutStile = b.stiles.filter(
      (s) => s.along0 < 0.6 && s.along1 > 0.6,
    );
    expect(cutStile).toHaveLength(1);
    expect(cutStile[0].y1).toBeLessThanOrEqual(1.0 + 1e-6);
    expect(cutStile[0].y0).toBe(0);
    // Its untouched neighbors still run full height.
    expect(b.stiles.filter((s) => s.y1 > 2.5)).toHaveLength(5);
  });

  it("boards crossing the opening break at its frame; the plinth and low shelves run on", () => {
    const openings: WallOpening[] = [{ along: 0.6, width: 1.5, bottom: 1.0, top: 2.9 }];
    const b = build(openings);
    expectDisjointFromOpenings(b, openings);
    // Plinth (row -1) and shelf 0 (y 0.62) are below the sill: uncut.
    const uncut = b.boards.filter((x) => (x.row ?? 0) < 1);
    for (const r of uncut) {
      expect(r.along0).toBeCloseTo(-3, 6);
      expect(r.along1).toBeCloseTo(3, 6);
    }
    // Top + shelves 1..3 cross the opening: each split into two.
    const cut = b.boards.filter((x) => (x.row ?? 0) >= 1);
    expect(cut).toHaveLength(4 * 2);
    for (const r of cut) {
      // Every surviving segment lies fully on ONE side of the frame.
      expect(
        r.along1 <= -0.15 + 1e-6 || r.along0 >= 1.35 - 1e-6,
        `board [${r.along0},${r.along1}] crosses the frame`,
      ).toBe(true);
    }
  });

  it("the back panel is holed: sides survive, the strip below the glass survives", () => {
    const openings: WallOpening[] = [{ along: 0.6, width: 1.5, bottom: 1.0, top: 2.9 }];
    const b = build(openings);
    expectDisjointFromOpenings(b, openings);
    expect(b.backs).toHaveLength(3);
    const strip = b.backs.find((r) => r.along0 >= -0.15 - 1e-6 && r.along1 <= 1.35 + 1e-6);
    expect(strip).toBeDefined();
    expect(strip!.y1).toBeLessThanOrEqual(1.0 + 1e-6);
  });

  it("a low window keeps every book row; only stiles/boards in its band are cut", () => {
    const openings: WallOpening[] = [{ along: 0, width: 1.6, bottom: 0.2, top: 0.5 }];
    const b = build(openings);
    expectDisjointFromOpenings(b, openings);
    expect(b.books).toHaveLength(5 * 4); // all rows stand — the sill is above them
    const plinth = b.boards.find((x) => x.row === -1)!;
    expect(plinth.along0).toBeCloseTo(-3, 6); // below the window: untouched
    // Stiles crossing the opening's band are cut at 0.5.
    const cutStiles = b.stiles.filter((s) => s.y1 < 1);
    expect(cutStiles.length).toBeGreaterThan(0);
    for (const s of cutStiles) expect(s.y1).toBeLessThanOrEqual(0.5 + 1e-6);
  });

  it("a clerestory band above the case changes nothing", () => {
    const openings: WallOpening[] = [{ along: 0, width: 4, bottom: 3.0, top: 3.6 }];
    const b = build(openings);
    expectDisjointFromOpenings(b, openings);
    expect(b.rects).toHaveLength(build().rects.length);
  });

  it("a full-height glass span removes the bays it swallows but keeps the rest", () => {
    const openings: WallOpening[] = [{ along: 0, width: 2.0, bottom: 0, top: 4 }];
    const b = build(openings);
    expectDisjointFromOpenings(b, openings);
    // Stiles inside the span (at -0.6 and 0.6) are gone entirely.
    expect(b.stiles.some((s) => s.along0 < 0.6 && s.along1 > 0.6)).toBe(false);
    // Bays 2 and 3 lose every book row touching the span…
    expect(b.books.some((r) => (r.bay ?? 0) === 2)).toBe(false);
    // …while the flanking bays keep all of theirs.
    expect(b.books.filter((r) => (r.bay ?? 0) === 0)).toHaveLength(4);
    expect(b.books.filter((r) => (r.bay ?? 0) === 4)).toHaveLength(4);
    // Bay 3's surviving sliver (along 1.0..1.75) is a real row.
    const sliver = b.books.filter((r) => (r.bay ?? 0) === 3);
    expect(sliver).toHaveLength(4);
    expect(sliver[0].along0).toBeGreaterThanOrEqual(1.0 - 1e-6);
  });

  it("an opening on the negative along side cuts symmetrically", () => {
    const west: WallOpening[] = [{ along: -0.6, width: 1.5, bottom: 1.0, top: 2.9 }];
    const east: WallOpening[] = [{ along: 0.6, width: 1.5, bottom: 1.0, top: 2.9 }];
    const bw = build(west);
    const be = build(east);
    expectDisjointFromOpenings(bw, west);
    // Mirroring the west build reproduces the east build rect-for-rect
    // (float-dust tolerant).
    const mirror = (rs: RunRect[]) =>
      rs
        .map((r) => [-r.along1, -r.along0, r.y0, r.y1] as const)
        .sort((a, b) => a[0] - b[0] || a[2] - b[2]);
    const expectRectsClose = (
      a: readonly (readonly [number, number, number, number])[],
      b: readonly (readonly [number, number, number, number])[],
    ) => {
      expect(a).toHaveLength(b.length);
      for (let i = 0; i < a.length; i++) {
        for (let f = 0; f < 4; f++) {
          expect(a[i][f]).toBeCloseTo(b[i][f], 6);
        }
      }
    };
    const raw = (rs: RunRect[]) =>
      rs
        .map((r) => [r.along0, r.along1, r.y0, r.y1] as const)
        .sort((a, b) => a[0] - b[0] || a[2] - b[2]);
    expectRectsClose(mirror(bw.stiles.map((r) => r)), raw(be.stiles.map((r) => r)));
    expectRectsClose(mirror(bw.books.map((r) => r)), raw(be.books.map((r) => r)));
    expectRectsClose(mirror(bw.backs.map((r) => r)), raw(be.backs.map((r) => r)));
  });

  it("multiple openings cut independently and stay disjoint from all of them", () => {
    const openings: WallOpening[] = [
      { along: -1.8, width: 1.0, bottom: 0.9, top: 2.6 },
      { along: 1.8, width: 1.2, bottom: 0, top: 2.0 },
    ];
    const b = build(openings);
    expectDisjointFromOpenings(b, openings);
    // All six bay boundaries survive in some form…
    expect(b.stiles).toHaveLength(6);
    // …but the two the openings swallow are shortened, not full height.
    const shortened = b.stiles.filter(
      (s) => s.y1 < b.bookH - 1e-6 || s.y0 > 1e-6,
    );
    expect(shortened).toHaveLength(2);
  });

  it("book slivers narrower than minBookSpan are omitted, not emitted", () => {
    const openings: WallOpening[] = [{ along: -0.85, width: 1.3, bottom: 1.0, top: 2.9 }];
    const b = build(openings);
    for (const book of b.books) {
      expect(book.along1 - book.along0).toBeGreaterThanOrEqual(0.16 - 1e-6);
    }
  });

  it("indices are stable across identical builds", () => {
    const openings: WallOpening[] = [{ along: 0.6, width: 1.5, bottom: 1.0, top: 2.9 }];
    expect(build(openings).rects.map((r) => [r.kind, r.index])).toEqual(
      build(openings).rects.map((r) => [r.kind, r.index]),
    );
  });

  it("a real 1.0m sill keeps the row below it and splits the rows it crosses", () => {
    // Window along 0.1, width 0.5: cut band [−0.15, 0.35] × [1.0, 2.9].
    const openings: WallOpening[] = [{ along: 0.1, width: 0.5, bottom: 1.0, top: 2.9 }];
    const b = build(openings);
    expectDisjointFromOpenings(b, openings);
    // Bay 2 spans along [−0.55, 0.55] — the window crosses it.
    const bay2 = b.books.filter((r) => (r.bay ?? 0) === 2);
    // Row 0 (y ≈ 0.645..0.975) stands entirely UNDER the sill: one
    // uncut segment per bay, full bay width.
    const row0 = bay2.filter((r) => r.row === 0);
    expect(row0).toHaveLength(1);
    expect(row0[0].along1 - row0[0].along0).toBeCloseTo(1.1, 6);
    // Rows 1..3 (y ≥ 1.125) cross the glass: each is SEGMENTED around
    // the frame — a surviving book run on each side, not a wholesale
    // bay deletion.
    for (let row = 1; row <= 3; row++) {
      const segs = bay2
        .filter((r) => r.row === row)
        .sort((a, c) => a.along0 - c.along0);
      expect(segs).toHaveLength(2);
      expect(segs[0].along1).toBeLessThanOrEqual(-0.15 + 1e-6);
      expect(segs[1].along0).toBeGreaterThanOrEqual(0.35 - 1e-6);
      for (const s of segs) {
        expect(s.along1 - s.along0).toBeGreaterThanOrEqual(0.16 - 1e-6);
      }
    }
    // The flanking bays keep all four full rows.
    expect(b.books.filter((r) => (r.bay ?? 0) === 1)).toHaveLength(4);
    expect(b.books.filter((r) => (r.bay ?? 0) === 3)).toHaveLength(4);
    // The cut's board is split too: the shelf at row 1's foot breaks at
    // the frame, while the plinth and row-0 shelf run straight through.
    const shelf0 = b.boards.find((x) => x.row === 0)!;
    expect(shelf0.along0).toBeCloseTo(-3, 6);
    const shelf1 = b.boards.filter((x) => x.row === 1);
    expect(shelf1).toHaveLength(2);
  });
});
