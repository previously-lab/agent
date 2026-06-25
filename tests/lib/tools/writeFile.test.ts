import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGetContent = vi.fn();
const mockCreateOrUpdate = vi.fn();
vi.mock("@/lib/github/client", () => ({
  getOctokit: () => ({
    rest: {
      repos: {
        getContent: mockGetContent,
        createOrUpdateFileContents: mockCreateOrUpdate,
      },
    },
  }),
}));

import { writeFile } from "@/lib/tools/writeFile";

describe("writeFile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const repo = "test-repo";
  const owner = "test-owner";

  it("rejects path outside allowed directories", async () => {
    await expect(
      writeFile("src/app/page.tsx", "malicious", repo, owner)
    ).rejects.toThrow("Access denied");
  });

  it("rejects path traversal attempt", async () => {
    await expect(
      writeFile("memory/../../../.env", "stolen", repo, owner)
    ).rejects.toThrow("Access denied");
  });

  it("creates a new file in allowed path", async () => {
    mockGetContent.mockRejectedValue(new Error("Not Found"));
    mockCreateOrUpdate.mockResolvedValue({});

    const result = await writeFile(
      "memory/new.md",
      "Hello",
      repo,
      owner
    );

    expect(result.created).toBe(true);
    expect(result.path).toBe("memory/new.md");
    expect(mockCreateOrUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        owner,
        repo,
        path: "memory/new.md",
        sha: undefined,
      })
    );
  });

  it("updates an existing file", async () => {
    mockGetContent.mockResolvedValue({
      data: {
        type: "file",
        sha: "existing-sha-123",
      },
    });
    mockCreateOrUpdate.mockResolvedValue({});

    const result = await writeFile(
      "memory/existing.md",
      "Updated",
      repo,
      owner
    );

    expect(result.created).toBe(false);
    expect(mockCreateOrUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        sha: "existing-sha-123",
      })
    );
  });

  it("accepts empty content", async () => {
    mockGetContent.mockRejectedValue(new Error("Not Found"));
    mockCreateOrUpdate.mockResolvedValue({});

    const result = await writeFile(
      "memory/empty.md",
      "",
      repo,
      owner
    );

    expect(result.created).toBe(true);
  });

  it("throws for content exceeding size limit", async () => {
    const hugeContent = "x".repeat(1_500_000);
    await expect(
      writeFile("memory/huge.md", hugeContent, repo, owner)
    ).rejects.toThrow("too large");
  });

  it("uses custom commit message when provided", async () => {
    mockGetContent.mockRejectedValue(new Error("Not Found"));
    mockCreateOrUpdate.mockResolvedValue({});

    await writeFile(
      "memory/note.md",
      "content",
      repo,
      owner,
      "Add memory note"
    );

    expect(mockCreateOrUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Add memory note",
      })
    );
  });
});
