import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  GitHubRateLimitError,
  GitHubReadTimeoutError,
  isGitHubRateLimitError,
  isGitHubReadTimeoutError,
} from "@/lib/github/client";

// readFile's octokit is replaced at the module seam — the classes come from
// the ORIGINAL module (importOriginal spread), so instanceof checks match
// what production throws.
const getContent = vi.hoisted(() => vi.fn());
vi.mock("@/lib/github/client", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/lib/github/client")>();
  return {
    ...original,
    getOctokit: () => ({ rest: { repos: { getContent } } }),
  };
});

import { readFile } from "@/lib/tools/readFile";

beforeEach(() => {
  getContent.mockReset();
});

describe("readFile guardrail passthrough", () => {
  it("a rate limit surfaces as GitHubRateLimitError, not a wrapped failure", async () => {
    getContent.mockRejectedValue(
      new GitHubRateLimitError(
        "GitHub rate limit (secondary): slow down",
        "secondary",
        429,
        60_000,
        false,
      ),
    );
    const err: unknown = await readFile("memory/x.md", "repo", "owner").catch(
      (e: unknown) => e,
    );
    expect(isGitHubRateLimitError(err)).toBe(true);
  });

  it("a read deadline surfaces as GitHubReadTimeoutError, not a wrapped failure", async () => {
    getContent.mockRejectedValue(
      new GitHubReadTimeoutError("GitHub read timed out", 15_000),
    );
    const err: unknown = await readFile("memory/x.md", "repo", "owner").catch(
      (e: unknown) => e,
    );
    expect(isGitHubReadTimeoutError(err)).toBe(true);
  });

  it("ordinary errors are still wrapped (the wrap's contract is unchanged)", async () => {
    getContent.mockRejectedValue(
      Object.assign(new Error("boom"), { status: 500 }),
    );
    await expect(readFile("memory/x.md", "repo", "owner")).rejects.toThrow(
      'Failed to read "memory/x.md": boom',
    );
  });

  it("404s still map to the domain error", async () => {
    getContent.mockRejectedValue(
      Object.assign(new Error("Not Found"), { status: 404 }),
    );
    await expect(readFile("memory/x.md", "repo", "owner")).rejects.toThrow(
      'File not found: "memory/x.md"',
    );
  });
});
