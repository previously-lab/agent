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
  /** The raw commit message — the panel's parser (v0.43 §5) reads the body. */
  message: string;
}

export interface SummaryLogRead {
  /** Newest-first summary commits inside the bounded scan. */
  entries: SummaryLogEntry[];
  /** False when the log plane is unavailable (non-git local root, API down). */
  available: boolean;
  /** The degradation reason — the caller turns it into an honest docket. */
  reason?: string;
}

// ─── The panel's recentSummaries (v0.43 §5 — the summary stream's read face) ──

/** One parsed `Summary — {slice}` body, the shape the workflow panel renders. */
export interface RecentSummaryEntry {
  /** The slice the summary persisted into (the prefix's argument). */
  slice: string;
  /** Commit timestamp (ISO), null when the backend doesn't say. */
  at: string | null;
  /** `- user turn X` lines — how many user turns landed. */
  userTurns: number;
  /** `- reply X` lines — how many replies landed. */
  replies: number;
  /** `- merge X` lines — how many merge lines landed. */
  merges: number;
  /** The batch's terminal non-completed turns (`第 X 条没答成`). */
  failed: Array<{ turn: string; status: string }>;
}

const SUMMARY_LINE = /^- (.+)$/;
/** `- 第 X 条没答成（status）` — the zh no-answer note the writer stamps. */
const FAILED_ZH = /^第 (\S+) 条没答成（(.+)）$/;
/** `- turn X produced no answer (status)` — the en no-answer note. */
const FAILED_EN = /^turn (\S+) produced no answer \((.+)\)$/;

/**
 * Parse a summary commit message's body lines into the panel's counts. Pure
 * and tolerant: unknown lines (`snapshot`, `sealed …`, future markers) are
 * skipped, never fatal — the body is the writer's honest ledger (v0.42 §7-1)
 * and the reader keeps up with whatever it says.
 */
export function parseSummaryBody(message: string): Omit<RecentSummaryEntry, "slice" | "at"> {
  let userTurns = 0;
  let replies = 0;
  let merges = 0;
  const failed: RecentSummaryEntry["failed"] = [];
  for (const rawLine of message.split("\n")) {
    const m = SUMMARY_LINE.exec(rawLine.trim());
    if (!m) continue;
    const line = m[1];
    if (/^user turn \S+/.test(line)) {
      userTurns += 1;
    } else if (/^reply \S+/.test(line)) {
      replies += 1;
    } else if (/^merge \S+/.test(line)) {
      merges += 1;
    } else {
      const zh = FAILED_ZH.exec(line);
      const en = FAILED_EN.exec(line);
      const f = zh ?? en;
      if (f) failed.push({ turn: f[1], status: f[2] });
    }
  }
  return { userTurns, replies, merges, failed };
}

export interface RecentSummariesRead {
  entries: RecentSummaryEntry[];
  /** False when the log plane is unavailable (non-git local root, API down). */
  available: boolean;
  /** The degradation reason — the caller turns it into an honest docket. */
  reason?: string;
}

const MAX_RECENT_SUMMARIES = 5;

/**
 * The newest few summary commits parsed for the workflow panel (v0.43 §5) —
 * a SIBLING read of readSummaryLog (same bounded scan discipline, same
 * failure semantics), only the projection differs: counts + failed entries
 * per commit instead of the scope-source turn ids. Read-only, never writes.
 */
export async function readRecentSummaries(
  limit = MAX_RECENT_SUMMARIES,
): Promise<RecentSummariesRead> {
  const log = await readSummaryLog();
  if (!log.available) {
    return { entries: [], available: false, reason: log.reason };
  }
  return {
    entries: log.entries.slice(0, limit).map((e) => ({
      slice: e.sliceId,
      at: e.committedAt,
      ...parseSummaryBody(e.message),
    })),
    available: true,
  };
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
  return { sha, sliceId, turnIds, committedAt, message };
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
 * `seen` marks of every clean round in the bounded scan into a PER-SLICE
 * UNION (coverage only grows — newest-wins was the slice-level semantics and
 * is exactly wrong here: one round's single turn would subsume another
 * round's other turn of the same slice and the unit would re-run the slice
 * forever — observed on the real machine, slice 2026-10-20-0831 ping-
 * ponging between two turns across five round commits). A mark without
 * turnIds (the old `seen: <sliceId>` format) covers its WHOLE slice and
 * lifts `wholeUpTo`: slices at or below it with no explicit mark read as
 * whole-covered (the old water-level semantics, preserved for mixed-format
 * histories), and a whole-slice mark is never shrunk back to a turn list.
 * Nothing found / log down → `degraded` — the scope judgment then treats
 * NOTHING as covered (unknown ≠ all-done, §3.5-2).
 */
export interface ReflectionCoverage {
  /** Per-slice covered turns, UNION-merged across rounds; null = the whole slice. */
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
  /**
   * Per-slice UNION merge. The water level is TURN-level: each round covers
   * the turns it names, and coverage only ever GROWS. Newest-wins was the
   * slice-level semantics — under a turn-level level it is exactly wrong: a
   * round covering ONE turn would subsume an earlier round's OTHER turn of
   * the same slice, that turn reads as unprocessed again, and the unit
   * re-runs the slice forever. Real machine, 2026-10-20-0831: five
   * `Reflection round` commits alternating seen: …#YcuFGA / …#4HH9hQ —
   * two turns of one slice ping-ponging as each newest mark hid the other.
   * A whole-slice mark (old format, turnIds absent) covers EVERYTHING: it
   * lands as turnIds null and the slice is never shrunk back to a list
   * afterwards.
   */
  const bySlice = new Map<string, string[] | null>();
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
        // for everything at or below it. Whole coverage is not shrinkable.
        if (wholeUpTo === null || mark.sliceId > wholeUpTo) wholeUpTo = mark.sliceId;
        bySlice.set(mark.sliceId, null);
        continue;
      }
      const current = bySlice.get(mark.sliceId);
      if (current === null) continue; // whole-slice mark already covers it
      if (current === undefined) {
        bySlice.set(mark.sliceId, [...mark.turnIds]);
      } else {
        for (const t of mark.turnIds) if (!current.includes(t)) current.push(t);
      }
    }
  }
  const covered: ReflectionCoverage["covered"] = [...bySlice.entries()].map(
    ([sliceId, turnIds]) => ({ sliceId, turnIds }),
  );
  if (covered.length === 0) {
    return { covered, wholeUpTo, sha: null, at: null, degraded: true };
  }
  return { covered, wholeUpTo, sha, at, degraded: false };
}

// ─── The event-driven bundle (v0.11 streams — one scan, three derivations) ──

/**
 * The panel's log layer was the GitHub-quota fire: every hq-status poll ran
 * THREE sibling scans of the same commit history (readReflectionCursor →
 * readReflectionLog, readReflectionLog again for the rounds, readRecent
 * Summaries → readSummaryLog) plus a getCommit per round for file lists the
 * panel never renders. The bundle below is the single-scan replacement the
 * event-driven endpoints use: ONE bounded scan, cursor/rounds/summaries all
 * derived from it, NO getCommit (the recent-writes glance degrades to []).
 */

/** One commit from the single bounded scan — identity + message + time. */
export interface HQLogScanCommit {
  sha: string;
  message: string;
  committedAt: string | null;
}

export interface HQLogScan {
  /** Newest-first commits inside the bounded scan. */
  commits: HQLogScanCommit[];
  /** False when the log plane is unavailable (non-git local root, API down). */
  available: boolean;
  /** The degradation reason (the `git init` advice rides here). */
  reason?: string;
}

/** ONE bounded scan of the memory commit history on the active backend. */
export async function readHQLogScan(): Promise<HQLogScan> {
  const source = resolveDataSource();
  try {
    if (source === "github") {
      const { owner, repo } = getRepoConfig();
      const octokit = getOctokit();
      const commits: HQLogScanCommit[] = [];
      for (let page = 1; page <= MAX_PAGES; page += 1) {
        const { data } = await octokit.rest.repos.listCommits({
          owner,
          repo,
          path: "memory",
          per_page: GITHUB_PAGE,
          page,
        });
        commits.push(
          ...data.map((c) => ({
            sha: c.sha,
            message: c.commit?.message ?? "",
            committedAt: c.commit?.committer?.date ?? null,
          })),
        );
        if (data.length < GITHUB_PAGE) break; // history exhausted
      }
      return { commits, available: true };
    }
    if (source === "local") {
      const root = getMemoryRoot();
      if (!isGitRepo(root)) {
        return {
          commits: [],
          available: false,
          reason:
            "the memory root is not a git repository — there is no commit history to read; run `git init` in the memory root to enable it",
        };
      }
      const commits = await logCommits(root, LOCAL_SCAN_CAP);
      return {
        commits: commits.map((c) => ({
          sha: c.oid,
          message: c.message,
          committedAt:
            c.committedAtMs !== null ? new Date(c.committedAtMs).toISOString() : null,
        })),
        available: true,
      };
    }
    return { commits: [], available: false, reason: "demo mode has no commit log" };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (/Could not find refs\/heads|Could not find HEAD/i.test(message)) {
      return {
        commits: [],
        available: false,
        reason:
          "the memory repository has no commits yet (unborn branch) — there is no cursor to read; the reflection range starts from the beginning (fresh-deployment semantics, nothing skipped)",
      };
    }
    return { commits: [], available: false, reason: `log read failed: ${message}` };
  }
}

/** Everything the panel's log layer renders, derived from ONE scan. */
export interface HQLogDerivation {
  /** The slice-level water level (newest clean round's furthest seen mark). */
  cursor: { sliceId: string | null; sha: string | null; at: string | null };
  /** Newest-first reflection rounds (a glance, capped) — files: [] (omitted). */
  rounds: ReflectionRoundLogEntry[];
  /** Newest-first parsed summary bodies (a glance, capped). */
  summaries: RecentSummaryEntry[];
}

/** Pure: shape ONE scan into cursor + rounds + summaries (no I/O at all). */
export function deriveHQLog(scan: HQLogScan): HQLogDerivation {
  const rounds: ReflectionRoundLogEntry[] = [];
  const summaries: RecentSummaryEntry[] = [];
  const cursor: HQLogDerivation["cursor"] = {
    sliceId: null,
    sha: null,
    at: null,
  };
  for (const c of scan.commits) {
    if (summaries.length < MAX_RECENT_SUMMARIES && c.message.startsWith(SUMMARY_COMMIT_PREFIX)) {
      summaries.push({
        slice:
          c.message.slice(SUMMARY_COMMIT_PREFIX.length).split("\n", 1)[0]?.trim() ?? "",
        at: c.committedAt,
        ...parseSummaryBody(c.message),
      });
    }
    const parsed = parseReflectionRoundMessage(c.message);
    if (parsed && rounds.length < MAX_ROUNDS) {
      rounds.push({ sha: c.sha, committedAt: c.committedAt, parsed, files: [] });
    }
    // The cursor is the FIRST (newest) clean round's furthest seen mark —
    // same semantics as readReflectionCursor, read off the same scan.
    if (cursor.sliceId === null && parsed) {
      const furthest = parsed.trailer?.seen?.at(-1)?.sliceId;
      if (furthest) {
        cursor.sliceId = furthest;
        cursor.sha = c.sha;
        cursor.at = c.committedAt;
      }
    }
  }
  return { cursor, rounds, summaries };
}

/** The one-call log read for the event-driven endpoints: scan once, derive. */
export async function readHQLogBundle(): Promise<{
  derivation: HQLogDerivation;
  available: boolean;
  reason?: string;
}> {
  const scan = await readHQLogScan();
  if (!scan.available) {
    return { derivation: deriveHQLog(scan), available: false, reason: scan.reason };
  }
  return { derivation: deriveHQLog(scan), available: true };
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
