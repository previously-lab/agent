/**
 * The archive field's model — tiers, time buckets, columns, geometry, and the
 * unit flattening the virtual scroller lays out. Pure functions; no DOM.
 */
import { describe, expect, it } from "vitest";

import type { ArchivePile, ArchiveRecord } from "@/lib/archive/actions";
import {
  archiveColumns,
  archiveGeometry,
  bucketCells,
  bucketKeyFor,
  buildArchiveUnits,
  buildBuckets,
  PILE_TIERS,
  sheetsForTier,
  tierForPages,
  weekStartFor,
} from "@/components/archive/archive-model";

function pile(over: Partial<ArchivePile>): ArchivePile {
  return {
    kind: "case",
    category: "research",
    name: "case",
    ref: "research/case",
    opened: "2026-10-01",
    updated: "2026-10-01",
    pages: 1,
    ...over,
  };
}

describe("tierForPages", () => {
  it("tiers the volume and caps the thick pile at 10 sheets", () => {
    expect(tierForPages(1)).toBe("thin");
    expect(tierForPages(3)).toBe("thin");
    expect(tierForPages(4)).toBe("medium");
    expect(tierForPages(9)).toBe("medium");
    expect(tierForPages(10)).toBe("thick");
    expect(tierForPages(23)).toBe("thick");
    expect(sheetsForTier("thick")).toBe(10);
    // The one constant: thresholds and caps are the same table.
    expect(PILE_TIERS.map((t) => t.sheets)).toEqual([3, 6, 10]);
  });
});

describe("bucketKeyFor", () => {
  const today = "2026-10-06";
  it("days for the trailing week, ISO weeks (Monday) beyond", () => {
    expect(bucketKeyFor("2026-10-06", today)).toEqual({
      key: "d:2026-10-06",
      kind: "day",
      date: "2026-10-06",
    });
    expect(bucketKeyFor("2026-09-30", today).kind).toBe("day");
    // 2026-09-28 is eight days back — a week bucket starting Monday 09-28.
    expect(bucketKeyFor("2026-09-28", today)).toEqual({
      key: "w:2026-09-28",
      kind: "week",
      date: "2026-09-28",
    });
    // 2026-09-20 (a Sunday) belongs to the week of Monday 09-14.
    expect(bucketKeyFor("2026-09-20", today).date).toBe("2026-09-14");
  });
  it("a dateless case falls into the undated bucket", () => {
    expect(bucketKeyFor("", today)).toEqual({
      key: "u:",
      kind: "undated",
      date: "",
    });
  });
});

describe("weekStartFor", () => {
  it("returns the Monday of the date's own week", () => {
    expect(weekStartFor("2026-10-06")).toBe("2026-10-05"); // Tuesday
    expect(weekStartFor("2026-10-05")).toBe("2026-10-05"); // Monday itself
    expect(weekStartFor("2026-10-11")).toBe("2026-10-05"); // Sunday
  });
});

describe("buildBuckets", () => {
  it("groups by bucket, newest first, undated last", () => {
    const buckets = buildBuckets(
      [
        pile({ name: "old", updated: "2026-08-10" }),
        pile({ name: "today", updated: "2026-10-06" }),
        pile({ name: "nodate", updated: "", opened: "" }),
        pile({ name: "yesterday", updated: "2026-10-05" }),
      ],
      "2026-10-06",
    );
    expect(buckets.map((b) => b.key)).toEqual([
      "d:2026-10-06",
      "d:2026-10-05",
      "w:2026-08-10",
      "u:",
    ]);
  });

  it("orders a bucket's piles newest-touched first", () => {
    const [bucket] = buildBuckets(
      [
        pile({ name: "b", updated: "2026-10-06" }),
        pile({ name: "a", updated: "2026-10-06" }),
      ],
      "2026-10-06",
    );
    expect(bucket.piles.map((p) => p.name)).toEqual(["a", "b"]);
  });
});

describe("archiveColumns", () => {
  it("keeps the category table's order and drops empty categories", () => {
    const columns = archiveColumns([
      pile({ category: "self", name: "s" }),
      pile({ category: "people", name: "p" }),
      pile({ category: "research", name: "r" }),
    ]);
    expect(columns).toEqual(["people", "research", "self"]);
    expect(columns).not.toContain("tasks");
  });
});

describe("bucketCells", () => {
  it("places piles in column order and keeps collisions side by side", () => {
    const bucket = buildBuckets(
      [
        pile({ category: "self", name: "s1", updated: "2026-10-06" }),
        pile({ category: "people", name: "p1", updated: "2026-10-06" }),
        pile({ category: "self", name: "s2", updated: "2026-10-06" }),
      ],
      "2026-10-06",
    )[0];
    const cells = bucketCells(bucket, ["people", "self"]);
    expect(
      cells.map((cell) => cell.piles.map((p) => ("name" in p ? p.name : p.ref))),
    ).toEqual([
      ["p1"],
      ["s1", "s2"],
    ]);
    expect(cells.map((cell) => cell.column)).toEqual([0, 1]);
  });
});

// ─── Records (v0.25b §三) — one record pile per time bucket ────────────────

function record(sliceId: string, turns: number): ArchiveRecord {
  return { sliceId, date: sliceId.slice(0, 10), turns };
}

describe("records in the field", () => {
  it("a bucket with only records is still a row", () => {
    const buckets = buildBuckets([], "2026-10-06", [record("2026-10-05-0900", 4)]);
    expect(buckets.map((b) => b.key)).toEqual(["d:2026-10-05"]);
    expect(buckets[0].piles).toEqual([]);
    expect(buckets[0].record).toMatchObject({
      kind: "record",
      ref: "records/2026-10-05-0900",
      slices: 1,
      turns: 4,
    });
  });

  it("folds a bucket's slices into ONE pile: newest slice opens, turns sum", () => {
    const buckets = buildBuckets([], "2026-10-06", [
      record("2026-10-06-0900", 4),
      record("2026-10-06-2130", 8),
      record("2026-10-04-1200", 3),
    ]);
    expect(buckets.map((b) => b.key)).toEqual(["d:2026-10-06", "d:2026-10-04"]);
    expect(buckets[0].record).toMatchObject({
      ref: "records/2026-10-06-2130",
      date: "2026-10-06",
      slices: 2,
      turns: 12,
    });
  });

  it("cases and records share a bucket without merging", () => {
    const [bucket] = buildBuckets(
      [pile({ name: "a", updated: "2026-10-06" })],
      "2026-10-06",
      [record("2026-10-06-0900", 4)],
    );
    expect(bucket.piles.map((p) => p.name)).toEqual(["a"]);
    expect(bucket.record?.ref).toBe("records/2026-10-06-0900");
  });

  it("the records column trails, and exists only while records do", () => {
    expect(archiveColumns([pile({ category: "self" })])).toEqual(["self"]);
    expect(
      archiveColumns([pile({ category: "self" })], [record("2026-10-06-0900", 4)]),
    ).toEqual(["self", "records"]);
  });

  it("the record pile takes the records column's cell", () => {
    const [bucket] = buildBuckets(
      [pile({ category: "self", name: "s", updated: "2026-10-06" })],
      "2026-10-06",
      [record("2026-10-06-0900", 4)],
    );
    const cells = bucketCells(bucket, ["self", "records"]);
    expect(cells.map((cell) => cell.column)).toEqual([0, 1]);
    expect(cells[1].piles).toEqual([bucket.record]);
  });
});

describe("archiveGeometry", () => {
  it("is a single column below md, a grid at desktop widths", () => {
    const mobile = archiveGeometry(390, 3);
    expect(mobile.labelW).toBe(0);
    expect(mobile.pileW).toBeGreaterThanOrEqual(200);
    expect(mobile.pileW).toBeLessThanOrEqual(300);
    expect(mobile.pileUnitH).toBeGreaterThan(mobile.pileH);

    const desktop = archiveGeometry(1440, 3);
    expect(desktop.labelW).toBe(96);
    expect(desktop.pileW).toBeLessThanOrEqual(180);
    expect(desktop.rowH).toBeGreaterThan(desktop.pileH);
  });
});

describe("buildArchiveUnits", () => {
  const buckets = buildBuckets(
    [
      pile({ name: "a", updated: "2026-10-06" }),
      pile({ name: "b", updated: "2026-10-06", category: "self" }),
      pile({ name: "c", updated: "2026-08-10" }),
    ],
    "2026-10-06",
  );
  const columns = archiveColumns(buckets.flatMap((b) => b.piles));

  it("desktop: one header unit plus one row per bucket", () => {
    const geo = archiveGeometry(1440, columns.length);
    const units = buildArchiveUnits(buckets, columns, geo, false);
    expect(units.map((u) => u.kind)).toEqual(["header", "row", "row"]);
    const row = units[1];
    if (row.kind !== "row") throw new Error("expected a row");
    expect(
      row.cells.flatMap((c) => c.piles).map((p) => ("name" in p ? p.name : p.ref)),
    ).toEqual(["a", "b"]);
    expect(row.height).toBe(geo.rowH);
  });

  it("single column: a label unit per bucket, then one unit per pile", () => {
    const geo = archiveGeometry(390, 1);
    const units = buildArchiveUnits(buckets, columns, geo, true);
    expect(units.map((u) => u.kind)).toEqual([
      "bucket",
      "pile",
      "pile",
      "bucket",
      "pile",
    ]);
    expect(units.every((u) => u.height > 0)).toBe(true);
  });
});
