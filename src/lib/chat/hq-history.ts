/** Node-side history reads. Continuations cross durable steps, never model calls. */
import { getOctokit } from "@/lib/github/client";
import { getRepoConfig } from "@/lib/capabilities";
import { getGitHubReadHead } from "@/lib/github/read-view";
import { cachedFetch, CACHE_TTLS } from "@/lib/cache/data-cache";
import { resolveDataSource } from "@/lib/data-source/resolve";
import { getMemoryRoot } from "@/lib/whitelist";
import { isGitRepo, logCommits } from "@/lib/episodic/local-git";
import { parseReflectionRoundMessage, type ReflectionHistoryCheckpoint } from "./commit-contract";
import { projectReflectionHistory, type HistoryCommit } from "./reflection-history";

const PAGE_SIZE = 100;
const PAGES_PER_STEP = 3;

export interface HistoryScanState {
  headSha: string;
  page: number;
  mode: "list" | "compare";
  checkpoint?: ReflectionHistoryCheckpoint;
  /** Unrelated commit bodies are discarded; parent edges preserve ancestry. */
  commits: HistoryCommit[];
  ignoreCheckpoints?: boolean;
}

export type ReflectionHistoryRead =
  | { available: true; complete: false; continuation: HistoryScanState }
  | { available: true; complete: true; history: ReflectionHistoryCheckpoint }
  | { available: false; complete: false; reason: string };

function compact(commit: HistoryCommit): HistoryCommit {
  return { ...commit, message: /^(?:Summary — |Reflection round — )/.test(commit.message) ? commit.message : "" };
}

function shape(c: { sha: string; commit?: { message?: string; committer?: { date?: string } | null }; parents?: { sha: string }[] }): HistoryCommit {
  return { sha: c.sha, message: c.commit?.message ?? "", committedAt: c.commit?.committer?.date ?? null, parents: (c.parents ?? []).map(p => p.sha) };
}

export async function readGitHubHistoryPage(owner: string, repo: string, headSha: string, page: number): Promise<HistoryCommit[]> {
  return cachedFetch(["github", "commit-page", owner, repo, headSha, String(page)], CACHE_TTLS.BLOB_SECONDS, [], async () => {
    const response = await getOctokit().rest.repos.listCommits({ owner, repo, sha: headSha, per_page: PAGE_SIZE, page });
    return response.data.map(shape);
  });
}

/**
 * GitHub compare is Reach(HEAD) minus Ancestors(basis), across every merge
 * parent. Stopping a date-ordered list at a SHA would miss old side branches.
 */
async function readComparison(owner: string, repo: string, state: HistoryScanState) {
  const basis = state.checkpoint!.basis;
  return cachedFetch(["github", "history-delta", owner, repo, basis, state.headSha, String(state.page)], CACHE_TTLS.BLOB_SECONDS, [], async () => {
    const { data } = await getOctokit().rest.repos.compareCommitsWithBasehead({
      owner, repo, basehead: `${basis}...${state.headSha}`, per_page: PAGE_SIZE, page: state.page,
    });
    return {
      ancestor: data.merge_base_commit.sha === basis && (data.status === "ahead" || data.status === "identical"),
      total: data.total_commits,
      commits: data.commits.map(shape),
    };
  });
}

export async function readReflectionHistoryChunk(continuation?: HistoryScanState): Promise<ReflectionHistoryRead> {
  try {
    const source = resolveDataSource();
    if (source === "local") {
      const root = getMemoryRoot();
      if (!isGitRepo(root)) return { available: false, complete: false, reason: "the memory root is not a git repository; run `git init` to enable history" };
      const entries = await logCommits(root, Number.MAX_SAFE_INTEGER);
      if (!entries.length) return { available: false, complete: false, reason: "the memory repository has no commits yet" };
      const commits = entries.map(c => ({ sha: c.oid, message: c.message, parents: c.parents, committedAt: c.committedAtMs === null ? null : new Date(c.committedAtMs).toISOString() }));
      // Local history has no API quota and stays a single consistent git.log.
      return { available: true, complete: true, history: projectReflectionHistory(commits, entries[0].oid) };
    }
    if (source !== "github") return { available: false, complete: false, reason: "demo mode has no commit log" };
    const { owner, repo } = getRepoConfig();
    let state: HistoryScanState = continuation
      ? { ...continuation, commits: [...continuation.commits] }
      : { headSha: (await getGitHubReadHead(repo, owner)).headSha, page: 1, mode: "list", commits: [] };
    for (let budget = 0; budget < PAGES_PER_STEP; budget += 1) {
      if (state.mode === "compare") {
        let delta;
        try { delta = await readComparison(owner, repo, state); }
        catch (error) {
          // A rewritten/deleted basis is not an empty delta. Rebuild safely.
          const status = (error as { status?: number }).status;
          if (status !== 404 && status !== 409) throw error;
        }
        if (!delta?.ancestor) {
          state = { headSha: state.headSha, page: 1, mode: "list", commits: [], ignoreCheckpoints: true };
          continue;
        }
        state.commits.push(...delta.commits.map(compact));
        if (state.page * PAGE_SIZE >= delta.total || delta.commits.length < PAGE_SIZE) {
          return { available: true, complete: true, history: projectReflectionHistory(state.commits.reverse(), state.headSha, state.checkpoint) };
        }
        state.page += 1;
        continue;
      }
      const page = await readGitHubHistoryPage(owner, repo, state.headSha, state.page);
      if (!state.ignoreCheckpoints) {
        const checkpoint = page.map(c => parseReflectionRoundMessage(c.message)?.trailer)
          .find(t => t?.history && !t.superseded)?.history;
        if (checkpoint) {
          state = { headSha: state.headSha, page: 1, mode: "compare", commits: [], checkpoint };
          continue;
        }
      }
      state.commits.push(...page.map(compact));
      if (page.length < PAGE_SIZE) return { available: true, complete: true, history: projectReflectionHistory(state.commits, state.headSha) };
      state.page += 1;
    }
    return { available: true, complete: false, continuation: state };
  } catch (error) {
    return { available: false, complete: false, reason: `history read failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}
