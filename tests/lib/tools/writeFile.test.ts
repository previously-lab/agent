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
    mockGetContent.mockRejectedValue(Object.assign(new Error("Not Found"), { status: 404 }));
    mockCreateOrUpdate.mockResolvedValue({ data: { commit: { sha: "c1", tree: { sha: "t1" } } } });

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
        encoding: "base64",
        content: Buffer.from("Original content").toString("base64"),
      },
    });
    mockCreateOrUpdate.mockResolvedValue({ data: { commit: { sha: "c1", tree: { sha: "t1" } } } });

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
        content: Buffer.from("Updated").toString("base64"),
      })
    );
  });

  it("accepts empty content", async () => {
    mockGetContent.mockRejectedValue(Object.assign(new Error("Not Found"), { status: 404 }));
    mockCreateOrUpdate.mockResolvedValue({ data: { commit: { sha: "c1", tree: { sha: "t1" } } } });

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

  it("writes a canonical record core above the generic text cap", async () => {
    const path = "memory/records/2026/11/08/1234/core.md";
    const content = "x".repeat(1_000_001);
    mockGetContent.mockRejectedValue(Object.assign(new Error("Not Found"), { status: 404 }));
    mockCreateOrUpdate.mockResolvedValue({ data: { commit: { sha: "c1", tree: { sha: "t1" } } } });

    await expect(writeFile(path, content, repo, owner)).resolves.toEqual({ path, created: true });
    const request = mockCreateOrUpdate.mock.calls[0][0];
    expect(Buffer.from(request.content, "base64").toString("utf8")).toBe(content);
  });

  it("uses custom commit message when provided", async () => {
    mockGetContent.mockRejectedValue(Object.assign(new Error("Not Found"), { status: 404 }));
    mockCreateOrUpdate.mockResolvedValue({ data: { commit: { sha: "c1", tree: { sha: "t1" } } } });

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
