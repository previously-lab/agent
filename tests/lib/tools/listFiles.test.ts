import { describe, it, expect, vi, beforeEach } from "vitest";

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

import { listFiles } from "@/lib/tools/listFiles";

describe("listFiles", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const repo = "test-repo";
  const owner = "test-owner";

  it("rejects path outside allowed directories", async () => {
    await expect(listFiles("src/app", repo, owner)).rejects.toThrow(
      "Access denied"
    );
  });

  it("lists files in an allowed directory", async () => {
    mockGetContent.mockResolvedValue({
      data: [
        { name: "a.md", type: "file", path: "memory/a.md" },
        { name: "subdir", type: "dir", path: "memory/subdir" },
      ],
    });

    const result = await listFiles("memory", repo, owner);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ name: "a.md", type: "file", path: "memory/a.md" });
    expect(result[1]).toEqual({ name: "subdir", type: "dir", path: "memory/subdir" });
  });

  it("wraps single file result in array", async () => {
    mockGetContent.mockResolvedValue({
      data: {
        type: "file",
        name: "solo.md",
        path: "memory/solo.md",
      },
    });

    const result = await listFiles("memory/solo.md", repo, owner);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("solo.md");
  });

  it("throws when directory not found", async () => {
    const notFoundError = new Error("Not Found") as Error & { status: number };
    notFoundError.status = 404;
    mockGetContent.mockRejectedValue(notFoundError);

    await expect(
      listFiles("memory/nonexistent", repo, owner)
    ).rejects.toThrow("Directory not found");
  });
});
