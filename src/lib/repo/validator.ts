import { getOctokit } from "@/lib/github/client";

export interface RepoValidationResult {
  valid: boolean;
  owner: string;
  repo: string;
  error?: string;
}

/**
 * Parse a GitHub URL or "owner/repo" string into { owner, repo }.
 */
export function parseRepoInput(input: string): { owner: string; repo: string } | null {
  // Handle full URLs: https://github.com/owner/repo
  const urlMatch = input.match(/github\.com\/([^/]+)\/([^/\s?#]+)/);
  if (urlMatch) {
    return { owner: urlMatch[1], repo: urlMatch[2].replace(/\.git$/, "") };
  }
  // Handle "owner/repo" format
  const shortMatch = input.match(/^([^/\s]+)\/([^/\s]+)$/);
  if (shortMatch) {
    return { owner: shortMatch[1], repo: shortMatch[2] };
  }
  return null;
}

/**
 * Validate that the current GitHub token has access to a repository.
 */
export async function validateRepoAccess(owner: string, repo: string): Promise<RepoValidationResult> {
  try {
    const octokit = getOctokit();
    await octokit.rest.repos.get({ owner, repo });
    return { valid: true, owner, repo };
  } catch (error) {
    const status = (error as { status?: number }).status;
    let errorMsg = "Could not access repository";
    if (status === 404) {
      errorMsg = "Repository not found. Check the URL and try again.";
    } else if (status === 403) {
      errorMsg = "Token does not have access to this repository. Check your GITHUB_TOKEN permissions.";
    } else if (status === 401) {
      errorMsg = "GitHub token is not configured. Add GITHUB_TOKEN in Settings.";
    }
    return { valid: false, owner, repo, error: errorMsg };
  }
}
