import { describe, expect, it } from "vitest";
import {
  paperWear,
  wearAttrs,
  WEAR_BANDS,
  WEAR_FOLDS,
} from "@/lib/paper/wear";

/** A fixed "today" so band membership is exact. 2026-10-20T12:00:00Z. */
const NOW = Date.UTC(2026, 9, 20, 12, 0, 0);
const DAY = 86_400_000;

/** A birth stamp N days before NOW. */
function stampDaysAgo(days: number): string {
  return new Date(NOW - days * DAY).toISOString().slice(0, 10);
}

describe("paperWear — band mapping", () => {
  it.each([
    [1, "fresh"],
    [2, "days"],
    [13, "days"],
    [14, "weeks"],
    [55, "weeks"],
    [56, "months"],
    [167, "months"],
    [168, "older"],
    [400, "older"],
  ] as const)("age %id → band %s", (days, band) => {
    expect(paperWear("doc-a", stampDaysAgo(days), NOW).band).toBe(band);
  });
});

describe("paperWear — stability", () => {
  it("same identity + stamp + moment → identical descriptor", () => {
    const a = paperWear("case:dossier/x", "2026-09-01", NOW);
    const b = paperWear("case:dossier/x", "2026-09-01", NOW);
    expect(a).toEqual(b);
  });

  it("same document re-measured inside one band never re-rolls", () => {
    // Born 30 days ago (weeks band: 14–56d). Re-measure across the whole
    // band — every field must hold, only ageDays may move.
    const born = stampDaysAgo(30);
    const first = paperWear("record:r1", born, NOW);
    for (let day = 15; day < 26; day += 2) {
      const again = paperWear("record:r1", born, NOW + day * DAY);
      expect({
        band: again.band,
        fold: again.fold,
        foldAt: again.foldAt,
        ear: again.ear,
        edge: again.edge,
        mottle: again.mottle,
      }).toEqual({
        band: first.band,
        fold: first.fold,
        foldAt: first.foldAt,
        ear: first.ear,
        edge: first.edge,
        mottle: first.mottle,
      });
    }
  });

  it("different identities diverge", () => {
    // Ten identities at the same age — at least two must pick different
    // folds (deterministic seeding makes this stable, not flaky).
    const folds = new Set(
      Array.from({ length: 10 }, (_, i) =>
        paperWear(`doc-${i}`, stampDaysAgo(90), NOW).fold,
      ),
    );
    expect(folds.size).toBeGreaterThan(1);
  });
});

describe("paperWear — ageing across bands", () => {
  it("intensity is non-decreasing as the clock advances", () => {
    const born = "2026-03-01";
    let prev: { edge: number; mottle: number; earOn: boolean } | null = null;
    // Walk the band midpoints: 1d, 7d, 30d, 100d, 300d.
    for (const ageDays of [1, 7, 30, 100, 300]) {
      const at = Date.parse(born) + ageDays * DAY;
      const w = paperWear("case:ageing", born, at);
      const cur = {
        edge: w.edge,
        mottle: w.mottle,
        earOn: w.ear !== "none",
      };
      if (prev) {
        expect(cur.edge).toBeGreaterThanOrEqual(prev.edge);
        expect(cur.mottle).toBeGreaterThanOrEqual(prev.mottle);
        // A corner, once folded, stays folded.
        if (prev.earOn) expect(cur.earOn).toBe(true);
      }
      prev = cur;
    }
  });

  it("fresh paper takes no wear — only the light model", () => {
    const w = paperWear("doc-fresh", stampDaysAgo(0), NOW);
    expect(w).toMatchObject({
      band: "fresh",
      fold: "none",
      ear: "none",
      edge: 0,
      mottle: 0,
    });
  });
});

describe("paperWear — robustness", () => {
  it.each(["", "not-a-date", "2026-13-40"])(
    "unparseable stamp %j → neutral descriptor",
    (stamp) => {
      expect(paperWear("doc-x", stamp, NOW)).toMatchObject({
        band: "fresh",
        bornAt: null,
        fold: "none",
        ear: "none",
        edge: 0,
        mottle: 0,
      });
    },
  );

  it("accepts YYYY-MM-DD stamps", () => {
    const w = paperWear("doc-d", "2026-08-01", NOW);
    expect(w.bornAt).toBe(Date.parse("2026-08-01"));
    expect(w.band).toBe("months");
  });

  it("descriptor values stay inside their closed sets", () => {
    for (let i = 0; i < 50; i++) {
      const w = paperWear(`doc-${i}`, stampDaysAgo((i * 13) % 400), NOW);
      expect(WEAR_BANDS).toContain(w.band);
      expect(WEAR_FOLDS).toContain(w.fold);
      expect(["none", "bl", "br"]).toContain(w.ear);
      expect(w.edge).toBeGreaterThanOrEqual(0);
      expect(w.edge).toBeLessThanOrEqual(3);
      expect(w.mottle).toBeGreaterThanOrEqual(0);
      expect(w.mottle).toBeLessThanOrEqual(2);
    }
  });
});

describe("wearAttrs", () => {
  it("emits only closed-set data attributes", () => {
    const attrs = wearAttrs(paperWear("doc-a", stampDaysAgo(60), NOW));
    expect(Object.keys(attrs).sort()).toEqual(
      [
        "data-wear-band",
        "data-wear-ear",
        "data-wear-edge",
        "data-wear-fold",
        "data-wear-fold-at",
        "data-wear-mottle",
      ].sort(),
    );
    expect(attrs["data-wear-band"]).toBe("months");
  });

  it("is deterministic for the same wear", () => {
    const w = paperWear("doc-a", stampDaysAgo(60), NOW);
    expect(wearAttrs(w)).toEqual(wearAttrs(w));
  });
});
