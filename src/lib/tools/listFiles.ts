import { getOctokit } from "@/lib/github/client";
import { isPathAllowed } from "@/lib/whitelist";
import type { ReadOptions } from "@/lib/cache/data-cache";

/**
 * List files and directories in the given path.
 * Only paths under the allowed directories are listable.
 *
 * DELIBERATELY NOT CACHED, unlike `readFile` — the one GitHub read that goes
 * straight to the API. Caching is tag-invalidated, and a tag names a FILE:
 * writing `…/1200/timeline/core.md` revalidates exactly that entry and
 * nothing revalidates the listing of `…/1200/` it just appeared in. A listing
 * is how `timeline/enumerate.ts` DISCOVERS slice directories, so a cached one
 * could miss a slice another instance created seconds ago and quietly drop it
 * from the catalog for the rest of the TTL. Directory membership has no
 * writer-revalidated tag, so it gets no cache and no TTL — there is nothing
 * to bound.
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
