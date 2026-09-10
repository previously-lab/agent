import { describe, it, expect, vi, beforeEach } from "vitest";

// No Data Cache in vitest — unstable_cache is replaced with a passthrough so
// these tests exercise the no-store fallback path, and revalidateTag is a
// spy so tag invalidation is asserted directly.
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
  ttlForPath,
  fileCacheTag,
  READ_TTLS,
} from "@/lib/tools/readFile";

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

describe("ttlForPath", () => {
  it("caches closed slice files for a day (immutable)", () => {
    expect(ttlForPath("memory/episodic/slices/2026-01/slice-abc/core.md")).toBe(
      READ_TTLS.CLOSED_SLICE_SECONDS
    );
    expect(
      ttlForPath("memory/episodic/slices/2026-01/slice-abc/previously.md")
    ).toBe(READ_TTLS.CLOSED_SLICE_SECONDS);
    expect(ttlForPath("memory/episodic/slices/2026-01/slice-abc/core.md")).toBe(
      86_400
    );
  });

  it("uses a short TTL for the timeline index (mutates on open/close)", () => {
    expect(ttlForPath("memory/episodic/timeline/index.json")).toBe(
      READ_TTLS.TIMELINE_INDEX_SECONDS
    );
    expect(ttlForPath("memory/episodic/timeline/index.json")).toBe(60);
  });

  it("uses a moderate TTL for other memory files", () => {
    expect(ttlForPath("memory/episodic/strands.json")).toBe(
      READ_TTLS.MEMORY_DEFAULT_SECONDS
    );
    expect(ttlForPath("memory/episodic/current-previously.md")).toBe(
      READ_TTLS.MEMORY_DEFAULT_SECONDS
    );
    expect(ttlForPath("memory/user/card.md")).toBe(300);
    expect(ttlForPath("memory/evolution/direction.md")).toBe(300);
  });

  it("normalizes backslashes before classifying", () => {
    expect(
      ttlForPath("memory\\episodic\\slices\\2026-01\\slice-a\\core.md")
    ).toBe(READ_TTLS.CLOSED_SLICE_SECONDS);
  });
});

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
