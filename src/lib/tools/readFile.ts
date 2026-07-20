import { getOctokit } from "@/lib/github/client";
import { isPathAllowed } from "@/lib/whitelist";

const MAX_FILE_SIZE_BYTES = 1_000_000; // 1MB limit for MVP

/**
 * Read a file from the GitHub repository.
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
    if (response.data.content) {
      return Buffer.from(response.data.content, "base64").toString("utf-8");
    }

    return "";
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
