import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TimelineSliceEntry } from "@/lib/episodic/timeline/types";
import { sliceIdToRelPath } from "@/lib/episodic/paths";

const store = vi.hoisted(() => ({
  getTimelineCatalog: vi.fn(),
  getTimelineSkeleton: vi.fn(),
  sliceEntryFromDisk: vi.fn(),
}));
vi.mock("@/lib/episodic/actions", () => ({
  getTimelineCatalog: store.getTimelineCatalog,
  getTimelineSkeleton: store.getTimelineSkeleton,
}));
vi.mock("@/lib/episodic/timeline/store", () => ({
  sliceEntryFromDisk: store.sliceEntryFromDisk,
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
  store.getTimelineSkeleton.mockReset();
  store.sliceEntryFromDisk.mockReset();
  // Unwindowed: the corpus is the live enumeration's point-read headers
  // (v0.19 R3b) — the action sees the same shape the projection used to ship.
  store.getTimelineCatalog.mockResolvedValue(slices);
  // Windowed: the tree-only skeleton first (ids + derived date/start — the
  // fields the scorer reads stay empty), then one point read per windowed id.
  store.getTimelineSkeleton.mockResolvedValue(
    slices.map((s) => makeEntry(s.id, { needs_marking: true })),
  );
  store.sliceEntryFromDisk.mockImplementation((relPath: string) =>
    Promise.resolve(
      slices.find(
        (s) => relPath.replaceAll("/", "") === s.id.replaceAll("-", ""),
      ) ?? null,
    ),
  );
});

describe("searchSlices", () => {
  it("returns [] when no slices exist yet", async () => {
    store.getTimelineCatalog.mockResolvedValue([]);
    expect(await searchSlices("needle")).toEqual([]);
  });

  it("searches the full corpus without opts — one catalog read, no point reads", async () => {
    const hits = await searchSlices("needle");
    expect(hits).toHaveLength(2);
    expect(hits[0].entry.id).toBe("2026-08-05-0900"); // tie → newest first
    expect(store.getTimelineSkeleton).not.toHaveBeenCalled();
    expect(store.sliceEntryFromDisk).not.toHaveBeenCalled();
  });

  it("applies the date window before scoring — skeleton first, headers only inside the window", async () => {
    const hits = await searchSlices("needle", { to: "2026-08-02" });
    expect(hits.map((h) => h.entry.id)).toEqual(["2026-08-01-0900"]);
    expect(store.getTimelineCatalog).not.toHaveBeenCalled();
    expect(store.sliceEntryFromDisk).toHaveBeenCalledTimes(1);
    expect(store.sliceEntryFromDisk.mock.calls[0][0]).toBe(
      sliceIdToRelPath("2026-08-01-0900"),
    );
  });

  it("treats # tokens as ordinary characters — the #strand syntax retired with the projection (§A.2.4)", async () => {
    expect(await searchSlices("#s1 needle")).toEqual([]);
  });
});
