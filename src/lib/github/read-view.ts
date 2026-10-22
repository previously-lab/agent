/**
 * A GitHub read phase has one head per repository. Next can inline several
 * workflow steps into one HTTP request; successful writes explicitly replace
 * that head and clear the phase's derived values. Nothing here survives the
 * request/explicit scope. The Data Cache owns cross-request persistence.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { workAsyncStorage } from "next/dist/server/app-render/work-async-storage.external";
import { cachedFetch, CACHE_TTLS, invalidate, treeCacheTag } from "@/lib/cache/data-cache";
import { getOctokit } from "./client";

export interface GitHubReadHead {
  headSha: string;
  /** Known after our own writer returns; avoids a branch lookup. */
  treeSha?: string;
}

interface ReadPhase {
  fresh: boolean;
  parent?: ReadPhase;
  heads: Map<string, Promise<GitHubReadHead>>;
  values: Map<string, Promise<unknown>>;
}

const phaseStorage = new AsyncLocalStorage<ReadPhase>();
const requestPhases = new WeakMap<object, ReadPhase>();
const defaultBranches = new Map<string, Promise<string>>();
const headInflight = new Map<string, Promise<GitHubReadHead>>();

function newPhase(fresh = false, parent?: ReadPhase): ReadPhase {
  return { fresh, parent, heads: new Map(), values: new Map() };
}

function requestPhase(): ReadPhase | undefined {
  // Ad-hoc scripts and unit tests have no Next request. Never turn that
  // absence into a process-global snapshot shared by unrelated invocations.
  let store: object | undefined;
  try {
    store = workAsyncStorage.getStore();
  } catch {
    return undefined;
  }
  if (!store) return undefined;
  let phase = requestPhases.get(store);
  if (!phase) {
    phase = newPhase();
    requestPhases.set(store, phase);
  }
  return phase;
}

function currentPhase(): ReadPhase | undefined {
  return phaseStorage.getStore() ?? requestPhase();
}

function activePhases(): Set<ReadPhase> {
  const phases = new Set<ReadPhase>();
  for (let phase = currentPhase(); phase; phase = phase.parent) phases.add(phase);
  const request = requestPhase();
  if (request) phases.add(request);
  return phases;
}

export function withGitHubReadView<T>(
  fn: () => Promise<T>,
  options?: { fresh?: boolean },
): Promise<T> {
  return phaseStorage.run(newPhase(options?.fresh, currentPhase()), fn);
}

export function hasGitHubReadView(): boolean {
  return currentPhase() !== undefined;
}

/**
 * Resume an immutable durable-read basis in THIS phase only. This does not
 * publish a write, invalidate any tag, or alter a parent/request phase.
 */
export function seedGitHubReadHead(repo: string, owner: string, head: GitHubReadHead): void {
  const phase = currentPhase();
  if (!phase) throw new Error("A GitHub read view is required to seed a history basis");
  phase.heads.set(`${owner}/${repo}`, Promise.resolve(head));
  for (const key of phase.values.keys()) {
    if (key.startsWith(`${owner}/${repo}:`)) phase.values.delete(key);
  }
}

export function githubHeadCacheTag(owner: string, repo: string): string {
  return `head:${owner}/${repo}`;
}

export function getGitHubDefaultBranch(owner: string, repo: string): Promise<string> {
  const key = `${owner}/${repo}`;
  let pending = defaultBranches.get(key);
  if (!pending) {
    pending = getOctokit().rest.repos.get({ owner, repo })
      .then(({ data }) => data.default_branch || "main");
    defaultBranches.set(key, pending);
    pending.catch(() => {
      if (defaultBranches.get(key) === pending) defaultBranches.delete(key);
    });
  }
  return pending;
}

/** Test/reset seam, also useful after switching the configured repository. */
export function resetGitHubDefaultBranches(): void {
  defaultBranches.clear();
}

async function fetchHead(repo: string, owner: string): Promise<GitHubReadHead> {
  const branch = await getGitHubDefaultBranch(owner, repo);
  const { data } = await getOctokit().rest.git.getRef({
    owner, repo, ref: `heads/${branch}`,
  });
  return { headSha: data.object.sha };
}

/**
 * Normal reads share a fixed phase head. `fresh` is the existing escape:
 * bypass both the phase and persistent pointer cache without writing back.
 * An explicitly fresh phase resolves one live head and then freezes it.
 */
export function getGitHubReadHead(
  repo: string,
  owner: string,
  options?: { fresh?: boolean },
): Promise<GitHubReadHead> {
  if (options?.fresh) return fetchHead(repo, owner);
  const phase = currentPhase();
  const key = `${owner}/${repo}`;
  const existing = phase?.heads.get(key);
  if (existing) return existing;
  const flightKey = `${key}:${phase?.fresh ? "fresh" : "cached"}`;
  let pending = headInflight.get(flightKey);
  if (!pending) {
    pending = cachedFetch(
      ["github", "head", owner, repo],
      CACHE_TTLS.TREE_SECONDS,
      [githubHeadCacheTag(owner, repo)],
      () => fetchHead(repo, owner),
      { fresh: phase?.fresh },
    );
    headInflight.set(flightKey, pending);
    const done = () => {
      if (headInflight.get(flightKey) === pending) headInflight.delete(flightKey);
    };
    pending.then(done, done);
  }
  phase?.heads.set(key, pending);
  pending.catch(() => {
    if (phase?.heads.get(key) === pending) phase.heads.delete(key);
  });
  return pending;
}

/** Memoize a derived value only for this read phase, never by process TTL. */
export function memoizeGitHubRead<T>(
  repo: string,
  owner: string,
  kind: string,
  fn: () => Promise<T>,
): Promise<T> {
  const phase = currentPhase();
  if (!phase) return fn();
  const key = `${owner}/${repo}:${kind}`;
  const existing = phase.values.get(key) as Promise<T> | undefined;
  if (existing) return existing;
  const pending = fn();
  phase.values.set(key, pending);
  pending.catch(() => {
    if (phase.values.get(key) === pending) phase.values.delete(key);
  });
  return pending;
}

/**
 * Expire only mutable pointers. Tree/blob objects remain valid forever for
 * their sha. The legacy tree tag also expires old deployment log entries.
 */
export function invalidateGitHubReadHead(repo: string, owner: string): void {
  headInflight.delete(`${owner}/${repo}:cached`);
  headInflight.delete(`${owner}/${repo}:fresh`);
  for (const phase of activePhases()) {
    phase.heads.delete(`${owner}/${repo}`);
    for (const key of phase.values.keys()) {
      if (key.startsWith(`${owner}/${repo}:`)) phase.values.delete(key);
    }
  }
  invalidate(githubHeadCacheTag(owner, repo), treeCacheTag(owner, repo));
}

/** Publish only after a confirmed ref move, including empty commits. */
export function publishGitHubHead(
  repo: string,
  owner: string,
  head: GitHubReadHead | null,
): void {
  invalidateGitHubReadHead(repo, owner);
  if (head) {
    for (const phase of activePhases()) phase.heads.set(`${owner}/${repo}`, Promise.resolve(head));
  }
}
