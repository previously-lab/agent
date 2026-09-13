import { describe, it, expect, vi, beforeEach } from "vitest";

// There is no Data Cache store in vitest, so `unstable_cache` is stubbed with
// a passthrough: the reader runs directly, which is the same thing the
// no-store fallback in `@/lib/cache/data-cache` does (that branch, and the
// caching behavior itself, are covered in tests/lib/cache/data-cache.test.ts).
// revalidateTag is a spy so tag invalidation is asserted directly.
const mockRevalidateTag = vi.fn();

vi.mock("next/cache", () => ({
  unstable_cache: (cb: unknown) => cb,
  revalidateTag: (...args: unknown[]) => mockRevalidateTag(...args),
}));

// Mock octokit
const mockGetContent = vi.fn();
vi.mock("@/lib/github/client", () => ({
  getOctokit: () => ({
    rest: {
      repos: {
        getContent: mockGetContent,
      },
    },
  }),
}));

import {
  readFile,
  readFileFresh,
  invalidateReadCache,
  fileCacheTag,
} from "@/lib/tools/readFile";

// `ttlForPath` and the TTL table live in `@/lib/cache/data-cache` now, and are
// covered there (tests/lib/cache/data-cache.test.ts) across all three
// backends. This file covers the GitHub read that binds them to a path.

const repo = "test-repo";
const owner = "test-owner";

function fileResponse(content: string) {
  return {
    data: {
      type: "file",
      name: "f.md",
      path: "memory/f.md",
      size: content.length,
      encoding: "base64",
      content: Buffer.from(content, "utf-8").toString("base64"),
      sha: "abc123",
    },
  };
}

describe("fileCacheTag", () => {
  it("identifies one file in one repo", () => {
    expect(fileCacheTag("memory/f.md", repo, owner)).toBe(
      `file:${owner}/${repo}:memory/f.md`
    );
  });

  it("differs by owner, repo, and path", () => {
    const base = fileCacheTag("memory/f.md", repo, owner);
    expect(fileCacheTag("memory/f.md", "other-repo", owner)).not.toBe(base);
    expect(fileCacheTag("memory/f.md", repo, "other-owner")).not.toBe(base);
    expect(fileCacheTag("memory/g.md", repo, owner)).not.toBe(base);
  });
});

describe("readFile without a Data Cache store", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reads directly when no cache store is available", async () => {
    mockGetContent.mockResolvedValue(fileResponse("hello"));

    const content = await readFile("memory/f.md", repo, owner);
    expect(content).toBe("hello");
    expect(mockGetContent).toHaveBeenCalledTimes(1);
  });

  it("does not cache errors, so a later success re-fetches", async () => {
    const notFoundError = new Error("Not Found") as Error & { status: number };
    notFoundError.status = 404;

    mockGetContent.mockRejectedValueOnce(notFoundError);
    await expect(
      readFile("memory/f.md", repo, owner)
    ).rejects.toThrow("File not found");

    mockGetContent.mockResolvedValueOnce(fileResponse("now exists"));
    const content = await readFile("memory/f.md", repo, owner);

    expect(content).toBe("now exists");
    expect(mockGetContent).toHaveBeenCalledTimes(2);
  });

  it("readFileFresh always reads directly", async () => {
    mockGetContent.mockResolvedValue(fileResponse("fresh"));

    const content = await readFileFresh("memory/f.md", repo, owner);
    expect(content).toBe("fresh");
    expect(mockGetContent).toHaveBeenCalledTimes(1);
  });
});

describe("invalidateReadCache", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("revalidates the per-path tag with immediate expiry", () => {
    invalidateReadCache("memory/f.md", repo, owner);

    expect(mockRevalidateTag).toHaveBeenCalledTimes(1);
    expect(mockRevalidateTag).toHaveBeenCalledWith(
      fileCacheTag("memory/f.md", repo, owner),
      { expire: 0 }
    );
  });

  it("is a safe no-op when there is no Next request store", () => {
    mockRevalidateTag.mockImplementationOnce(() => {
      throw new Error(
        "Invariant: static generation store missing in revalidateTag"
      );
    });

    expect(() => invalidateReadCache("memory/f.md", repo, owner)).not.toThrow();
  });
});
