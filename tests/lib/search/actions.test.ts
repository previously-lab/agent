import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TimelineSliceEntry } from "@/lib/episodic/timeline/types";

const store = vi.hoisted(() => ({ getTimelineCatalog: vi.fn() }));
vi.mock("@/lib/episodic/actions", () => ({
  getTimelineCatalog: store.getTimelineCatalog,
}));

import { searchSlices } from "@/lib/search/actions";

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

const slices = [
  makeEntry("2026-08-01-0900", { focus: "needle in focus" }),
  makeEntry("2026-08-05-0900", { focus: "needle later" }),
];

beforeEach(() => {
  store.getTimelineCatalog.mockReset();
  // The corpus is the live enumeration's point-read headers (v0.19 R3b) —
  // the action sees the same shape the projection used to ship.
  store.getTimelineCatalog.mockResolvedValue(slices);
});

describe("searchSlices", () => {
  it("returns [] when no slices exist yet", async () => {
    store.getTimelineCatalog.mockResolvedValue([]);
    expect(await searchSlices("needle")).toEqual([]);
  });

  it("searches the full corpus without opts", async () => {
    const hits = await searchSlices("needle");
    expect(hits).toHaveLength(2);
    expect(hits[0].entry.id).toBe("2026-08-05-0900"); // tie → newest first
  });

  it("applies the date window before scoring", async () => {
    const hits = await searchSlices("needle", { to: "2026-08-02" });
    expect(hits.map((h) => h.entry.id)).toEqual(["2026-08-01-0900"]);
  });

  it("treats # tokens as ordinary characters — the #strand syntax retired with the projection (§A.2.4)", async () => {
    expect(await searchSlices("#s1 needle")).toEqual([]);
  });
});
