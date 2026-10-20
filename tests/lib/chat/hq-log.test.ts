/**
 * The reflection log reader (v0.39 §2.4/§2.5) — cursor/note from the commit
 * history, over a mocked backend boundary: the LOCAL backend (isomorphic-git
 * through local-git) with a fake git log, and the degradation paths. The
 * GitHub leg shares the same shapeEntries logic and is exercised through the
 * parse/filter behavior here; its octokit paging is thin enough to stay
 * mock-covered at the route level.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  source: "local" as string,
  logCommits: vi.fn(),
  isGitRepo: vi.fn(() => true),
}));

vi.mock("@/lib/data-source/resolve", () => ({
  resolveDataSource: () => h.source,
}));

vi.mock("@/lib/episodic/local-git", () => ({
  isGitRepo: h.isGitRepo,
  logCommits: h.logCommits,
}));

vi.mock("@/lib/whitelist", () => ({
  getMemoryRoot: () => "/fake/memory",
}));

import {
  readReflectionCursor,
  readLatestReflectionNote,
  readReflectionCoverage,
  readReflectionLog,
  readRecentSummaries,
  readHQLogBundle,
} from "@/lib/chat/hq-log";

const ROUND = (over: { message?: string; oid?: string; ts?: number }) => ({
  oid: over.oid ?? "sha-1",
  message: over.message ?? "Reflection round — 2026-10-19",
  committedAtMs: over.ts ?? Date.parse("2026-10-19T17:00:00.000Z"),
});

beforeEach(() => {
  vi.clearAllMocks();
  h.source = "local";
  h.isGitRepo.mockReturnValue(true);
});

describe("readReflectionCursor — the water level (v0.39 §2.4)", () => {
  it("the newest CLEAN round's seen trailer is the level (failed rounds are skipped)", async () => {
    h.logCommits.mockResolvedValue([
      // newest: a FAILED round (no trailer) — skipped
      ROUND({ message: "Reflection round — 2026-10-19", oid: "sha-fail" }),
      // next: a clean round WITH the level
      ROUND({
        message:
          "Reflection round — 2026-10-19\n\n处理了周末。\n\n—\nseen: 2026-10-19-1721",
        oid: "sha-clean",
      }),
      // older clean round — NOT the level
      ROUND({
        message: "Reflection round — 2026-10-18\n\n—\nseen: 2026-10-18-0900",
        oid: "sha-old",
      }),
    ]);

    const cursor = await readReflectionCursor();

    expect(cursor).toEqual({
      sliceId: "2026-10-19-1721",
      sha: "sha-clean",
      at: "2026-10-19T17:00:00.000Z",
      degraded: false,
    });
  });

  it("断链兜底: no reflection commit in the bounded scan → cursor null + warn (全量重读)", async () => {
    h.logCommits.mockResolvedValue([
      { oid: "t1", message: "Turn a1b2c3 — reply", committedAtMs: 1 },
      { oid: "t2", message: "Turn d4e5f6 — user turn", committedAtMs: 2 },
    ]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const cursor = await readReflectionCursor();
      expect(cursor.sliceId).toBeNull();
      expect(cursor.degraded).toBe(true);
      expect(
        warn.mock.calls.some((c) =>
          String(c[0]).includes("cursor fallback"),
        ),
      ).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it("本地非 git 后端 (#20 — fail-safe): available=false with the git init advice, cursor null", async () => {
    h.isGitRepo.mockReturnValue(false);
    const log = await readReflectionLog();
    expect(log.available).toBe(false);
    expect(log.reason).toContain("git init");
    const cursor = await readReflectionCursor();
    expect(cursor.sliceId).toBeNull();
    expect(cursor.degraded).toBe(true);
  });
});

describe("readReflectionCoverage — the TURN-level water level (v0.42 §4)", () => {
  it("turn-level marks UNION per slice across rounds; sha/at ride the NEWEST marked round", async () => {
    h.logCommits.mockResolvedValue([
      // newest: a round that marked two slices
      ROUND({ message: "Reflection round — 2026-10-20\n\n—\nseen: 2026-10-20-0900#t3\nseen: 2026-10-19-1800#t2", oid: "new" }),
      // older: t1 of the 19th slice — under the UNION it ACCUMULATES with t2
      // (turn-level coverage only grows; newest-wins was the slice-level bug).
      ROUND({ message: "Reflection round — 2026-10-19\n\n—\nseen: 2026-10-19-1800#t1", oid: "old" }),
    ]);

    const coverage = await readReflectionCoverage();

    expect(coverage.degraded).toBe(false);
    expect(coverage.sha).toBe("new");
    expect(coverage.covered).toEqual([
      { sliceId: "2026-10-20-0900", turnIds: ["t3"] },
      { sliceId: "2026-10-19-1800", turnIds: ["t2", "t1"] }, // the union
    ]);
  });

  it("turn-level marks UNION per slice: one round's turn never subsume another round's turn of the SAME slice (the 2026-10-20-0831 livelock)", async () => {
    // The real-machine shape: two rounds, each covering ONE turn of the same
    // slice. Newest-wins hid the older turn → it read as unprocessed → the
    // unit re-ran the slice forever (five round commits ping-ponging).
    h.logCommits.mockResolvedValue([
      ROUND({ message: "Reflection round — 2026-10-20\n\n—\nseen: 2026-10-20-0831#YcuFGA", oid: "n" }),
      ROUND({ message: "Reflection round — 2026-10-20\n\n—\nseen: 2026-10-20-0831#4HH9hQ", oid: "o" }),
    ]);

    const coverage = await readReflectionCoverage();

    expect(coverage.degraded).toBe(false);
    expect(coverage.covered).toEqual([
      // BOTH turns of the slice are covered — the union, not the newest mark.
      { sliceId: "2026-10-20-0831", turnIds: ["YcuFGA", "4HH9hQ"] },
    ]);
  });

  it("mixed history, turn-level FIRST then a whole-slice mark → the slice reads as WHOLE-covered", async () => {
    h.logCommits.mockResolvedValue([
      ROUND({ message: "Reflection round — 2026-10-20\n\n—\nseen: 2026-10-20-0900", oid: "whole" }),
      ROUND({ message: "Reflection round — 2026-10-20\n\n—\nseen: 2026-10-20-0900#t1", oid: "turn" }),
    ]);

    const coverage = await readReflectionCoverage();

    expect(coverage.covered).toEqual([
      { sliceId: "2026-10-20-0900", turnIds: null },
    ]);
  });

  it("mixed history, whole-slice FIRST then turn-level → still WHOLE-covered, never shrunk back to a list", async () => {
    h.logCommits.mockResolvedValue([
      ROUND({ message: "Reflection round — 2026-10-20\n\n—\nseen: 2026-10-20-0900#t1", oid: "turn" }),
      ROUND({ message: "Reflection round — 2026-10-20\n\n—\nseen: 2026-10-20-0900", oid: "whole" }),
      // …and a later turn-level mark must NOT shrink it either.
      ROUND({ message: "Reflection round — 2026-10-20\n\n—\nseen: 2026-10-20-0900#t2", oid: "turn2" }),
    ]);

    const coverage = await readReflectionCoverage();

    expect(coverage.covered).toEqual([
      { sliceId: "2026-10-20-0900", turnIds: null },
    ]);
  });

  it("an OLD-format bare `seen: <sliceId>` still covers the WHOLE slice and lifts wholeUpTo", async () => {
    h.logCommits.mockResolvedValue([
      ROUND({ message: "Reflection round — 2026-10-19\n\n—\nseen: 2026-10-19-1721", oid: "s1" }),
    ]);

    const coverage = await readReflectionCoverage();

    expect(coverage.covered).toEqual([
      { sliceId: "2026-10-19-1721", turnIds: null },
    ]);
    expect(coverage.wholeUpTo).toBe("2026-10-19-1721");
  });

  it("mixed history: an old whole-slice level BELOW a newer explicit mark — the explicit mark wins for its slice, wholeUpTo fills the rest", async () => {
    h.logCommits.mockResolvedValue([
      ROUND({ message: "Reflection round — 2026-10-20\n\n—\nseen: 2026-10-20-0900#t3", oid: "n" }),
      ROUND({ message: "Reflection round — 2026-10-19\n\n—\nseen: 2026-10-19-1721", oid: "o" }),
    ]);

    const coverage = await readReflectionCoverage();

    expect(coverage.covered).toEqual([
      { sliceId: "2026-10-20-0900", turnIds: ["t3"] },
      { sliceId: "2026-10-19-1721", turnIds: null },
    ]);
    expect(coverage.wholeUpTo).toBe("2026-10-19-1721");
  });

  it("failed (trailer-less) and superseded rounds contribute NOTHING; the newest CLEAN marks define the level", async () => {
    h.logCommits.mockResolvedValue([
      ROUND({ message: "Reflection round — 2026-10-20", oid: "failed" }), // no trailer
      ROUND({ message: "Reflection round — 2026-10-20\n\n—\nsuperseded: true", oid: "ss" }),
      ROUND({ message: "Reflection round — 2026-10-19\n\n—\nseen: 2026-10-19-1800#t1", oid: "clean" }),
    ]);

    const coverage = await readReflectionCoverage();

    expect(coverage.degraded).toBe(false);
    expect(coverage.sha).toBe("clean");
    expect(coverage.covered).toEqual([
      { sliceId: "2026-10-19-1800", turnIds: ["t1"] },
    ]);
  });

  it("no reflection rounds in the scan → degraded (UNKNOWN — never 'all done')", async () => {
    h.logCommits.mockResolvedValue([
      { oid: "t1", message: "Turn a1b2c3 — finalize", committedAtMs: 1 },
    ]);

    const coverage = await readReflectionCoverage();

    expect(coverage.degraded).toBe(true);
    expect(coverage.covered).toEqual([]);
  });

  it("the log plane down → degraded", async () => {
    h.isGitRepo.mockReturnValue(false);
    const coverage = await readReflectionCoverage();
    expect(coverage.degraded).toBe(true);
  });

  it("空仓库 (unborn branch): a ref-resolution log error reads as 'no commits yet', NOT a generic log read failure", async () => {
    // isomorphic-git on a repo with zero commits: git.log cannot resolve HEAD.
    h.logCommits.mockRejectedValue(new Error("Could not find refs/heads/master"));
    const log = await readReflectionLog();
    expect(log.available).toBe(false);
    expect(log.reason).toContain("no commits yet");
    expect(log.reason).not.toContain("log read failed");
    // the degradation contract is unchanged: cursor null, degraded flag set
    const cursor = await readReflectionCursor();
    expect(cursor.sliceId).toBeNull();
    expect(cursor.degraded).toBe(true);
  });

  it("a REAL log read failure keeps the generic wording (distinguishable from unborn)", async () => {
    h.logCommits.mockRejectedValue(new Error("corrupt object store"));
    const log = await readReflectionLog();
    expect(log.available).toBe(false);
    expect(log.reason).toContain("log read failed");
    expect(log.reason).toContain("corrupt object store");
  });
});

describe("readLatestReflectionNote — the 暂存's log shape (待裁决 3)", () => {
  it("the newest round's note paragraph + its COMMIT timestamp", async () => {
    h.logCommits.mockResolvedValue([
      // newest round has NO note (空转不留痕) — skipped
      ROUND({ message: "Reflection round — 2026-10-19\n\n—\nseen: 2026-10-19-1721", oid: "n1" }),
      ROUND({
        message: "Reflection round — 2026-10-19\n\n写了周末安排的案件。\n\n—\nseen: 2026-10-19-1719",
        oid: "n2",
        ts: Date.parse("2026-10-19T16:30:00.000Z"),
      }),
    ]);
    const note = await readLatestReflectionNote();
    expect(note).toEqual({
      note: "写了周末安排的案件。",
      at: "2026-10-19T16:30:00.000Z",
    });
  });

  it("no notes at all → null (tolerant, never a throw)", async () => {
    h.logCommits.mockResolvedValue([
      ROUND({ message: "Reflection round — 2026-10-19\n\n—\nseen: 2026-10-19-1721" }),
    ]);
    expect(await readLatestReflectionNote()).toBeNull();
  });
});

describe("readRecentSummaries — the panel's summary read face (v0.43 §5)", () => {
  const SUMMARY = (over: { message?: string; oid?: string; ts?: number }) => ({
    oid: over.oid ?? "sum-1",
    message: over.message ?? "Summary — 2026-10-20-0831",
    committedAtMs: over.ts ?? Date.parse("2026-10-20T09:00:00.000Z"),
  });

  it("parses the body counts + the zh 没答成 entries (unknown lines skipped)", async () => {
    h.logCommits.mockResolvedValue([
      SUMMARY({
        message:
          "Summary — 2026-10-20-0900\n\n- user turn t3\n- reply t3",
        oid: "s2",
        ts: Date.parse("2026-10-20T10:00:00.000Z"),
      }),
      SUMMARY({
        message:
          "Summary — 2026-10-20-0831\n\n" +
          "- user turn t1\n- reply t1\n- merge t1\n- cognition t1\n- snapshot\n" +
          "- sealed 2026-10-19-1721 (time_cap)\n- 第 t2 条没答成（interrupted）",
        oid: "s1",
        ts: Date.parse("2026-10-20T09:05:00.000Z"),
      }),
    ]);

    const read = await readRecentSummaries();

    expect(read.available).toBe(true);
    // newest-first preserved
    expect(read.entries).toEqual([
      {
        slice: "2026-10-20-0900",
        at: "2026-10-20T10:00:00.000Z",
        userTurns: 1,
        replies: 1,
        merges: 0,
        failed: [],
      },
      {
        slice: "2026-10-20-0831",
        at: "2026-10-20T09:05:00.000Z",
        userTurns: 1,
        replies: 1,
        merges: 1,
        failed: [{ turn: "t2", status: "interrupted" }],
      },
    ]);
  });

  it("parses the en no-answer format too", async () => {
    h.logCommits.mockResolvedValue([
      SUMMARY({
        message: "Summary — 2026-10-20-0831\n\n- user turn t1\n- turn t1 produced no answer (cancelled)",
      }),
    ]);

    const read = await readRecentSummaries();

    expect(read.entries[0].failed).toEqual([{ turn: "t1", status: "cancelled" }]);
    expect(read.entries[0].userTurns).toBe(1);
    expect(read.entries[0].replies).toBe(0);
  });

  it("an empty summary history is a TRUE empty (available, []) — never a failure", async () => {
    h.logCommits.mockResolvedValue([
      { oid: "t1", message: "Turn a1b2c3 — reply", committedAtMs: 1 },
    ]);
    const read = await readRecentSummaries();
    expect(read.available).toBe(true);
    expect(read.entries).toEqual([]);
  });

  it("the log plane down degrades the whole read (no fabricated entries)", async () => {
    h.isGitRepo.mockReturnValue(false);
    const read = await readRecentSummaries();
    expect(read.available).toBe(false);
    expect(read.entries).toEqual([]);
    expect(read.reason).toContain("git init");
  });

  it("caps at five entries (a glance, not an archive)", async () => {
    h.logCommits.mockResolvedValue(
      Array.from({ length: 8 }, (_, i) =>
        SUMMARY({
          message: `Summary — 2026-10-1${i}-0831\n\n- user turn t${i}`,
          oid: `s${i}`,
          ts: Date.parse("2026-10-20T09:00:00.000Z") + i,
        }),
      ),
    );
    const read = await readRecentSummaries();
    expect(read.entries).toHaveLength(5);
  });
});

describe("readHQLogBundle — ONE scan, three derivations (v0.11 streams)", () => {
  it("scans the log ONCE and derives cursor + rounds + summaries from it (no per-round getCommit)", async () => {
    h.logCommits.mockResolvedValue([
      // newest: a summary commit
      ROUND({
        message: "Summary — 2026-10-19-1751\n\n- user turn a1\n- reply b1\n- merge c1",
        oid: "sha-sum",
      }),
      // then a clean round with the level
      ROUND({
        message:
          "Reflection round — 2026-10-19\n\n处理了周末。\n\n—\nseen: 2026-10-19-1721",
        oid: "sha-clean",
      }),
      // oldest: a failed round (no trailer)
      ROUND({ message: "Reflection round — 2026-10-19", oid: "sha-fail" }),
    ]);

    const bundle = await readHQLogBundle();

    expect(bundle.available).toBe(true);
    // THE read-amplification pin: one scan feeds every derivation.
    expect(h.logCommits).toHaveBeenCalledTimes(1);
    expect(bundle.derivation.cursor).toEqual({
      sliceId: "2026-10-19-1721",
      sha: "sha-clean",
      at: new Date(Date.parse("2026-10-19T17:00:00.000Z")).toISOString(),
    });
    expect(bundle.derivation.rounds.map((r) => r.sha)).toEqual(["sha-clean", "sha-fail"]);
    expect(bundle.derivation.rounds.every((r) => r.files.length === 0)).toBe(true);
    expect(bundle.derivation.summaries).toEqual([
      {
        slice: "2026-10-19-1751",
        at: new Date(Date.parse("2026-10-19T17:00:00.000Z")).toISOString(),
        userTurns: 1,
        replies: 1,
        merges: 1,
        failed: [],
      },
    ]);
  });

  it("degrades exactly like the sibling readers (non-git root → available false + advice)", async () => {
    h.isGitRepo.mockReturnValue(false);
    const bundle = await readHQLogBundle();
    expect(bundle.available).toBe(false);
    expect(bundle.reason).toContain("git init");
    expect(h.logCommits).not.toHaveBeenCalled();
  });
});
