import { getOctokit } from "@/lib/github/client";
import { isPathAllowed } from "@/lib/whitelist";
import {
  CACHE_TTLS,
  cachedFetch,
  cacheTagFor,
  invalidate,
  treeCacheTag,
  ttlForPath,
  type ReadOptions,
} from "@/lib/cache/data-cache";
import { getDefaultBranch } from "@/lib/tools/batch-write";
import { listFiles } from "@/lib/tools/listFiles";

const MAX_FILE_SIZE_BYTES = 1_000_000; // 1MB limit for MVP

// ─── The GitHub read (cached in the Next.js Data Cache) ──────────────────
//
// This module is the GitHub backend of `readFile`, and the base read for
// every memory file in production. The cache itself lives in
// `@/lib/cache/data-cache` — this file only decides the identity, the TTL and
// the tag, since only it knows what a GitHub file IS.
//
// TWO READ LAYERS live here (Wave A, audit doc/audit-github-reads.md §4.1):
//
//   1. The per-file `readFile` below — a `repos.getContent` cached under the
//      path's identity with the TTL class `ttlForPath` assigns and the tag
//      writers revalidate. Unchanged contract.
//   2. The content-addressed layer at the bottom of the file: ONE cached
//      `memory/` subtree listing (`getRepoTree`, 60s, `tree:` tag) plus blob
//      bodies fetched BY SHA (`readBlobBase64`, effectively permanent — the
//      sha is the content hash). `readFileViaTree` / `listRepoChildren` /
//      `readBinaryFileViaTree` derive path answers from the two, so a warm
//      instance answers every display read with at most one small tree
//      revalidation per minute instead of one API call per file per TTL
//      window.
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

// ─── The content-addressed tree + blob layer (Wave A) ────────────────────
//
// Design: doc/audit-github-reads.md §4.1. Every contents/trees API payload
// carries the git `sha` of each entry — a content hash that changes iff the
// content changes. That splits "what exists" from "what it says":
//
//   - THE TREE (`getRepoTree`): one cached listing of the whole `memory/`
//     subtree, 60s TTL + the `tree:` tag writers revalidate per commit. Two
//     API calls on a miss (a tiny non-recursive ROOT tree to learn the
//     memory/ subtree sha, then one RECURSIVE read of that subtree) instead
//     of the previous whole-repo recursive tree per enumeration per surface.
//   - THE BLOBS (`readBlobBase64`): file bodies fetched by sha via
//     `git.getBlob`, cached under `blob:<sha>` for 7d with NO tag — the sha
//     is the content, so an entry can never be stale; eviction just costs a
//     re-fetch of the same bytes.
//
// A display read of a path (`readFileViaTree`, `listRepoChildren`,
// `readBinaryFileViaTree`) resolves path → sha from the tree, then sha →
// bytes from the blob cache: on a warm instance the ONLY GitHub traffic left
// is the small tree revalidation, however many files are read.
//
// THE CACHE ENTRY IS A COMPACT PROJECTION, not the API payload. Each entry
// stores {path, type, sha, size?} ≈ 110 bytes of JSON; the raw items also
// carry url/git_url/mode and cost ≈300+ bytes each. At the real tree's scale
// (~800 slices ≈ 2400 slice blobs + ~1100 slice-dir trees, ~600 case entries,
// ~200 other ≈ 4300 entries) that is ~0.5 MB cached against a ~1.5-2 MB raw
// response — comfortably under the Data Cache's per-entry size class, which
// the raw payload risks (coordinator-reviewed constraint from the audit).

/** One entry of the cached `memory/` subtree listing. */
export interface RepoTreeEntry {
  /** Repo-relative path ("memory/records/2026/08/11/1115/core.md"). */
  path: string;
  type: "blob" | "tree";
  /** The git object sha — the content hash the blob cache keys on. */
  sha: string;
  /** Byte size (blobs only) — lets readers enforce the 1MB cap pre-fetch. */
  size?: number;
}

/** The cached `memory/` subtree listing. */
export interface RepoTree {
  /** The memory/ subtree's own sha ("" when the repo has no memory/ root). */
  treeSha: string;
  /** Every blob and tree under memory/, repo-relative paths, sorted. */
  entries: RepoTreeEntry[];
  /**
   * GitHub's truncation flag, passed through NEVER silently: a truncated
   * listing cannot truthfully answer "does this path exist", so every reader
   * below falls back to the direct API path when it is set (the catalog
   * enumeration falls back to a per-directory walk — see enumerate.ts).
   */
  truncated: boolean;
}

const MEMORY_TREE_ROOT = "memory";

/**
 * The uncached fetch behind `getRepoTree`: the default branch's head ref,
 * the tiny non-recursive root tree (to learn the memory/ subtree sha), then
 * the memory/ subtree itself, recursive. Submodules and symlinks are not
 * memory files and are dropped from the projection.
 */
async function fetchRepoTree(owner: string, repo: string): Promise<RepoTree> {
  const octokit = getOctokit();
  const branch = await getDefaultBranch();
  const { data: ref } = await octokit.rest.git.getRef({
    owner,
    repo,
    ref: `heads/${branch}`,
  });
  const { data: rootTree } = await octokit.rest.git.getTree({
    owner,
    repo,
    tree_sha: ref.object.sha,
  });
  const memoryDir = (rootTree.tree ?? []).find(
    (e) => e.path === MEMORY_TREE_ROOT && e.type === "tree",
  );
  if (!memoryDir?.sha) return { treeSha: "", entries: [], truncated: false };
  const { data: tree } = await octokit.rest.git.getTree({
    owner,
    repo,
    tree_sha: memoryDir.sha,
    recursive: "1",
  });
  const entries: RepoTreeEntry[] = [];
  for (const item of tree.tree ?? []) {
    if (item.type !== "blob" && item.type !== "tree") continue;
    // Symlinks (120000) and submodules (160000) are not memory files.
    if (item.mode === "120000" || item.mode === "160000") continue;
    const p = item.path ?? "";
    if (!p || !item.sha) continue;
    entries.push({
      path: `${MEMORY_TREE_ROOT}/${p}`,
      type: item.type,
      sha: item.sha,
      ...(typeof item.size === "number" ? { size: item.size } : {}),
    });
  }
  entries.sort((a, b) => a.path.localeCompare(b.path));
  return { treeSha: memoryDir.sha, entries, truncated: tree.truncated === true };
}

/**
 * The in-flight single-flight for the tree identity — and ONLY this identity
 * (audit §3.5; the demo-fs manifest promise is the precedent). The Data Cache
 * owns the TTL window but has no single-flight on a miss, and a cold boot
 * fires the tree read from several surfaces in the same tick (arrival gate,
 * episodic state, archive index); without this each pays its own fetch.
 * Cleared on settle, so a failure never poisons the next caller.
 */
let treeInflight: Promise<RepoTree> | null = null;

/**
 * The cached `memory/` subtree listing. `fresh` bypasses both caches and
 * writes nothing back — the same contract `cachedFetch` defines.
 */
export async function getRepoTree(
  repo: string,
  owner: string,
  opts?: ReadOptions,
): Promise<RepoTree> {
  if (opts?.fresh) return fetchRepoTree(owner, repo);
  if (treeInflight) return treeInflight;
  const p = cachedFetch(
    ["github", "tree", owner, repo],
    CACHE_TTLS.TREE_SECONDS,
    [treeCacheTag(owner, repo)],
    () => fetchRepoTree(owner, repo),
  );
  treeInflight = p;
  const settle = () => {
    if (treeInflight === p) treeInflight = null;
  };
  p.then(settle, settle);
  return p;
}

/** The uncached fetch behind `readBlobBase64`: one `git.getBlob` call. */
async function fetchBlobBase64(
  sha: string,
  repo: string,
  owner: string,
): Promise<string> {
  const octokit = getOctokit();
  try {
    const { data } = await octokit.rest.git.getBlob({
      owner,
      repo,
      file_sha: sha,
    });
    return data.content.replace(/\n/g, "");
  } catch (error) {
    if (
      error instanceof Error &&
      "status" in error &&
      (error as { status: number }).status === 404
    ) {
      throw new Error(`Blob not found: "${sha}"`);
    }
    throw new Error(
      `Failed to read blob "${sha}": ${error instanceof Error ? error.message : "unknown error"}`,
    );
  }
}

/**
 * A blob's base64 body by its content sha — the permanent, tag-less cache
 * entry of the layer (`CACHE_TTLS.BLOB_SECONDS`; the sha IS the content, so
 * there is nothing a tag could ever revalidate). `fresh` bypasses without
 * write-back, as everywhere in this module.
 */
export async function readBlobBase64(
  sha: string,
  repo: string,
  owner: string,
  opts?: ReadOptions,
): Promise<string> {
  return cachedFetch(
    ["github", "blob", owner, repo, sha],
    CACHE_TTLS.BLOB_SECONDS,
    [],
    () => fetchBlobBase64(sha, repo, owner),
    opts,
  );
}

/** A blob's utf-8 text by sha (the text twin of `readBlobBase64`). */
export async function readBlobText(
  sha: string,
  repo: string,
  owner: string,
  opts?: ReadOptions,
): Promise<string> {
  return Buffer.from(await readBlobBase64(sha, repo, owner, opts), "base64").toString(
    "utf-8",
  );
}

/**
 * Read a memory file's text via the tree + blob caches. The 1MB cap is
 * enforced from the tree entry's size BEFORE the blob is fetched, and the
 * error messages mirror `readFile`'s exactly (the agent tools' domain-error
 * classifier matches on their prefixes).
 *
 * Scope: paths under `memory/` — the cached tree covers nothing else, so
 * other whitelisted roots (tasks/, sessions/) fall through to `readFile`,
 * as does ANY read while the tree is truncated (a partial listing cannot
 * answer "absent").
 */
export async function readFileViaTree(
  path: string,
  repo: string,
  owner: string,
  opts?: ReadOptions,
): Promise<string> {
  if (!isPathAllowed(path)) {
    throw new Error(
      `Access denied: path "${path}" is outside allowed directories`,
    );
  }
  const normalized = path.replace(/\\/g, "/");
  const tree = await getRepoTree(repo, owner, opts);
  if (tree.truncated || !normalized.startsWith(`${MEMORY_TREE_ROOT}/`)) {
    return readFile(path, repo, owner, opts);
  }
  const entry = tree.entries.find((e) => e.path === normalized);
  if (!entry) throw new Error(`File not found: "${path}"`);
  if (entry.type !== "blob") {
    throw new Error(`"${path}" is a directory, not a file`);
  }
  if (entry.size !== undefined && entry.size > MAX_FILE_SIZE_BYTES) {
    throw new Error(
      `File "${path}" is too large (${entry.size} bytes). Maximum is ${MAX_FILE_SIZE_BYTES} bytes.`,
    );
  }
  return readBlobText(entry.sha, repo, owner, opts);
}

/**
 * List one directory of the `memory/` subtree from the cached tree — the
 * same shape as `listFiles` (a file path lists as itself; a missing
 * directory throws `Directory not found`). Blob entries carry `size`.
 * Truncated trees and non-memory roots fall back to the raw live listing,
 * which is also what write-adjacent callers keep using directly.
 */
export async function listRepoChildren(
  path: string,
  repo: string,
  owner: string,
  opts?: ReadOptions,
): Promise<Array<{ name: string; type: "file" | "dir"; path: string; size?: number }>> {
  if (!isPathAllowed(path)) {
    throw new Error(
      `Access denied: path "${path}" is outside allowed directories`,
    );
  }
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const tree = await getRepoTree(repo, owner, opts);
  if (tree.truncated || !(normalized === MEMORY_TREE_ROOT || normalized.startsWith(`${MEMORY_TREE_ROOT}/`))) {
    return listFiles(normalized, repo, owner, opts);
  }
  const self = tree.entries.find((e) => e.path === normalized);
  if (self?.type === "blob") {
    return [
      {
        name: self.path.slice(self.path.lastIndexOf("/") + 1),
        type: "file",
        path: self.path,
        ...(self.size !== undefined ? { size: self.size } : {}),
      },
    ];
  }
  // Git tracks no empty directories, so a path with no tree entry and no
  // children does not exist; neither does anything when memory/ itself is
  // absent from the repo.
  if (tree.treeSha === "" || (!self && normalized !== MEMORY_TREE_ROOT)) {
    throw new Error(`Directory not found: "${path}"`);
  }
  const prefix = `${normalized}/`;
  const out: Array<{ name: string; type: "file" | "dir"; path: string; size?: number }> = [];
  for (const e of tree.entries) {
    if (!e.path.startsWith(prefix)) continue;
    const rest = e.path.slice(prefix.length);
    if (rest.includes("/")) continue; // deeper than one level
    out.push({
      name: rest,
      type: e.type === "blob" ? "file" : "dir",
      path: e.path,
      ...(e.size !== undefined ? { size: e.size } : {}),
    });
  }
  return out;
}

/** The raw binary read — the pre-Wave-A `fsReadBinaryFile` GitHub branch,
 *  kept as the truncation / non-memory fallback of `readBinaryFileViaTree`. */
async function fetchBinaryFromGitHub(
  path: string,
  repo: string,
  owner: string,
): Promise<Buffer> {
  const octokit = getOctokit();
  const res = await octokit.rest.repos.getContent({ owner, repo, path });
  if (
    Array.isArray(res.data) ||
    !("content" in res.data) ||
    typeof res.data.content !== "string"
  ) {
    throw new Error(`Not a file: "${path}"`);
  }
  return Buffer.from(res.data.content.replace(/\n/g, ""), "base64");
}

/**
 * Read raw BYTES via the tree + blob caches (attachments). Same fallback
 * rules as `readFileViaTree`; no size cap on read — the binary fuse is a
 * WRITE-side contract (fsWriteBinaryFile).
 */
export async function readBinaryFileViaTree(
  path: string,
  repo: string,
  owner: string,
  opts?: ReadOptions,
): Promise<Buffer> {
  if (!isPathAllowed(path)) {
    throw new Error(
      `Access denied: path "${path}" is outside allowed directories`,
    );
  }
  const normalized = path.replace(/\\/g, "/");
  const tree = await getRepoTree(repo, owner, opts);
  if (tree.truncated || !normalized.startsWith(`${MEMORY_TREE_ROOT}/`)) {
    return fetchBinaryFromGitHub(path, repo, owner);
  }
  const entry = tree.entries.find((e) => e.path === normalized);
  if (!entry || entry.type !== "blob") throw new Error(`Not a file: "${path}"`);
  return Buffer.from(
    await readBlobBase64(entry.sha, repo, owner, opts),
    "base64",
  );
}

/**
 * Invalidate the cached `memory/` subtree listing after a GitHub write moved
 * the tree — the directory-membership twin of `invalidateReadCache`. Writers
 * call it per commit (a batch commit moves the tree once, whatever its file
 * count). No-ops safely without a Next request store, same as `invalidate`.
 */
export function invalidateTreeCache(repo: string, owner: string): void {
  invalidate(treeCacheTag(owner, repo));
}
