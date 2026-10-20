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

/**
 * The summary stream's commit prefix (v0.42 §4) — the reader side's copy.
 * The writer registers the same shape in commit-contract
 * (COMMIT_PREFIX.summary); this module is the reader of record and keeps
 * its own constant, exactly as REFLECTION_ROUND_PREFIX does.
 */
const SUMMARY_COMMIT_PREFIX = "Summary — ";

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
    // An unborn branch (the repo EXISTS but holds no commits yet) fails the
    // log read with a ref-resolution error ("Could not find refs/heads/…") —
    // say THAT ("no commits yet"), not a generic "read failed".
    const message = e instanceof Error ? e.message : String(e);
    if (/Could not find refs\/heads|Could not find HEAD/i.test(message)) {
      return {
        entries: [],
        available: false,
        reason:
          "the memory repository has no commits yet (unborn branch) — there is no cursor to read; the reflection range starts from the beginning (fresh-deployment semantics, nothing skipped)",
      };
    }
    return {
      entries: [],
      available: false,
      reason: `log read failed: ${message}`,
    };
  }
}

// ─── The summary stream's log (v0.42 §3.5 — the rangeless unit's scope source) ──

/** One `Summary — {sliceId}` commit, newest-first order preserved. */
export interface SummaryLogEntry {
  sha: string;
  /** The slice the summary persisted into (the prefix's argument). */
  sliceId: string;
  /** The member turn ids its body names (`- user turn X` / `- reply X`). */
  turnIds: string[];
  /** Commit timestamp (ISO), null when the backend doesn't say. */
  committedAt: string | null;
}

export interface SummaryLogRead {
  /** Newest-first summary commits inside the bounded scan. */
  entries: SummaryLogEntry[];
  /** False when the log plane is unavailable (non-git local root, API down). */
  available: boolean;
  /** The degradation reason — the caller turns it into an honest docket. */
  reason?: string;
}

/** Parse one summary commit message into its slice + member turn ids. */
function parseSummaryCommit(
  sha: string,
  message: string,
  committedAt: string | null,
): SummaryLogEntry {
  const sliceId =
    message.slice(SUMMARY_COMMIT_PREFIX.length).split("\n", 1)[0]?.trim() ?? "";
  const turnIds: string[] = [];
  for (const line of message.split("\n")) {
    const m = /^- (?:user turn|reply) (\S+)/.exec(line.trim());
    if (m && !turnIds.includes(m[1])) turnIds.push(m[1]);
  }
  return { sha, sliceId, turnIds, committedAt };
}

/**
 * Read the bounded summary log on the active backend — the SAME scan
 * discipline as readReflectionLog (three 100-entry pages on GitHub, one
 * capped local read), filtered to the summary stream's prefix. Deliberately
 * a sibling of (not a refactor of) the reflection reader: the failure
 * semantics differ (no file fetches, no round shaping) and the reflection
 * reader's behavior is pinned by its own tests.
 */
export async function readSummaryLog(): Promise<SummaryLogRead> {
  const source = resolveDataSource();
  try {
    if (source === "github") {
      const { owner, repo } = getRepoConfig();
      const octokit = getOctokit();
      const entries: SummaryLogEntry[] = [];
      for (let page = 1; page <= MAX_PAGES; page += 1) {
        const { data } = await octokit.rest.repos.listCommits({
          owner,
          repo,
          path: "memory",
          per_page: GITHUB_PAGE,
          page,
        });
        for (const c of data) {
          const message = c.commit?.message ?? "";
          if (!message.startsWith(SUMMARY_COMMIT_PREFIX)) continue;
          entries.push(
            parseSummaryCommit(
              c.sha,
              message,
              c.commit?.committer?.date ?? null,
            ),
          );
        }
        if (data.length < GITHUB_PAGE) break; // history exhausted
      }
      return { entries, available: true };
    }
    if (source === "local") {
      const root = getMemoryRoot();
      if (!isGitRepo(root)) {
        return {
          entries: [],
          available: false,
          reason:
            "the memory root is not a git repository — there is no commit history to read the summary log from; run `git init` in the memory root to enable it",
        };
      }
      const commits = await logCommits(root, LOCAL_SCAN_CAP);
      return {
        entries: commits
          .filter((c) => c.message.startsWith(SUMMARY_COMMIT_PREFIX))
          .map((c) =>
            parseSummaryCommit(
              c.oid,
              c.message,
              c.committedAtMs !== null
                ? new Date(c.committedAtMs).toISOString()
                : null,
            ),
          ),
        available: true,
      };
    }
    return { entries: [], available: false, reason: "demo mode has no commit log" };
  } catch (e) {
    return {
      entries: [],
      available: false,
      reason: `summary log read failed: ${e instanceof Error ? e.message : String(e)}`,
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
    // v0.42 — turn-level marks (one per scoped slice, scope order): the
    // FURTHEST slice id is still the slice-level display cursor.
    const furthest = seen?.at(-1)?.sliceId;
    if (furthest) {
      return {
        sliceId: furthest,
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
 * The TURN-level water level (v0.42 §4 — the work unit is a turn): merge the
 * `seen` marks of every clean round in the bounded scan, NEWEST-first and
 * first-wins per slice (a newer round's mark for a slice subsumes the older
 * ones — the water only rises). A mark without turnIds (the old
 * `seen: <sliceId>` format) covers its WHOLE slice and lifts `wholeUpTo`:
 * slices at or below it with no explicit mark read as whole-covered (the
 * old water-level semantics, preserved for mixed-format histories).
 * Nothing found / log down → `degraded` — the scope judgment then treats
 * NOTHING as covered (unknown ≠ all-done, §3.5-2).
 */
export interface ReflectionCoverage {
  /** Per-slice covered turns, newest-wins deduped; null = the whole slice. */
  covered: Array<{ sliceId: string; turnIds: string[] | null }>;
  /** The newest old-format whole-slice mark's slice id (null = none). */
  wholeUpTo: string | null;
  sha: string | null;
  at: string | null;
  degraded: boolean;
}

export async function readReflectionCoverage(): Promise<ReflectionCoverage> {
  const log = await readReflectionLog();
  if (!log.available) {
    return { covered: [], wholeUpTo: null, sha: null, at: null, degraded: true };
  }
  const seenSlices = new Set<string>();
  const covered: ReflectionCoverage["covered"] = [];
  let wholeUpTo: string | null = null;
  let sha: string | null = null;
  let at: string | null = null;
  for (const entry of log.entries) {
    const marks = entry.parsed.trailer?.seen;
    if (!marks?.length) continue;
    if (sha === null) {
      sha = entry.sha;
      at = entry.committedAt;
    }
    for (const mark of marks) {
      if (mark.turnIds === undefined) {
        // Old format: the whole slice is covered — and it is a water level
        // for everything at or below it.
        if (wholeUpTo === null || mark.sliceId > wholeUpTo) wholeUpTo = mark.sliceId;
      }
      if (seenSlices.has(mark.sliceId)) continue; // newest wins
      seenSlices.add(mark.sliceId);
      covered.push({ sliceId: mark.sliceId, turnIds: mark.turnIds ?? null });
    }
  }
  if (covered.length === 0) {
    return { covered, wholeUpTo, sha: null, at: null, degraded: true };
  }
  return { covered, wholeUpTo, sha, at, degraded: false };
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
