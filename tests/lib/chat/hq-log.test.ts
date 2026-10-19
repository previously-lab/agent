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
  readReflectionLog,
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
