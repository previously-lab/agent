import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  source: "local",
  commits: [] as Array<{ sha: string; message: string; parents?: string[] }>,
  list: vi.fn(),
  details: vi.fn(),
  localLog: vi.fn(),
  cache: new Map<string, unknown>(),
}));
vi.mock("@/lib/data-source/resolve", () => ({ resolveDataSource: () => h.source }));
vi.mock("@/lib/capabilities", () => ({ getRepoConfig: () => ({ owner: "fixture", repo: "memory" }) }));
vi.mock("@/lib/whitelist", () => ({ getMemoryRoot: () => "/fixture" }));
vi.mock("@/lib/episodic/local-git", () => ({
  isGitRepo: () => true,
  logCommits: (...args: unknown[]) => h.localLog(...args),
}));
vi.mock("@/lib/github/client", () => ({
  getOctokit: () => ({ rest: {
    repos: { listCommits: h.list, getCommit: h.details, get: async () => ({ data: { default_branch: "main" } }) },
    git: { getRef: async () => ({ data: { object: { sha: h.commits[0]?.sha ?? "head" } } }) },
  } }),
}));
vi.mock("@/lib/cache/data-cache", async (original) => ({
  ...(await original<typeof import("@/lib/cache/data-cache")>()),
  cachedFetch: async (identity: string[], _ttl: number, _tags: string[], fn: () => Promise<unknown>) => {
    const key = JSON.stringify(identity);
    if (!h.cache.has(key)) h.cache.set(key, await fn());
    return h.cache.get(key);
  },
}));
import { deriveHQLog, readReflectionCoverage, readReflectionCursor, readReflectionLog, readSummaryLog } from "@/lib/chat/hq-log";
import { buildReflectionRoundMessage } from "@/lib/chat/commit-contract";

const round = (i: number) => ({ sha: `round-${i}`, message: `Reflection round — 2026-10-22\n\n—\nseen: 2026-10-22-0900#t${i}` });
const summary = (i: number) => ({ sha: `summary-${i}`, message: `Summary — 2026-10-22-0900\n\n- user turn t${i}\n- reply t${i}` });

beforeEach(() => {
  vi.clearAllMocks();
  h.cache.clear();
  h.source = "local";
  h.commits = [];
  h.localLog.mockImplementation(async (_root: string, max: number) => h.commits.slice(0, max).map(c => ({
    oid: c.sha, message: c.message, committedAtMs: 0, parents: c.parents,
  })));
  h.list.mockImplementation(async ({ page, per_page, path }: { page: number; per_page: number; path?: string }) => {
    const commits = path ? h.commits.filter(c => !c.sha.startsWith("round-")) : h.commits;
    return { data: commits.slice((page - 1) * per_page, page * per_page).map(c => ({
      sha: c.sha, commit: { message: c.message, committer: { date: "2026-10-22T00:00:00Z" } },
      parents: (c.parents ?? []).map(sha => ({ sha })),
    })) };
  });
  h.details.mockResolvedValue({ data: { files: [] } });
});

describe("reflection history completeness", () => {
  it("an agenda-only checkpoint preserves the cursor even without a fresh seen line", async () => {
    h.commits = [{ sha: "checkpoint", message: buildReflectionRoundMessage({ date: "2026-10-22", trailer: {
      observed: [], history: { version: 1, basis: "a".repeat(40), cursor: "2026-10-22-0900", evolved: null, pending: [] },
    } }) }];
    expect((await readReflectionCursor()).sliceId).toBe("2026-10-22-0900");
    expect(deriveHQLog({ available: true, commits: h.commits.map(c => ({ ...c, committedAt: null })) }).cursor.sliceId).toBe("2026-10-22-0900");
  });

  it("keeps the ninth round's coverage after the panel's eight-row limit", async () => {
    h.commits = Array.from({ length: 9 }, (_, i) => round(9 - i));
    const coverage = await readReflectionCoverage();
    expect(coverage.covered[0].turnIds).toHaveLength(9);
    expect(coverage.covered[0].turnIds).toContain("t1");
  });

  it("does not hide an empty round behind the memory path filter", async () => {
    h.source = "github";
    h.commits = [round(1), summary(1)];
    const coverage = await readReflectionCoverage();
    expect(coverage.covered).toEqual([{ sliceId: "2026-10-22-0900", turnIds: ["t1"] }]);
    expect(h.list.mock.calls.every(([args]) => args.path === undefined)).toBe(true);
  });

  it("finds a summary older than 300 unrelated commits", async () => {
    h.source = "github";
    h.commits = [...Array.from({ length: 300 }, (_, i) => ({ sha: `code-${i}`, message: "chore: update code" })), summary(1)];
    const log = await readSummaryLog();
    expect(log.available).toBe(true);
    expect(log.entries.map(e => e.sha)).toContain("summary-1");
  });

  it("cursor, coverage and the log do not load unused commit file lists", async () => {
    h.source = "github";
    h.commits = Array.from({ length: 8 }, (_, i) => round(8 - i));
    h.list.mockImplementation(async () => ({ data: h.commits.map(c => ({
      sha: c.sha, commit: { message: c.message, committer: { date: "2026-10-22T00:00:00Z" } },
    })) }));
    await readReflectionCursor();
    await readReflectionCoverage();
    await readReflectionLog();
    expect(h.details).not.toHaveBeenCalled();
  });
});
