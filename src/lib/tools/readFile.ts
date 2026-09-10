import { unstable_cache, revalidateTag } from "next/cache";
import { getOctokit } from "@/lib/github/client";
import { isPathAllowed } from "@/lib/whitelist";

const MAX_FILE_SIZE_BYTES = 1_000_000; // 1MB limit for MVP

// ─── Read cache (Next.js Data Cache) ─────────────────────────────────────
//
// GitHub `getContent` reads are wrapped in Next.js's native Data Cache
// (`unstable_cache`) — no hand-rolled Map. A single chat turn reads several
// files repeatedly (strands.json 4-7x, current-previously.md 1-3x, monthly
// _index.json across generateGlobalTimeline's 2-3 rebuilds); the cache
// collapses those to one real GitHub API round-trip per TTL window.
//
// Correctness contract:
// - GitHub-mode only by construction (this module IS the GitHub backend).
//   Local/demo reads go through readFileLocal/readFileDemo and are never
//   cached: external processes (the CLI in client/bridge mode) can write
//   local files without going through our write path, so a long TTL would
//   serve stale data. Uncached local reads match the old behavior.
// - Errors (404s, directories, oversized files) are never cached —
//   unstable_cache only stores successful results, so a "file doesn't exist
//   yet, then it's created" flow can't serve a stale negative.
// - Writes revalidate the per-path tag (`invalidateReadCache` →
//   `revalidateTag(tag, { expire: 0 })`), so a file the agent just wrote is
//   a blocking cache miss on the next read — in this request and across
//   instances, since the Data Cache is shared (.next/cache on self-hosted
//   Node). io-helpers.fsReadFile checks its pendingWrites queue BEFORE the
//   cache, so in-batch write-then-read still sees the freshest content.
// - TTLs bound staleness for changes that bypass our write path (direct
//   pushes to the memory repo): closed slices are immutable (24h), the
//   timeline index mutates on slice open/close/flush (60s), other memory
//   files 300s.
// - Outside a Next request/prerender (unit tests, ad-hoc scripts) there is
//   no Data Cache store; readFile detects that and reads directly.
//
// NOTE: the key intentionally omits `ref` — the ref param is not wired into
// the getContent request today. If ref is ever used, add it to the wrapper
// identity and tags too.

export const READ_TTLS = {
  /** Slice core/previously files are immutable once the slice closes. */
  CLOSED_SLICE_SECONDS: 86_400,
  /** Timeline index mutates whenever a slice opens/closes/flushes. */
  TIMELINE_INDEX_SECONDS: 60,
  /** Strands, user card, evolution, sessions — mutable housekeeping data. */
  MEMORY_DEFAULT_SECONDS: 300,
} as const;

/** Cache TTL for a path, by memory-file class. Pure — unit-tested. */
export function ttlForPath(path: string): number {
  const normalized = path.replace(/\\/g, "/");
  if (normalized.startsWith("memory/episodic/slices/")) {
    return READ_TTLS.CLOSED_SLICE_SECONDS;
  }
  if (normalized === "memory/episodic/timeline/index.json") {
    return READ_TTLS.TIMELINE_INDEX_SECONDS;
  }
  return READ_TTLS.MEMORY_DEFAULT_SECONDS;
}

/** Cache tag identifying one file in one repo. Writes revalidate this tag. */
export function fileCacheTag(path: string, repo: string, owner: string): string {
  return `file:${owner}/${repo}:${path}`;
}

async function fetchFromGitHub(
  path: string,
  repo: string,
  owner: string
): Promise<string> {
  const octokit = getOctokit();

  try {
    const response = await octokit.rest.repos.getContent({
      owner,
      repo,
      path,
    });

    // GitHub returns an array for directories, single object for files
    if (Array.isArray(response.data)) {
      throw new Error(`"${path}" is a directory, not a file`);
    }

    // Must be a regular file (not symlink or submodule)
    if (response.data.type !== "file") {
      throw new Error(`"${path}" is not a regular file (type: ${response.data.type})`);
    }

    // Check file size before decoding
    if (response.data.size > MAX_FILE_SIZE_BYTES) {
      throw new Error(
        `File "${path}" is too large (${response.data.size} bytes). Maximum is ${MAX_FILE_SIZE_BYTES} bytes.`
      );
    }

    // Content is base64-encoded
    return response.data.content
      ? Buffer.from(response.data.content, "base64").toString("utf-8")
      : "";
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Access denied")) {
      throw error;
    }
    if (
      error instanceof Error &&
      "status" in error &&
      (error as { status: number }).status === 404
    ) {
      throw new Error(`File not found: "${path}"`);
    }
    throw new Error(
      `Failed to read "${path}": ${error instanceof Error ? error.message : "unknown error"}`
    );
  }
}

// One cached wrapper per (owner, repo, path): unstable_cache binds revalidate
// and tags at wrap time, and both are per-path here. The map holds wrapper
// functions only — all cached data lives in the Data Cache.
const cachedFetchers = new Map<
  string,
  (path: string, repo: string, owner: string) => Promise<string>
>();

function cachedFetcherFor(
  path: string,
  repo: string,
  owner: string
): (path: string, repo: string, owner: string) => Promise<string> {
  const identity = `${owner}/${repo}:${path}`;
  let fetcher = cachedFetchers.get(identity);
  if (!fetcher) {
    fetcher = unstable_cache(fetchFromGitHub, ["aftrbrez-read", identity], {
      revalidate: ttlForPath(path),
      tags: [fileCacheTag(path, repo, owner)],
    });
    cachedFetchers.set(identity, fetcher);
  }
  return fetcher;
}

const NO_DATA_CACHE_STORE = /incrementalCache missing/;

/**
 * Read a file from the GitHub repository, via the Data Cache when available.
 * Only paths under the allowed directories are accessible.
 */
export async function readFile(
  path: string,
  repo: string,
  owner: string,
  ref?: string
): Promise<string> {
  if (!isPathAllowed(path)) {
    throw new Error(
      `Access denied: path "${path}" is outside allowed directories`
    );
  }

  try {
    return await cachedFetcherFor(path, repo, owner)(path, repo, owner);
  } catch (error) {
    // No Data Cache in this context (unit tests, non-request server code) —
    // read directly instead of failing.
    if (error instanceof Error && NO_DATA_CACHE_STORE.test(error.message)) {
      return fetchFromGitHub(path, repo, owner);
    }
    throw error;
  }
}

/**
 * Read a file bypassing the Data Cache. For correctness-critical re-reads
 * where a cached copy (or a tag revalidation that didn't reach this context)
 * must not be served — e.g. the flush-conflict self-heal re-reading the
 * remote slice another instance just committed.
 */
export async function readFileFresh(
  path: string,
  repo: string,
  owner: string,
  ref?: string
): Promise<string> {
  if (!isPathAllowed(path)) {
    throw new Error(
      `Access denied: path "${path}" is outside allowed directories`
    );
  }
  return fetchFromGitHub(path, repo, owner);
}

/**
 * Invalidate the cached copy of a path after a GitHub write. Revalidates the
 * per-path cache tag with immediate expiry, so the next read is a blocking
 * cache miss. No-ops safely when there is no Next request store in this
 * context (the per-class TTL bounds staleness instead).
 */
export function invalidateReadCache(
  path: string,
  repo: string,
  owner: string,
): void {
  try {
    revalidateTag(fileCacheTag(path, repo, owner), { expire: 0 });
  } catch {
    // No Next request store here — nothing to revalidate in this context.
  }
}
