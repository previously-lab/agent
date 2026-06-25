import { getOctokit } from "@/lib/github/client";
import { isPathAllowed } from "@/lib/whitelist";

/**
 * List files and directories in the given path.
 * Only paths under the allowed directories are listable.
 */
export async function listFiles(
  path: string,
  repo: string,
  owner: string,
  ref?: string
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
      ref,
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
