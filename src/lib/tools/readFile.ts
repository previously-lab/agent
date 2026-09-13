import { getOctokit } from "@/lib/github/client";
import { isPathAllowed } from "@/lib/whitelist";
import {
  cachedFetch,
  cacheTagFor,
  invalidate,
  ttlForPath,
  type ReadOptions,
} from "@/lib/cache/data-cache";

const MAX_FILE_SIZE_BYTES = 1_000_000; // 1MB limit for MVP

// ─── The GitHub read (cached in the Next.js Data Cache) ──────────────────
//
// This module is the GitHub backend of `readFile`, and the base read for
// every memory file in production. The cache itself lives in
// `@/lib/cache/data-cache` — this file only decides the identity, the TTL and
// the tag, since only it knows what a GitHub file IS.
//
// A single chat turn reads several files repeatedly (strands.json 4-7x,
// current-previously.md 1-3x, monthly _index.json across
// generateGlobalTimeline's 2-3 rebuilds); the cache collapses those to one
// real GitHub API round-trip per TTL window.
//
// Correctness contract (the mechanics are documented in data-cache.ts):
// - Errors (404s, directories, oversized files) are never cached —
//   `unstable_cache` only stores successful results, so a "file doesn't exist
//   yet, then it's created" flow can't serve a stale negative.
// - Writes revalidate the per-path tag (`invalidateReadCache`), so a file the
//   agent just wrote is a blocking cache miss on the next read — in this
//   request and across instances. io-helpers.fsReadFile checks its
//   pendingWrites queue BEFORE the cache, so in-batch write-then-read still
//   sees the freshest content.
// - TTLs bound staleness for changes that bypass our write path (direct
//   pushes to the memory repo): closed slices are immutable (24h), the
//   timeline/monthly indices mutate on slice open/close/flush (60s), other
//   memory files 300s.
//
// NOTE: the identity is (owner, repo, path) and nothing else. The old `ref`
// parameter is gone — it was never wired into the getContent request below
// (it was carried unused, with a note saying so), and the 4th parameter is
// now the shared `ReadOptions`. If ref is ever reintroduced it goes in the
// identity on both sides (read and invalidate), not just the request.

/**
 * Cache tag identifying one file in one repo. Writes revalidate this tag.
 * Derived from the write's own arguments, so a writer never needs to look
 * anything up (see `cacheTagFor`).
 */
export function fileCacheTag(path: string, repo: string, owner: string): string {
  return cacheTagFor("file", `${owner}/${repo}:${path}`);
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

/**
 * Read a file from the GitHub repository, via the Data Cache when available.
 * Only paths under the allowed directories are accessible.
 */
export async function readFile(
  path: string,
  repo: string,
  owner: string,
  opts?: ReadOptions
): Promise<string> {
  if (!isPathAllowed(path)) {
    throw new Error(
      `Access denied: path "${path}" is outside allowed directories`
    );
  }

  return cachedFetch(
    ["github", "file", owner, repo, path],
    ttlForPath(path, "github"),
    [fileCacheTag(path, repo, owner)],
    () => fetchFromGitHub(path, repo, owner),
    opts,
  );
}

/**
 * Read a file bypassing the Data Cache. The named escape hatch over
 * `readFile(..., { fresh: true })`, kept because correctness-critical callers
 * read better saying so: the flush-conflict self-heal re-reads the slice
 * another instance just committed, and a cached copy (or a tag revalidation
 * that never reached this context) must not answer that read.
 */
export async function readFileFresh(
  path: string,
  repo: string,
  owner: string
): Promise<string> {
  return readFile(path, repo, owner, { fresh: true });
}

/**
 * Invalidate the cached copy of a path after a GitHub write, so the next read
 * is a blocking cache miss. No-ops safely when there is no Next request store
 * in this context (the per-class TTL bounds staleness instead).
 */
export function invalidateReadCache(
  path: string,
  repo: string,
  owner: string,
): void {
  invalidate(fileCacheTag(path, repo, owner));
}
