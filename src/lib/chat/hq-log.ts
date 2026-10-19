/**
 * The reflection log reader (v0.39 §2.4/§2.5) — the cursor/note/recentWrites
 * plane. The water level is NOT a pointer file: it is the newest clean
 * reflection round's `seen:` trailer, riding that round's own commit. This
 * module reads the commit history on both backends, filters by the prefix
 * contract, and parses trailers.
 *
 * Failure semantics (§2.5): a bounded scan (three 100-entry pages on
 * GitHub; a capped local log read) that finds no reflection commit yields
 * cursor null (全量重读, fresh-deployment semantics) WITH a warn — never a
 * silent skip. A local non-git memory root yields `available: false` with
 * the `git init` advice (待裁决 2 — fail-safe, the caller degrades to an
 * empty docket, not a busy loop).
 *
 * Plain Node module — the route, the turn pipeline (暂存) and
 * reflection-steps (the world read's cursor leg) all read through here.
 */
import { getOctokit } from "@/lib/github/client";
import { getRepoConfig } from "@/lib/capabilities";
import { resolveDataSource } from "@/lib/data-source/resolve";
import { getMemoryRoot } from "@/lib/whitelist";
import { isGitRepo, logCommits } from "@/lib/episodic/local-git";
import {
  parseReflectionRoundMessage,
  type ParsedReflectionRound,
} from "./commit-contract";

/** One reflection round commit, newest-first order preserved by the reader. */
export interface ReflectionRoundLogEntry {
  /** The commit's own identity (the log line carries it — never stored). */
  sha: string;
  /** Commit timestamp (ISO), null when the backend doesn't say. */
  committedAt: string | null;
  /** The parsed contract (date/note/trailer). */
  parsed: ParsedReflectionRound;
  /** Memory-relative paths the commit touched ("" stripped); [] when unread. */
  files: string[];
}

export interface ReflectionLogRead {
  /** Newest-first reflection round commits (bounded). */
  entries: ReflectionRoundLogEntry[];
  /** False when the log plane is unavailable (non-git local root, API down). */
  available: boolean;
  /** The degradation reason (the `git init` advice rides here). */
  reason?: string;
}

/** GitHub page size and the bounded scan depth (§2.5 的"三页封顶"). */
const GITHUB_PAGE = 100;
const MAX_PAGES = 3;
/** How many reflection rounds the readers keep at most (a glance). */
const MAX_ROUNDS = 8;
/** Local single-read scan cap (the local log is one call — bound it anyway). */
const LOCAL_SCAN_CAP = MAX_PAGES * GITHUB_PAGE;

async function readGitHubLog(): Promise<ReflectionLogRead> {
  const { owner, repo } = getRepoConfig();
  const octokit = getOctokit();
  const collected: Array<{
    sha: string;
    message: string;
    committedAt: string | null;
  }> = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const { data } = await octokit.rest.repos.listCommits({
      owner,
      repo,
      path: "memory",
      per_page: GITHUB_PAGE,
      page,
    });
    collected.push(
      ...data.map((c) => ({
        sha: c.sha,
        message: c.commit?.message ?? "",
        committedAt: c.commit?.committer?.date ?? null,
      })),
    );
    if (data.length < GITHUB_PAGE) break; // history exhausted
  }
  return shapeEntries(
    collected,
    async (sha) => {
      const { data } = await octokit.rest.repos.getCommit({ owner, repo, ref: sha });
      return (data.files ?? [])
        .map((f) => f.filename ?? "")
        .filter((f) => f.startsWith("memory/"))
        .map((f) => f.slice("memory/".length));
    },
  );
}

async function readLocalLog(): Promise<ReflectionLogRead> {
  const root = getMemoryRoot();
  if (!isGitRepo(root)) {
    return {
      entries: [],
      available: false,
      reason:
        "the memory root is not a git repository — there is no commit history to read the cursor from; run `git init` in the memory root to enable it",
    };
  }
  const commits = await logCommits(root, LOCAL_SCAN_CAP);
  return shapeEntries(
    commits.map((c) => ({
      sha: c.oid,
      message: c.message,
      committedAt:
        c.committedAtMs !== null ? new Date(c.committedAtMs).toISOString() : null,
    })),
    // The local ledger does not track per-commit file lists cheaply; the
    // recent-writes glance degrades to [] (the run's `wrote` frames are the
    // hot path anyway — v0.39 §1 recentWrites 行).
    async () => [],
  );
}

/** Shared filter + parse + file fetch (files only for the newest few). */
async function shapeEntries(
  commits: Array<{ sha: string; message: string; committedAt: string | null }>,
  fetchFiles: (sha: string) => Promise<string[]>,
): Promise<ReflectionLogRead> {
  const rounds: ReflectionRoundLogEntry[] = [];
  for (const c of commits) {
    const parsed = parseReflectionRoundMessage(c.message);
    if (!parsed) continue;
    rounds.push({
      sha: c.sha,
      committedAt: c.committedAt,
      parsed,
      files: [],
    });
    if (rounds.length >= MAX_ROUNDS) break;
  }
  // File lists are the expensive leg — fetch only for the newest few.
  await Promise.all(
    rounds.slice(0, MAX_ROUNDS).map(async (r) => {
      try {
        r.files = await fetchFiles(r.sha);
      } catch {
        r.files = []; // the glance degrades, the cursor does not depend on it
      }
    }),
  );
  return { entries: rounds, available: true };
}

/** Read the bounded reflection log on the active backend. */
export async function readReflectionLog(): Promise<ReflectionLogRead> {
  const source = resolveDataSource();
  try {
    if (source === "github") return await readGitHubLog();
    if (source === "local") return await readLocalLog();
    return { entries: [], available: false, reason: "demo mode has no commit log" };
  } catch (e) {
    return {
      entries: [],
      available: false,
      reason: `log read failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/**
 * The water level (§2.1): the NEWEST clean round's `seen` trailer — scan
 * newest-first, skip trailer-less (failed) and superseded rounds. Nothing
 * found (or the log plane down) → sliceId null (fresh-deployment semantics:
 * 全量重读, 宁重读不跳过) with a warn — the run attribute `cursorFallback`
 * carries the留痕 for the panel (§2.5 的"必须 warn 留痕").
 */
export async function readReflectionCursor(): Promise<{
  sliceId: string | null;
  sha: string | null;
  at: string | null;
  degraded: boolean;
}> {
  const log = await readReflectionLog();
  if (!log.available) {
    console.warn(`[reflection] cursor fallback — ${log.reason}`);
    return { sliceId: null, sha: null, at: null, degraded: true };
  }
  for (const entry of log.entries) {
    const seen = entry.parsed.trailer?.seen;
    if (seen?.sliceId) {
      return {
        sliceId: seen.sliceId,
        sha: entry.sha,
        at: entry.committedAt,
        degraded: false,
      };
    }
  }
  console.warn(
    "[reflection] cursor fallback — no reflection round commit in the bounded scan; the cursor resets to the beginning (full re-read, nothing is skipped silently)",
  );
  return { sliceId: null, sha: null, at: null, degraded: true };
}

/**
 * The 暂存 (§1 lastNote 的去向): the newest reflection round commit that
 * carries a note — {note, at: commit time}. The turn pipeline's exactly-once
 * discipline (buildReflectionNoteSection's newer-than-previous-user-turn
 * check) compares `at`, so the commit timestamp IS the carry stamp.
 */
export async function readLatestReflectionNote(): Promise<{
  note: string;
  at: string;
} | null> {
  const log = await readReflectionLog();
  if (!log.available) return null;
  for (const entry of log.entries) {
    if (entry.parsed.note && entry.committedAt) {
      return { note: entry.parsed.note, at: entry.committedAt };
    }
    if (entry.parsed.note) {
      return { note: entry.parsed.note, at: entry.sha };
    }
  }
  return null;
}
