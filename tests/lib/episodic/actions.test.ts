/**
 * v0.19 R3b server actions — live-enumeration pagination
 * (getSlicePageWithContent / getTimelineCatalogPage), the jump window, and
 * the arrival gate (getArrivalState).
 *
 * The data layer is mocked at the module boundary: enumerateSliceIds (the
 * live tree enumeration — one call, zero reads), sliceEntryFromDisk (header
 * point reads), loadSlice (slice bodies), loadUserConfig (slicing knobs).
 * There is no catalog projection anymore (§A.2.4).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { TimelineSliceEntry } from "@/lib/episodic/timeline/types";
import type { TimeSlice, Turn } from "@/lib/episodic/types";

const mocks = vi.hoisted(() => ({
  enumerateSliceIds: vi.fn(),
  sliceEntryFromDisk: vi.fn(),
  loadSlice: vi.fn(),
  loadUserConfig: vi.fn(),
  setDemoPersona: vi.fn(),
  readSlicePart: vi.fn(),
  parseSlice: vi.fn(),
  readPreviously: vi.fn(),
}));

vi.mock("@/lib/demo/demo-fs", () => ({
  getDemoPersona: vi.fn(() => "user"),
  listDemoPersonas: vi.fn(async () => []),
  setDemoPersona: mocks.setDemoPersona,
}));

vi.mock("@/lib/episodic/timeline/enumerate", () => ({
  enumerateSliceIds: mocks.enumerateSliceIds,
}));

vi.mock("@/lib/episodic/timeline/store", () => ({
  sliceEntryFromDisk: mocks.sliceEntryFromDisk,
}));

vi.mock("@/lib/episodic/manager", () => ({
  parseSlice: mocks.parseSlice,
  readPreviously: mocks.readPreviously,
  readAgentTimeline: vi.fn(),
  loadSlice: mocks.loadSlice,
  readStrands: vi.fn(async () => ({})),
}));

vi.mock("@/lib/episodic/paths", () => ({
  readSlicePart: mocks.readSlicePart,
  // Faithful to the real converter: "2026-08-11-1001" → "2026/08/11/1001".
  sliceIdToRelPath: (id: string) => id.split("-").slice(0, 4).join("/"),
}));

vi.mock("@/lib/config/loader", () => ({
  loadUserConfig: mocks.loadUserConfig,
  invalidateUserConfigCache: vi.fn(),
}));

import {
  getSlicePageWithContent,
  getSliceJumpWindow,
  getSliceContent,
  getArrivalState,
  getTimelineCatalogPage,
} from "@/lib/episodic/actions";

// ─── Fixtures ────────────────────────────────────────────────────────────

let seq = 0;
function makeEntry(overrides: Partial<TimelineSliceEntry> = {}): TimelineSliceEntry {
  seq += 1;
  // Fixed-width minute part: the live enumeration SORTS ids (unlike the old
  // catalog's insertion order), so lexicographic order must equal seeding
  // order even past seq 100 (the jump-window cap test seeds 600).
  const hh = String(seq).padStart(3, "0");
  const id = `2026-08-11-10${hh}`;
  return {
    id,
    date: "2026-08-11",
    start: `2026-08-11T10:${hh}:00.000Z`,
    end: `2026-08-11T10:${hh}:20.000Z`,
    turn_count: 2,
    status: "closed",
    focus: `focus ${id}`,
    summary: `summary ${id}`,
    tags: ["t"],
    open_loops: [],
    decisions: [],
    strands: ["s"],
    needs_marking: false,
    ...overrides,
  };
}

function makeTurn(content: string, timestamp: string, role: "user" | "agent" = "user"): Turn {
  return { timestamp, role, content };
}

function makeSlice(entry: TimelineSliceEntry, turns: Turn[]): TimeSlice {
  return {
    slice_id: entry.id,
    focus: entry.focus,
    status: entry.status,
    start: entry.start,
    end: entry.end,
    timezone: "UTC",
    summary: entry.summary,
    open_loops: [],
    decisions: [],
    tags: entry.tags,
    related_slices: [],
    loops: [],
    turns,
    estimatedTokens: 0,
  };
}

/** "2026-08-11-1001" → "2026/08/11/1001" (the enumeration's path form). */
function relOf(id: string): string {
  return id.split("-").slice(0, 4).join("/");
}

/**
 * Seed the live tree (oldest → newest): the enumeration lists every slice's
 * rel path, the header point read answers from the same table, and every
 * slice file loads with 2 turns.
 */
function seedLive(count: number): TimelineSliceEntry[] {
  const entries = Array.from({ length: count }, () => makeEntry());
  const byRel = new Map(entries.map((e) => [relOf(e.id), e]));
  mocks.enumerateSliceIds.mockResolvedValue(entries.map((e) => relOf(e.id)));
  mocks.sliceEntryFromDisk.mockImplementation(
    async (rel: string) => byRel.get(rel) ?? null,
  );
  mocks.loadSlice.mockImplementation(async (id: string) => {
    const entry = entries.find((e) => e.id === id);
    if (!entry) return null;
    return makeSlice(entry, [
      makeTurn(`user in ${id}`, entry.start),
      makeTurn(`agent in ${id}`, entry.end ?? entry.start, "agent"),
    ]);
  });
  return entries;
}

beforeEach(() => {
  seq = 0;
  vi.clearAllMocks();
  mocks.loadUserConfig.mockResolvedValue({
    slicing: { maxSliceMinutes: 30, maxTurnsPerSlice: 50, idleGapMinutes: 30 },
  });
});

// ─── getSlicePageWithContent ─────────────────────────────────────────────

describe("getSlicePageWithContent", () => {
  it("returns the newest page oldest→newest with turns filled in, hasMore exact", async () => {
    const entries = seedLive(5);

    const page = await getSlicePageWithContent(null, 3);

    expect(page.slices.map((s) => s.id)).toEqual(
      entries.slice(2).map((e) => e.id),
    );
    expect(page.hasMore).toBe(true);
    const first = page.slices[0];
    expect(first.turns).toHaveLength(2);
    expect(first.turnCount).toBe(2);
    expect(first.focus).toBe(entries[2].focus);
    expect(first.strands).toEqual(["s"]);
  });

  it("pages backwards from the `beforeId` cursor (exclusive) and ends with hasMore false", async () => {
    const entries = seedLive(5);
    const firstPage = await getSlicePageWithContent(null, 3);

    const secondPage = await getSlicePageWithContent(firstPage.slices[0].id, 3);

    expect(secondPage.slices.map((s) => s.id)).toEqual(
      entries.slice(0, 2).map((e) => e.id),
    );
    expect(secondPage.hasMore).toBe(false);
  });

  it("point-reads ONLY the page window — one enumeration, no header reads outside it", async () => {
    // The §A.2.4 acceptance shape: the slice set comes from one enumeration
    // call; headers are point-read for the requested window and nothing else.
    const entries = seedLive(10);

    const page = await getSlicePageWithContent(null, 3);

    expect(mocks.enumerateSliceIds).toHaveBeenCalledTimes(1);
    expect(
      mocks.sliceEntryFromDisk.mock.calls.map((c) => c[0]).sort(),
    ).toEqual(entries.slice(7).map((e) => relOf(e.id)).sort());

    // Date-cursor paging: the next window is cut by the id cursor (the
    // enumeration's own ordering), and again only its own ids are read.
    mocks.sliceEntryFromDisk.mockClear();
    const page2 = await getSlicePageWithContent(page.slices[0].id, 3);
    expect(page2.slices.map((s) => s.id)).toEqual(
      entries.slice(4, 7).map((e) => e.id),
    );
    expect(page2.hasMore).toBe(true);
    expect(
      mocks.sliceEntryFromDisk.mock.calls.map((c) => c[0]).sort(),
    ).toEqual(entries.slice(4, 7).map((e) => relOf(e.id)).sort());
  });

  it("reports hasMore false when the eligible set exactly fills the page", async () => {
    seedLive(3);
    const page = await getSlicePageWithContent(null, 3);
    expect(page.slices).toHaveLength(3);
    expect(page.hasMore).toBe(false);
  });

  it("returns an empty page when the enumeration finds no slices", async () => {
    mocks.enumerateSliceIds.mockResolvedValue([]);
    const page = await getSlicePageWithContent(null, 10);
    expect(page).toEqual({ slices: [], hasMore: false });
    expect(mocks.sliceEntryFromDisk).not.toHaveBeenCalled();
  });

  it("skips phantom entries whose slice file is missing", async () => {
    const entries = seedLive(3);
    mocks.loadSlice.mockImplementation(async (id: string) =>
      id === entries[1].id
        ? null
        : makeSlice(
            entries.find((e) => e.id === id)!,
            [makeTurn("x", entries[0].start)],
          ),
    );

    const page = await getSlicePageWithContent(null, 3);
    expect(page.slices.map((s) => s.id)).toEqual([entries[0].id, entries[2].id]);
    expect(page.hasMore).toBe(false);
  });

  it("carries continuesFrom / closedBy from the point-read header", async () => {
    const entry = makeEntry({ continues_from: "2026-08-11-0958", closed_by: "time_cap" });
    mocks.enumerateSliceIds.mockResolvedValue([relOf(entry.id)]);
    mocks.sliceEntryFromDisk.mockResolvedValue(entry);
    mocks.loadSlice.mockResolvedValue(makeSlice(entry, [makeTurn("x", entry.start)]));

    const page = await getSlicePageWithContent(null, 10);
    expect(page.slices[0].continuesFrom).toBe("2026-08-11-0958");
    expect(page.slices[0].closedBy).toBe("time_cap");
  });

  it("forwards the demo persona (same convention as getSliceContent)", async () => {
    seedLive(1);
    await getSlicePageWithContent(null, 10, "alice");
    expect(mocks.setDemoPersona).toHaveBeenCalledWith("alice");

    mocks.setDemoPersona.mockClear();
    await getSlicePageWithContent(null, 10);
    expect(mocks.setDemoPersona).not.toHaveBeenCalled();
  });
});

// ─── getSliceJumpWindow ──────────────────────────────────────────────────

describe("getSliceJumpWindow", () => {
  it("loads the whole missing stretch in one batch — target inclusive, oldest→newest", async () => {
    const entries = seedLive(6);

    const win = await getSliceJumpWindow(entries[1].id, entries[5].id);

    expect(win.found).toBe(true);
    expect(win.slices.map((s) => s.id)).toEqual(
      entries.slice(1, 5).map((e) => e.id),
    );
    expect(win.slices[0].turns).toHaveLength(2);
    // The enumeration still holds slices older than the batch head.
    expect(win.hasMore).toBe(true);
  });

  it("reports hasMore false when the batch reaches the oldest enumerated slice", async () => {
    const entries = seedLive(4);

    const win = await getSliceJumpWindow(entries[0].id, entries[3].id);

    expect(win.slices.map((s) => s.id)).toEqual(
      entries.slice(0, 3).map((e) => e.id),
    );
    expect(win.hasMore).toBe(false);
  });

  it("with a null oldestLoadedId, stretches from the target to the enumeration's end", async () => {
    const entries = seedLive(5);

    const win = await getSliceJumpWindow(entries[2].id, null);

    expect(win.slices.map((s) => s.id)).toEqual(
      entries.slice(2).map((e) => e.id),
    );
    expect(win.hasMore).toBe(true);
  });

  it("caps from the newest side when the stretch exceeds the jump window", async () => {
    // 600 slices back, a 150-slice cap: the batch must sit flush against the
    // loaded window (no hole) — target stays unloaded for the caller's page
    // loop, hasMore stays true. The cap came DOWN from 500 because a batch is
    // full slices with every turn in them, so the cap is a payload bound as
    // much as a request bound; the client's page loop covers the remainder.
    const entries = seedLive(600);

    const win = await getSliceJumpWindow(entries[0].id, entries[599].id);

    expect(win.found).toBe(true);
    expect(win.slices).toHaveLength(150);
    // Newest-capped: the batch sits flush against the loaded window (index
    // 599 exclusive) — entries[449..598] — with the target left outside.
    expect(win.slices[0].id).toBe(entries[449].id);
    expect(win.slices[149].id).toBe(entries[598].id);
    expect(win.hasMore).toBe(true);
  });

  it("treats an unknown oldestLoadedId as 'stretch to the enumeration's end'", async () => {
    const entries = seedLive(6);

    const win = await getSliceJumpWindow(entries[4].id, "not-on-disk");

    expect(win.found).toBe(true);
    expect(win.slices.map((s) => s.id)).toEqual(
      entries.slice(4).map((e) => e.id),
    );
  });

  it("returns found:false when the target isn't on disk (no index to lag anymore)", async () => {
    seedLive(3);

    const win = await getSliceJumpWindow("2026-08-11-9999", null);

    expect(win).toEqual({ found: false, slices: [], hasMore: true });
  });

  it("skips phantom entries whose slice file is missing", async () => {
    const entries = seedLive(4);
    mocks.loadSlice.mockImplementation(async (id: string) =>
      id === entries[1].id
        ? null
        : makeSlice(
            entries.find((e) => e.id === id)!,
            [makeTurn("x", entries[0].start)],
          ),
    );

    const win = await getSliceJumpWindow(entries[0].id, entries[3].id);

    expect(win.found).toBe(true);
    expect(win.slices.map((s) => s.id)).toEqual([
      entries[0].id,
      entries[2].id,
    ]);
  });

  it("forwards the demo persona", async () => {
    const entries = seedLive(2);
    await getSliceJumpWindow(entries[0].id, entries[1].id, "alice");
    expect(mocks.setDemoPersona).toHaveBeenCalledWith("alice");
  });
});

// ─── getTimelineCatalogPage (month-windowed enumeration paging) ──────────

describe("getTimelineCatalogPage", () => {
  it("cuts the month window from the enumerated ids and point-reads only the window's headers", async () => {
    // Two slices per month across four months — the window cut must be
    // derivable from the ids ALONE (skeleton entries, zero reads), with
    // point reads confined to the window.
    const months = ["2026-05", "2026-06", "2026-07", "2026-08"];
    const entries = months.flatMap((m) =>
      ["11", "12"].map((day) =>
        makeEntry({
          id: `${m}-${day}-1000`,
          date: `${m}-${day}`,
          start: `${m}-${day}T10:00:00.000Z`,
        }),
      ),
    );
    const byRel = new Map(entries.map((e) => [relOf(e.id), e]));
    mocks.enumerateSliceIds.mockResolvedValue(entries.map((e) => relOf(e.id)));
    mocks.sliceEntryFromDisk.mockImplementation(
      async (rel: string) => byRel.get(rel) ?? null,
    );

    const page = await getTimelineCatalogPage(null, 2);

    expect(page.entries.map((e) => e.id)).toEqual(
      entries.slice(4).map((e) => e.id),
    );
    expect(page.oldestMonth).toBe("2026-07");
    expect(page.hasMore).toBe(true);
    expect(
      mocks.sliceEntryFromDisk.mock.calls.map((c) => c[0]).sort(),
    ).toEqual(entries.slice(4).map((e) => relOf(e.id)).sort());

    // Month-cursor paging: strictly older than the previous page's oldest
    // month, and again only the window's headers are read.
    mocks.sliceEntryFromDisk.mockClear();
    const page2 = await getTimelineCatalogPage(page.oldestMonth, 2);
    expect(page2.entries.map((e) => e.id)).toEqual(
      entries.slice(0, 4).map((e) => e.id),
    );
    expect(page2.hasMore).toBe(false);
    expect(
      mocks.sliceEntryFromDisk.mock.calls.map((c) => c[0]).sort(),
    ).toEqual(entries.slice(0, 4).map((e) => relOf(e.id)).sort());
  });
});

// ─── getSliceContent (the card face, and the `full` mode) ────────────────

describe("getSliceContent", () => {
  /** Longer than the frame's 280-char cut, so truncation is observable. */
  const LONG = `${"x".repeat(400)} tail`;

  function seedRead(turnCount: number): Turn[] {
    const turns: Turn[] = Array.from({ length: turnCount }, (_, i) => ({
      timestamp: `2026-08-11T10:${String(i).padStart(2, "0")}:00.000Z`,
      role: i % 2 === 0 ? "user" : "agent",
      content: LONG,
    }));
    mocks.readSlicePart.mockResolvedValue("raw body");
    mocks.readPreviously.mockResolvedValue("previously card");
    mocks.parseSlice.mockReturnValue({
      slice_id: "2026-08-11-1000",
      focus: "focus",
      status: "closed",
      start: "2026-08-11T10:00:00.000Z",
      end: "2026-08-11T10:05:00.000Z",
      timezone: "UTC",
      summary: "summary",
      open_loops: ["loop"],
      decisions: ["decision"],
      tags: [],
      related_slices: [],
      loops: [],
      turns,
      estimatedTokens: 0,
    });
    return turns;
  }

  it("cuts the wire payload to the card's opening rounds by default", async () => {
    seedRead(9);

    const content = await getSliceContent("2026-08-11-1000");

    expect(content!.turns).toHaveLength(4);
    expect(content!.turns[0].content.length).toBeLessThan(LONG.length);
    expect(content!.turns[0].content.endsWith("…")).toBe(true);
    expect(content!.totalTurns).toBe(9);
  });

  it("ships every turn under { full: true }", async () => {
    const turns = seedRead(9);

    const content = await getSliceContent("2026-08-11-1000", undefined, {
      full: true,
    });

    expect(content!.turns).toBe(turns);
    expect(content!.turns).toHaveLength(9);
    // The truncation is a wire saving only: the read and the parse are the
    // same either way.
    expect(mocks.readSlicePart).toHaveBeenCalledTimes(1);
  });

  it("forwards the demo persona", async () => {
    seedRead(1);
    await getSliceContent("2026-08-11-1000", "alice", { full: true });
    expect(mocks.setDemoPersona).toHaveBeenCalledWith("alice");
  });

  it("returns null instead of throwing when the slice body cannot be read", async () => {
    seedRead(1);
    mocks.readSlicePart.mockRejectedValue(new Error("gone"));

    expect(await getSliceContent("2026-08-11-1000")).toBeNull();
  });
});

// ─── getArrivalState ─────────────────────────────────────────────────────

describe("getArrivalState", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-11T12:00:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function seedLastSlice(
    turns: Turn[],
    overrides: Partial<TimeSlice> = {},
    entryOverrides: Partial<TimelineSliceEntry> = {},
  ) {
    const entry = makeEntry({ status: "active", end: undefined, ...entryOverrides });
    mocks.enumerateSliceIds.mockResolvedValue([relOf(entry.id)]);
    // The gate reads the slice's OWN header (status / closedBy) — there is
    // no catalog entry to consult anymore.
    mocks.loadSlice.mockResolvedValue({
      ...makeSlice(entry, turns),
      ...overrides,
    });
    return entry;
  }

  it("resumes when the last turn is younger than the idle gap", async () => {
    const turns = [
      makeTurn("hi", "2026-08-11T11:40:00.000Z"),
      makeTurn("hello", "2026-08-11T11:45:00.000Z", "agent"),
    ];
    const entry = seedLastSlice(turns);

    const state = await getArrivalState();

    expect(state.mode).toBe("resume");
    if (state.mode === "resume") {
      expect(state.sliceId).toBe(entry.id);
      expect(state.turns).toEqual(turns);
      expect(state.focus).toBe(entry.focus);
      expect(state.start).toBe(entry.start);
    }
  });

  it("briefs when the last turn is older than the idle gap", async () => {
    seedLastSlice([makeTurn("old", "2026-08-11T11:00:00.000Z")]);
    const state = await getArrivalState();
    expect(state.mode).toBe("briefing");
  });

  it("briefs at exactly the idle-gap boundary (the slicer closes on >=)", async () => {
    // 30 min gap, last turn exactly 30 min ago — checkIdleGap closes on >=,
    // so the arrival gate must agree (strictly younger = resume).
    seedLastSlice([makeTurn("edge", "2026-08-11T11:30:00.000Z")]);
    const state = await getArrivalState();
    expect(state.mode).toBe("briefing");
  });

  it("follows a custom idleGapMinutes from the user config", async () => {
    mocks.loadUserConfig.mockResolvedValue({
      slicing: { maxSliceMinutes: 30, maxTurnsPerSlice: 50, idleGapMinutes: 120 },
    });
    seedLastSlice([makeTurn("old", "2026-08-11T11:00:00.000Z")]); // 60 min ago
    const state = await getArrivalState();
    expect(state.mode).toBe("resume");
  });

  it("resumes a time_cap/capacity-checkpointed slice within the idle gap (the next turn continues it)", async () => {
    // The newest slice is a closed CHECKPOINT whose follow-up slice
    // housekeeping will create on the next turn (continuesFrom) — arriving
    // now must resume, not brief. The gate reads closedBy from the SLICE'S
    // OWN header and last-activity from the slice turns.
    seedLastSlice(
      [makeTurn("q", "2026-08-11T11:45:00.000Z"), makeTurn("a", "2026-08-11T11:46:00.000Z", "agent")],
      { status: "closed", closedBy: "time_cap", end: "2026-08-11T11:46:00.000Z" },
    );
    expect((await getArrivalState()).mode).toBe("resume");

    seedLastSlice(
      [makeTurn("q", "2026-08-11T11:45:00.000Z")],
      { status: "closed", closedBy: "capacity", end: "2026-08-11T11:45:30.000Z" },
    );
    expect((await getArrivalState()).mode).toBe("resume");
  });

  it("briefs on a genuine boundary (idle_gap / user_explicit / legacy context_lost) even within the idle gap", async () => {
    for (const closedBy of ["idle_gap", "user_explicit", "context_lost"] as const) {
      seedLastSlice(
        [makeTurn("q", "2026-08-11T11:45:00.000Z")],
        { status: "closed", closedBy, end: "2026-08-11T11:45:30.000Z" },
      );
      expect((await getArrivalState()).mode).toBe("briefing");
    }
  });

  it("briefs on an empty enumeration or a missing slice file", async () => {
    mocks.enumerateSliceIds.mockResolvedValue([]);
    expect((await getArrivalState()).mode).toBe("briefing");

    const entry = makeEntry();
    mocks.enumerateSliceIds.mockResolvedValue([relOf(entry.id)]);
    mocks.loadSlice.mockResolvedValue(null);
    expect((await getArrivalState()).mode).toBe("briefing");
  });

  it("falls back to end, then start, when the slice has no turns", async () => {
    // No turns: end is 20 min ago → resume.
    const entry = makeEntry({ end: "2026-08-11T11:40:00.000Z" });
    mocks.enumerateSliceIds.mockResolvedValue([relOf(entry.id)]);
    mocks.loadSlice.mockResolvedValue(makeSlice(entry, []));
    expect((await getArrivalState()).mode).toBe("resume");

    // No turns, no end: start is 2 h ago → briefing.
    const old = makeEntry({ start: "2026-08-11T10:00:00.000Z", end: undefined });
    mocks.enumerateSliceIds.mockResolvedValue([relOf(old.id)]);
    mocks.loadSlice.mockResolvedValue(makeSlice(old, []));
    expect((await getArrivalState()).mode).toBe("briefing");
  });

  it("forwards the demo persona", async () => {
    seedLastSlice([makeTurn("hi", "2026-08-11T11:50:00.000Z")]);
    await getArrivalState("alice");
    expect(mocks.setDemoPersona).toHaveBeenCalledWith("alice");

    mocks.setDemoPersona.mockClear();
    await getArrivalState();
    expect(mocks.setDemoPersona).not.toHaveBeenCalled();
  });
});

// ─── Render matrix (v0.19 R2 / v0.17 §7 acceptance) ──────────────────────
// {closed_by class} × {in/out of the idle window} × {config drift} — the
// newest slice's turns must render EXACTLY ONCE across the two surfaces the
// client composes: the arrival gate (getArrivalState resume) and the paged
// stream (getSlicePageWithContent).

describe("render matrix — the newest slice renders exactly once", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-11T12:00:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const KINDS = [
    { kind: "active", closedBy: undefined },
    { kind: "checkpoint", closedBy: "time_cap" },
    { kind: "boundary", closedBy: "idle_gap" },
  ] as const;
  // 5 min ago is inside both gaps; 60 min ago is outside gap 30 but inside
  // gap 120 — the config-drift column flips the recency verdict, never the
  // boundary verdict.
  const RECENCY_MINUTES = [5, 60] as const;
  const GAPS = [30, 120] as const;

  function seedPair(minutesAgo: number, closedBy?: "time_cap" | "idle_gap") {
    const older = makeEntry({
      id: "2026-08-11-0900",
      start: "2026-08-11T09:00:00.000Z",
      end: "2026-08-11T09:20:00.000Z",
    });
    const lastTurnAt = new Date(Date.now() - minutesAgo * 60_000).toISOString();
    const start = new Date(
      new Date(lastTurnAt).getTime() - 10 * 60_000,
    ).toISOString();
    const hm = start.slice(11, 16).replace(":", "");
    const latest = makeEntry({
      id: `2026-08-11-${hm}`,
      start,
      status: closedBy ? "closed" : "active",
      ...(closedBy
        ? { end: lastTurnAt, closed_by: closedBy }
        : { end: undefined }),
    });
    const turns = [
      makeTurn("latest user", start),
      makeTurn("latest agent", lastTurnAt, "agent"),
    ];
    mocks.enumerateSliceIds.mockResolvedValue([relOf(older.id), relOf(latest.id)]);
    const byRel = new Map([
      [relOf(older.id), older],
      [relOf(latest.id), latest],
    ]);
    mocks.sliceEntryFromDisk.mockImplementation(
      async (rel: string) => byRel.get(rel) ?? null,
    );
    mocks.loadSlice.mockImplementation(async (id: string) => {
      if (id === latest.id)
        return {
          ...makeSlice(latest, turns),
          // The arrival gate's boundary verdict reads the slice's own header.
          ...(closedBy ? { closedBy } : {}),
        };
      if (id === older.id)
        return makeSlice(older, [makeTurn(`user in ${older.id}`, older.start)]);
      return null;
    });
    return { older, latest, turns };
  }

  for (const { kind, closedBy } of KINDS) {
    for (const minutesAgo of RECENCY_MINUTES) {
      for (const gap of GAPS) {
        it(`${kind} / last turn ${minutesAgo} min ago / idleGapMinutes ${gap}`, async () => {
          const { older, latest, turns } = seedPair(minutesAgo, closedBy);
          mocks.loadUserConfig.mockResolvedValue({
            slicing: { maxSliceMinutes: 30, maxTurnsPerSlice: 50, idleGapMinutes: gap },
          });

          const arrival = await getArrivalState();
          const expectResume = kind !== "boundary" && minutesAgo < gap;
          expect(arrival.mode).toBe(expectResume ? "resume" : "briefing");

          // The history page underneath a resume is exclusive at the cursor —
          // the resumed slice never re-appears below itself.
          const pageBefore = await getSlicePageWithContent(latest.id);
          const beforeIds = pageBefore.slices.map((s) => s.id);
          expect(beforeIds).not.toContain(latest.id);
          expect(beforeIds).toContain(older.id);

          // The cold-open stream page carries the newest slice exactly once.
          const firstPage = await getSlicePageWithContent(null);
          expect(
            firstPage.slices.map((s) => s.id).filter((id) => id === latest.id),
          ).toHaveLength(1);

          if (expectResume) {
            if (arrival.mode !== "resume") throw new Error("unreachable");
            expect(arrival.sliceId).toBe(latest.id);
            expect(arrival.turns).toEqual(turns);
          } else {
            // A briefing renders none of the slice's turns — the paged
            // stream (asserted above) is the one surface that shows them.
            expect(arrival).toEqual({ mode: "briefing" });
          }
        });
      }
    }
  }
});
