/**
 * Batch GitHub writes — N file changes → 1 commit.
 *
 * Used by the episodic I/O layer during batch mode. Instead of calling
 * `createOrUpdateFileContents` once per file (each creates its own commit),
 * we use the Git Data API directly: create blobs, build a tree inheriting
 * from the current HEAD tree, create a single commit, and update the ref.
 *
 * This is the same pattern as `syncFromUpstream` but generalised for
 * arbitrary multi-file writes.
 */
import { getOctokit } from "@/lib/github/client";
import { getRepoConfig } from "@/lib/capabilities";
import { assertPortableRepoPath } from "@/lib/portable-path";
import { invalidateReadCache, invalidateTreeCache } from "@/lib/tools/readFile";
import { isPathAllowed } from "@/lib/whitelist";

export interface BatchEntry {
  path: string;
  /** null = delete the file at `path` (the tree item carries sha: null). */
  content: string | null;
  /**
   * Blob encoding — "base64" for BINARY payloads (attachments): the content
   * string is already base64 and rides the Git Data API as a base64 blob,
   * byte-identical through the batch commit. Absent = utf-8 text (unchanged).
   */
  encoding?: "utf-8" | "base64";
}

// ─── Default branch resolution (cached per process) ─────────────────────

let defaultBranchCache: { key: string; branch: string } | null = null;

/**
 * The repo's default branch (usually "main", but not always — the old code
 * hardcoded `heads/main` and broke on repos whose default branch differs).
 * Resolved once per process via repos.get and cached.
 */
async function resolveDefaultBranch(
  octokit: ReturnType<typeof getOctokit>,
  owner: string,
  repo: string,
): Promise<string> {
  const key = `${owner}/${repo}`;
  if (defaultBranchCache?.key === key) return defaultBranchCache.branch;
  const { data } = await octokit.rest.repos.get({ owner, repo });
  const branch = data.default_branch || "main";
  defaultBranchCache = { key, branch };
  return branch;
}

/** Test-only: drop the cached default branch. */
export function _resetDefaultBranchCache(): void {
  defaultBranchCache = null;
}

// ─── HEAD/tree pair (cached per process) ──────────────────────────────────
//
// Every successful batch flush already learns the new HEAD commit SHA and its
// tree SHA from the API responses, so the next flush can use them as its base
// instead of paying a getRef + getCommit round trip per flush. The cache is
// only a fast path: the ref update stays non-force, so a stale entry (another
// instance wrote in between, or a non-batch path moved HEAD without telling
// us) is caught by the usual conflict error and healed by the caller — at
// which point the entry is dropped and the next flush re-reads.

let headStateCache: { key: string; headSha: string; treeSha: string } | null =
  null;

/**
 * Record that `headSha`/`treeSha` is the current HEAD — called by every code
 * path that moves the ref (batch flushes here; the single-file contents-API
 * writes in writeFile.ts). The contents API embeds a trimmed commit in its
 * response whose fields are individually optional; a null on either side
 * means "HEAD moved but we can't map it" — the entry is dropped rather than
 * trusted with a guessed base.
 */
export function noteRepoHead(
  repo: string,
  owner: string,
  headSha: string | null,
  treeSha: string | null,
): void {
  if (!headSha || !treeSha) {
    headStateCache = null;
    return;
  }
  headStateCache = { key: `${owner}/${repo}`, headSha, treeSha };
}

/** Drop the cached HEAD/tree pair (conflict, or a HEAD move we can't map). */
export function invalidateRepoHead(repo: string, owner: string): void {
  if (headStateCache?.key === `${owner}/${repo}`) headStateCache = null;
}

/** Test-only: drop the cached HEAD/tree pair. */
export function _resetHeadStateCache(): void {
  headStateCache = null;
}

/** The configured repo's default branch (cached per process). */
export async function getDefaultBranch(): Promise<string> {
  const { owner, repo } = getRepoConfig();
  return resolveDefaultBranch(getOctokit(), owner, repo);
}

/**
 * True when a commit failed because the ref moved under us (non-fast-forward
 * updateRef) — the signal for the caller to re-read, merge, and retry.
 */
export function isRefConflictError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { status?: unknown; message?: unknown };
  const message = typeof e.message === "string" ? e.message : "";
  if (/not a fast.?forward/i.test(message)) return true;
  // GitHub returns 422 for a rejected ref update, 409 for some race shapes.
  return e.status === 422 || e.status === 409;
}

/**
 * Commit multiple file changes as a SINGLE git commit via the Git Data API.
 * Uses `base_tree` so only the changed files are included — the new tree
 * inherits everything else from the current HEAD.
 *
 * Returns the new commit SHA. Throws on failure (caller should retry).
 */
export async function commitBatchToGitHub(
  entries: BatchEntry[],
  message: string,
): Promise<string> {
  // Whitelist re-check, per path, before anything reaches the GitHub API —
  // the single-write path validates inside writeFile/readFile; the batch path
  // bypasses them, so the check lives here (same rule, same message).
  for (const { path } of entries) {
    if (!isPathAllowed(path)) {
      throw new Error(
        `Access denied: path "${path}" is outside allowed directories`,
      );
    }
    assertPortableRepoPath(path);
  }

  const { owner, repo } = getRepoConfig();
  const octokit = getOctokit();
  const branch = await resolveDefaultBranch(octokit, owner, repo);
  const headRef = `heads/${branch}`;

  // 1. Current HEAD + its tree. Served from the process cache when the last
  //    HEAD-mover (this flush or a single-file write) recorded it — two fewer
  //    round trips per flush. Any doubt (miss, conflict, unknown tree) falls
  //    back to the read below, which stays the source of truth.
  const key = `${owner}/${repo}`;
  let headSha: string;
  let baseTree: string;
  if (headStateCache?.key === key) {
    headSha = headStateCache.headSha;
    baseTree = headStateCache.treeSha;
  } else {
    const { data: ref } = await octokit.rest.git.getRef({
      owner,
      repo,
      ref: headRef,
    });
    headSha = ref.object.sha;
    const { data: commit } = await octokit.rest.git.getCommit({
      owner,
      repo,
      commit_sha: headSha,
    });
    baseTree = commit.tree.sha;
  }

  // 3. Create blobs for each file; a null content is a DELETE (tree item
  //    with sha: null removes the path from the tree). Binary payloads
  //    (attachments) arrive base64 with encoding "base64" — the blob keeps
  //    the bytes intact through the batch commit.
  const treeItems = await Promise.all(
    entries.map(async ({ path, content, encoding }) => {
      if (content === null) {
        return {
          path,
          mode: "100644" as const,
          type: "blob" as const,
          sha: null,
        };
      }
      const { data: blob } = await octokit.rest.git.createBlob({
        owner,
        repo,
        content,
        encoding: encoding === "base64" ? "base64" : "utf-8",
      });
      return {
        path,
        mode: "100644" as const,
        type: "blob" as const,
        sha: blob.sha,
      };
    }),
  );

  // 4. Create new tree (inherits unchanged files from base_tree)
  const { data: newTree } = await octokit.rest.git.createTree({
    owner,
    repo,
    base_tree: baseTree,
    tree: treeItems,
  });

  // 5. Create commit
  const { data: newCommit } = await octokit.rest.git.createCommit({
    owner,
    repo,
    message,
    tree: newTree.sha,
    parents: [headSha],
  });

  // 6. Update ref (fast-forward only — fails if someone else pushed). A
  //    failure here is ambiguous (rejected, OR the response was lost after
  //    the ref moved), so the cached HEAD is dropped either way; a rejection
  //    additionally heals through the caller's conflict retry.
  try {
    await octokit.rest.git.updateRef({
      owner,
      repo,
      ref: headRef,
      sha: newCommit.sha,
      force: false,
    });
  } catch (err) {
    invalidateRepoHead(repo, owner);
    throw err;
  }

  // This flush is now the HEAD-mover of record: the next flush can build on
  // the pair we just created instead of re-reading the ref.
  noteRepoHead(repo, owner, newCommit.sha, newTree.sha);

  // All written files changed on GitHub — revalidate their Data Cache tags
  // so a later read in this turn (or the next request) never serves stale
  // content. The commit also MOVED THE TREE: revalidate the cached memory/
  //  subtree listing (readFile.ts's getRepoTree) so directory membership —
  //  files this commit created or deleted — is exact too, not just content.
  for (const { path } of entries) {
    invalidateReadCache(path, repo, owner);
  }
  invalidateTreeCache(repo, owner);

  return newCommit.sha;
}
