/**
 * loadReflectionWorld — the lap's world read under the v0.42 §4 scope
 * contract (Stage C2: the range UNION the log, turn-level water level, the
 * boundary beat's closed_by data). The commit-log legs (cursor / reflection
 * log / coverage / summary log) and the slice-head point reads are mocked;
 * the agenda read rides the io-helpers mock. The step runs REAL.
 *
 * Pins:
 *   a. a range on the bell → the scope is the UNION of the range's turns and
 *      the log's uncovered turns (the range is a hint, not the only truth —
 *      §4 [11443]) — everything filtered through the water level;
 *   b. no range (a lost bell) → the scope is the summary log's turns minus
 *      the water level — a SAME-SLICE second round sees only the unprocessed
 *      turns;
 *   c. the log unreadable → the range still stands, the docket carries
 *      `logDegraded` and a warn says so (§3.5-2) — a STATE, not "no work";
 *   c2. an OLD-format water level (`seen: <sliceId>`, whole-slice) still
 *      covers the whole slice (backward compatibility);
 *   d. the scoped slices' heads are point-read: an on-disk closed_by rides
 *      the scope entry and fires the boundary evolution beat (the criterion
 *      itself untouched — only its data is supplied);
 *   e. nothing owed → an empty, CLEAN docket (the shell retires — no model
 *      burn).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  cursor: { sliceId: null as string | null, degraded: false },
  reflectionLogAvailable: true,
  coverage: [] as Array<{ sliceId: string; turnIds: string[] | null }>,
  wholeUpTo: null as string | null,
  coverageDegraded: false,
  summaries: [] as Array<{ sliceId: string; turnIds: string[] }>,
  summariesAvailable: true,
  /** slice heads by REL path ("2026/10/20/1836") for the closed_by point read */
  heads: {} as Record<string, { closed_by?: string }>,
  agenda: "",
}));

vi.mock("@/lib/chat/hq-log", () => ({
  readReflectionCursor: vi.fn(async () => ({
    sliceId: h.cursor.sliceId,
    sha: null,
    at: null,
    degraded: h.cursor.degraded,
  })),
  readReflectionLog: vi.fn(async () => ({
    entries: [] as unknown[],
    available: h.reflectionLogAvailable,
    ...(h.reflectionLogAvailable ? {} : { reason: "log read failed: boom" }),
  })),
  readReflectionCoverage: vi.fn(async () => ({
    covered: h.coverage,
    wholeUpTo: h.wholeUpTo,
    sha: null,
    at: null,
    degraded: h.coverageDegraded,
  })),
  readSummaryLog: vi.fn(async () => ({
    entries: h.summaries,
    available: h.summariesAvailable,
    ...(h.summariesAvailable ? {} : { reason: "summary log read failed: boom" }),
  })),
}));

vi.mock("@/lib/episodic/io-helpers", () => ({
  fsReadFile: vi.fn(async (path: string) => {
    if (path === "memory/self/agenda.md") return h.agenda;
    throw new Error(`ENOENT: ${path}`);
  }),
}));

vi.mock("@/lib/episodic/timeline/store", () => ({
  sliceEntryFromDisk: vi.fn(async (rel: string) => {
    const head = h.heads[rel];
    if (!head) return null;
    return head;
  }),
}));

import { loadReflectionWorld } from "@/app/api/evolution/reflection-steps";

beforeEach(() => {
  vi.clearAllMocks();
  h.cursor = { sliceId: null, degraded: false };
  h.reflectionLogAvailable = true;
  h.coverage = [];
  h.wholeUpTo = null;
  h.coverageDegraded = false;
  h.summaries = [];
  h.summariesAvailable = true;
  h.heads = {};
  h.agenda = "";
});

describe("loadReflectionWorld — the v0.42 §4 scope (C2: union + turn-level level + closedBy)", () => {
  it("a. WITH a range the scope is the UNION of the range's turns and the log's uncovered turns — both legs read, merged per slice", async () => {
    h.summaries = [
      { sliceId: "2026-10-20-1836", turnIds: ["t1"] }, // same slice as the range
      { sliceId: "2026-10-20-0900", turnIds: ["t9"] }, // a lost bell's turn — §3.5 一并吃掉
    ];
    const range = { sliceId: "2026-10-20-1836", turnIds: ["a1b2c3"] };

    const docket = await loadReflectionWorld("2026-10-20", range);

    expect(docket.scope).toEqual([
      { sliceId: "2026-10-20-0900", turnIds: ["t9"] },
      { sliceId: "2026-10-20-1836", turnIds: ["a1b2c3", "t1"] }, // union, deduped
    ]);
    expect(vi.mocked((await import("@/lib/chat/hq-log")).readSummaryLog)).toHaveBeenCalled();
    expect(docket.logDegraded).toBe(false);
  });

  it("a2. the water level filters the UNION's range leg too: an already-processed range turn drops out", async () => {
    h.coverage = [{ sliceId: "2026-10-20-1836", turnIds: ["a1b2c3"] }];
    const range = { sliceId: "2026-10-20-1836", turnIds: ["a1b2c3", "d4e5f6"] };

    const docket = await loadReflectionWorld("2026-10-20", range);

    expect(docket.scope).toEqual([
      { sliceId: "2026-10-20-1836", turnIds: ["d4e5f6"] },
    ]);
  });

  it("b. WITHOUT a range the scope is the log's turns minus the water level — a SAME-SLICE second round sees only the unprocessed turns", async () => {
    // The first round covered t1 of this slice (turn-level seen mark); the
    // summary later added t2. A rangeless unit must now owe ONLY t2.
    h.coverage = [{ sliceId: "2026-10-20-1836", turnIds: ["t1"] }];
    h.summaries = [{ sliceId: "2026-10-20-1836", turnIds: ["t1", "t2"] }];

    const docket = await loadReflectionWorld("2026-10-20");

    expect(docket.scope).toEqual([
      { sliceId: "2026-10-20-1836", turnIds: ["t2"] },
    ]);
  });

  it("c. the summary log unreadable → the range still stands AND the docket carries `logDegraded` (§3.5-2)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      h.summariesAvailable = false;
      const range = { sliceId: "2026-10-20-1836", turnIds: ["a1b2c3"] };

      const docket = await loadReflectionWorld("2026-10-20", range);

      expect(docket.scope).toEqual([
        { sliceId: "2026-10-20-1836", turnIds: ["a1b2c3"] }, // the hint at least
      ]);
      expect(docket.logDegraded).toBe(true);
      expect(
        warn.mock.calls.some((c) =>
          String(c[0]).includes("not treated as 'no work'"),
        ),
      ).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it("c2. the coverage leg itself unreadable → `logDegraded`, and UNKNOWN coverage treats nothing as covered (never 'all done')", async () => {
    h.coverageDegraded = true;
    h.summaries = [{ sliceId: "2026-10-20-0900", turnIds: ["t1"] }];

    const docket = await loadReflectionWorld("2026-10-20");

    expect(docket.scope).toEqual([
      { sliceId: "2026-10-20-0900", turnIds: ["t1"] },
    ]);
    expect(docket.logDegraded).toBe(true);
  });

  it("c3. an OLD-format water level (wholeUpTo) still covers whole slices — backward compatibility end to end", async () => {
    h.wholeUpTo = "2026-10-19-1800"; // an old `seen: 2026-10-19-1800` round
    h.summaries = [
      { sliceId: "2026-10-19-1800", turnIds: ["t1", "t2"] }, // ≤ level, unmarked → whole-covered
      { sliceId: "2026-10-20-0900", turnIds: ["t3"] }, // past the level → owed
    ];

    const docket = await loadReflectionWorld("2026-10-20");

    expect(docket.scope).toEqual([
      { sliceId: "2026-10-20-0900", turnIds: ["t3"] },
    ]);
    expect(docket.logDegraded).toBe(false);
  });

  it("d. a scoped slice's on-disk closed_by is point-read onto the scope entry — and the boundary beat's criterion (untouched) now fires on it", async () => {
    h.summaries = [{ sliceId: "2026-10-20-1836", turnIds: ["a1b2c3"] }];
    h.heads = { "2026/10/20/1836": { closed_by: "idle_gap" } };
    // Same-day evolution: isolate the boundary reason from the daily one.
    const log = await import("@/lib/chat/hq-log");
    vi.mocked(log.readReflectionLog).mockResolvedValueOnce({
      entries: [
        {
          sha: "s1",
          committedAt: "2026-10-20T10:00:00.000Z",
          parsed: {
            date: "2026-10-20",
            note: null,
            trailer: { seen: [{ sliceId: "2026-10-20-1200" }], evolved: { date: "2026-10-20" } },
          },
          files: [],
        },
      ],
      available: true,
    });

    const docket = await loadReflectionWorld("2026-10-20");

    expect(docket.scope[0]).toEqual({
      sliceId: "2026-10-20-1836",
      turnIds: ["a1b2c3"],
      closedBy: "idle_gap",
    });
    expect(docket.evolutionReasons).toEqual(["conversation_boundary"]);
  });

  it("d2. an OPEN scoped slice (no head mark) simply carries no closedBy — the boundary reason stays silent (daily isolated to today)", async () => {
    h.summaries = [{ sliceId: "2026-10-20-1836", turnIds: ["a1b2c3"] }];
    // heads empty — the point read returns null. Same-day evolution stamp so
    // ONLY the boundary reason could fire.
    const log = await import("@/lib/chat/hq-log");
    vi.mocked(log.readReflectionLog).mockResolvedValueOnce({
      entries: [
        {
          sha: "s1",
          committedAt: "2026-10-20T10:00:00.000Z",
          parsed: {
            date: "2026-10-20",
            note: null,
            trailer: { seen: [{ sliceId: "2026-10-20-1200" }], evolved: { date: "2026-10-20" } },
          },
          files: [],
        },
      ],
      available: true,
    });
    const docket = await loadReflectionWorld("2026-10-20");
    expect(docket.scope[0]).toEqual({
      sliceId: "2026-10-20-1836",
      turnIds: ["a1b2c3"],
    });
    expect(docket.evolutionReasons).toEqual([]);
  });

  it("e. nothing owed (an empty, readable log) → an empty, CLEAN docket — the shell retires without burning the model", async () => {
    h.cursor = { sliceId: "2026-10-20-1836", degraded: false };

    const docket = await loadReflectionWorld("2026-10-20");

    expect(docket.scope).toEqual([]);
    expect(docket.evolutionDue).toBe(false);
    expect(docket.agendaDue).toEqual([]);
    expect(docket.logDegraded).toBe(false);
  });
});
