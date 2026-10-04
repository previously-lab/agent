import { describe, it, expect } from "vitest";
import {
  searchCatalog,
  filterByWindow,
  sortNewestFirst,
  queryKeyword,
} from "@/lib/search/slice-search";
import type { TimelineSliceEntry } from "@/lib/episodic/timeline/types";

function makeEntry(
  id: string,
  over: Partial<TimelineSliceEntry> = {},
): TimelineSliceEntry {
  return {
    id,
    date: id.slice(0, 10),
    start: `${id.slice(0, 10)}T00:00:00Z`,
    status: "closed",
    focus: "",
    summary: "",
    tags: [],
    open_loops: [],
    decisions: [],
    strands: [],
    needs_marking: false,
    ...over,
  };
}

const catalog: TimelineSliceEntry[] = [
  makeEntry("2026-08-01-0900", {
    focus: "Plans the memory visualization milestone",
    summary: "Discussed the 3D timeline and the unified message stream.",
  }),
  makeEntry("2026-08-02-1430", {
    focus: "Debugs the episodic slicer",
    summary: "Fixed a race in slice closing.",
  }),
  makeEntry("2026-08-03-1015", {
    focus: "Reviews the recall sub-agent",
    summary: "memory memory memory — the recall quota was tuned.",
    open_loops: ["Wire the memory card diff into housekeeping"],
    decisions: ["Keep memory quota at 8 slices"],
  }),
];

describe("searchCatalog", () => {
  it("returns [] for an empty query", () => {
    expect(searchCatalog(catalog, "")).toEqual([]);
    expect(searchCatalog(catalog, "   ")).toEqual([]);
  });

  it("returns [] when nothing matches", () => {
    expect(searchCatalog(catalog, "kubernetes")).toEqual([]);
  });

  it("matches case-insensitively and reports matchedFields with snippets", () => {
    const hits = searchCatalog(catalog, "MEMORY");
    const entry1 = hits.find((h) => h.entry.id === "2026-08-01-0900")!;
    expect(entry1.matchedFields).toEqual(["focus"]);
    const entry3 = hits.find((h) => h.entry.id === "2026-08-03-1015")!;
    // matchedFields come in canonical weight order (focus > summary >
    // open_loops > decisions), not field-iteration order.
    expect(entry3.matchedFields).toEqual(["summary", "open_loops", "decisions"]);
    // Array fields snippet the whole matching item.
    const loopsMatch = entry3.matches.find((m) => m.field === "open_loops")!;
    expect(loopsMatch.snippets).toEqual([
      "Wire the memory card diff into housekeeping",
    ]);
  });

  it("weights focus > summary > open_loops/decisions (§A.2.4)", () => {
    const entries = [
      makeEntry("2026-08-01-0901", { decisions: ["needle"] }),
      makeEntry("2026-08-01-0902", { open_loops: ["needle"] }),
      makeEntry("2026-08-01-0903", { summary: "needle" }),
      makeEntry("2026-08-01-0904", { focus: "needle" }),
    ];
    const ids = searchCatalog(entries, "needle").map((h) => h.entry.id);
    expect(ids).toEqual([
      "2026-08-01-0904", // focus (4)
      "2026-08-01-0903", // summary (3)
      "2026-08-01-0902", // open_loops (2) — tie with decisions, newer id wins
      "2026-08-01-0901", // decisions (2)
    ]);
  });

  it("ignores tags and strands — both left the weight table with the projection (§A.2.4)", () => {
    const entries = [
      makeEntry("2026-08-01-0900", { tags: ["needle"], strands: ["needle"] }),
    ];
    expect(searchCatalog(entries, "needle")).toEqual([]);
  });

  it("treats # as an ordinary character — the #strand syntax retired with the projection", () => {
    // No field contains the literal "#memory-viz", so nothing matches.
    expect(searchCatalog(catalog, "#memory-viz")).toEqual([]);
  });

  it("weights hit count: more occurrences in the same field score higher", () => {
    const hits = searchCatalog(catalog, "memory");
    const repeated = hits.find((h) => h.entry.id === "2026-08-03-1015")!;
    // summary has 3 occurrences (3×3) + open_loops 1 (2) + decisions 1 (2)
    // = 13 — beats entry 1's single focus hit (4).
    expect(repeated.score).toBe(3 * 3 + 2 + 2);
    expect(hits[0].entry.id).toBe("2026-08-03-1015");
  });

  it("counts each matching array item once", () => {
    const entries = [
      makeEntry("2026-08-01-0900", { open_loops: ["needle-a", "needle-b"] }),
      makeEntry("2026-08-01-0901", { open_loops: ["needle-a"] }),
    ];
    const hits = searchCatalog(entries, "needle");
    expect(hits[0].entry.id).toBe("2026-08-01-0900");
    expect(hits[0].score).toBe(4);
    expect(hits[1].score).toBe(2);
  });

  it("extracts windowed snippets with ellipses from long string fields", () => {
    const pad = "x".repeat(60);
    const entries = [
      makeEntry("2026-08-01-0900", { summary: `${pad}needle${pad}` }),
    ];
    const [hit] = searchCatalog(entries, "needle");
    const snippet = hit.matches[0].snippets[0];
    expect(snippet.startsWith("…")).toBe(true);
    expect(snippet.endsWith("…")).toBe(true);
    expect(snippet).toContain("needle");
  });

  it("breaks score ties newest-first by id", () => {
    const entries = [
      makeEntry("2026-08-01-0900", { focus: "needle" }),
      makeEntry("2026-08-02-0900", { focus: "needle" }),
    ];
    const hits = searchCatalog(entries, "needle");
    expect(hits.map((h) => h.entry.id)).toEqual([
      "2026-08-02-0900",
      "2026-08-01-0900",
    ]);
  });
});

describe("filterByWindow", () => {
  it("keeps entries inside the inclusive window (id date semantics)", () => {
    const out = filterByWindow(catalog, "2026-08-02", "2026-08-03");
    expect(out.map((s) => s.id)).toEqual(["2026-08-02-1430", "2026-08-03-1015"]);
  });

  it("supports open-ended bounds", () => {
    expect(filterByWindow(catalog, "2026-08-02").map((s) => s.id)).toEqual([
      "2026-08-02-1430",
      "2026-08-03-1015",
    ]);
    expect(filterByWindow(catalog, undefined, "2026-08-01").map((s) => s.id)).toEqual([
      "2026-08-01-0900",
    ]);
  });

  it("returns everything when both bounds are omitted", () => {
    expect(filterByWindow(catalog)).toHaveLength(catalog.length);
  });

  it("returns [] for an empty window", () => {
    expect(filterByWindow(catalog, "2030-01-01", "2030-01-02")).toEqual([]);
  });
});

describe("sortNewestFirst", () => {
  it("orders by id descending without mutating the input", () => {
    const input = [
      makeEntry("2026-08-01-0900"),
      makeEntry("2026-08-03-1015"),
      makeEntry("2026-08-02-1430"),
    ];
    const out = sortNewestFirst(input);
    expect(out.map((s) => s.id)).toEqual([
      "2026-08-03-1015",
      "2026-08-02-1430",
      "2026-08-01-0900",
    ]);
    // Input untouched.
    expect(input[0].id).toBe("2026-08-01-0900");
  });
});

describe("queryKeyword", () => {
  it("is the query, trimmed — # tokens are ordinary characters now (§A.2.4)", () => {
    expect(queryKeyword("  memory  ")).toBe("memory");
    expect(queryKeyword("#recall")).toBe("#recall");
  });
});
