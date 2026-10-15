import {
  getOctokit,
  isGitHubRateLimitError,
  isGitHubReadTimeoutError,
} from "@/lib/github/client";
import { isPathAllowed } from "@/lib/whitelist";
import type { ReadOptions } from "@/lib/cache/data-cache";

/**
 * List files and directories in the given path.
 * Only paths under the allowed directories are listable.
 *
 * RAW AND UNCACHED by design — this module is the one GitHub listing that
 * always goes straight to the API. What changed in Wave A: most read
 * surfaces no longer call it. Directory membership is now answered from the
 * cached `memory/` subtree (`listRepoChildren` in readFile.ts), whose
 * staleness IS bounded — writers revalidate the `tree:` tag on every commit
 * (the invariant this module's old comment cited as impossible: a tag names
 * a file, and no tag revalidated the listing a file appeared in; the tree
 * tag is exactly that handle), and a 60s TTL bounds pushes that bypass our
 * write path. What remains here, raw on purpose:
 *
 *   - the fallback when the cached tree is TRUNCATED (a partial listing
 *     cannot truthfully answer "does this path exist");
 *   - roots the cached tree does not cover (tasks/, sessions/ — only
 *     `memory/` is in the subtree);
 *   - any caller whose correctness needs the listing another instance wrote
 *     THIS SECOND (tag revalidation is prompt, not instantaneous).
 *
 * (The demo backend's listing IS cached — see `listFilesDemo` — because the
 * demo dataset is read-only: nothing can ever appear in a published
 * directory, so there is no staleness to bound either.)
 *
 * `opts` is the shared base-read contract (`fresh`) and is unused here for
 * the same reason: a read that is never cached needs no escape from it. It
 * exists so backend-agnostic callers — io-helpers.fsListFiles, the agent tool
 * executors — can pass it unconditionally.
 */
export async function listFiles(
  path: string,
  repo: string,
  owner: string,
  opts?: ReadOptions
): Promise<Array<{ name: string; type: "file" | "dir"; path: string }>> {
  if (!isPathAllowed(path)) {
    throw new Error(
      `Access denied: path "${path}" is outside allowed directories`
    );
  }

  const octokit = getOctokit();

  try {
    const response = await octokit.rest.repos.getContent({
      owner,
      repo,
      path,
    });

    // Single file (not a directory)
    if (!Array.isArray(response.data)) {
      return [
        {
          name: response.data.name,
          type: "file",
          path: response.data.path,
        },
      ];
    }

    // Directory listing
    return response.data.map(
      (item: { name: string; type: string; path: string }) => ({
        name: item.name,
        type: item.type as "file" | "dir",
        path: item.path,
      })
    );
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Access denied")) {
      throw error;
    }
    // Guardrail failures (rate limit / read deadline) keep their type.
    if (isGitHubRateLimitError(error) || isGitHubReadTimeoutError(error)) {
      throw error;
    }
    if (
      error instanceof Error &&
      "status" in error &&
      (error as { status: number }).status === 404
    ) {
      throw new Error(`Directory not found: "${path}"`);
    }
    throw new Error(
      `Failed to list "${path}": ${error instanceof Error ? error.message : "unknown error"}`
    );
  }
}
