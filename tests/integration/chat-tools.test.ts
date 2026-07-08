import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Set env vars before any imports
process.env.GITHUB_REPO_OWNER = "test-owner";
process.env.GITHUB_REPO_NAME = "test-repo";
process.env.GITHUB_TOKEN = "test-token";

// Mock octokit at module level
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
  resetOctokit: vi.fn(),
}));

import { readFile } from "@/lib/tools/readFile";
import { writeFile } from "@/lib/tools/writeFile";
import { listFiles } from "@/lib/tools/listFiles";
import { isPathAllowed, normalizePath } from "@/lib/whitelist";

const repo = "test-repo";
const owner = "test-owner";

describe("Integration: Chat → Tool → GitHub cycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("complete write-read-update lifecycle on memory/", async () => {
    // Step 1: Write a file
    mockGetContent.mockRejectedValueOnce(new Error("Not Found")); // file doesn't exist yet
    mockCreateOrUpdate.mockResolvedValueOnce({});

    const writeResult = await writeFile("memory/test.md", "Hello, World!", repo, owner);
    expect(writeResult.path).toBe("memory/test.md");
    expect(writeResult.created).toBe(true);

    // Step 2: Read it back
    mockGetContent.mockResolvedValueOnce({
      data: {
        type: "file",
        name: "test.md",
        path: "memory/test.md",
        size: 13,
        encoding: "base64",
        content: Buffer.from("Hello, World!").toString("base64"),
        sha: "abc123",
      },
    });

    const content = await readFile("memory/test.md", repo, owner);
    expect(content).toBe("Hello, World!");

    // Step 3: Update the file
    mockGetContent.mockResolvedValueOnce({
      data: { type: "file", sha: "abc123" },
    });
    mockCreateOrUpdate.mockResolvedValueOnce({});

    const updateResult = await writeFile("memory/test.md", "Updated content", repo, owner);
    expect(updateResult.path).toBe("memory/test.md");
    expect(updateResult.created).toBe(false);
  });

  it("whitelist blocks unauthorized paths across all tools", async () => {
    // readFile blocked
    await expect(readFile("src/app/page.tsx", repo, owner)).rejects.toThrow("Access denied");
    await expect(readFile(".env", repo, owner)).rejects.toThrow("Access denied");

    // writeFile blocked
    await expect(writeFile("src/app/page.tsx", "malicious", repo, owner)).rejects.toThrow("Access denied");
    await expect(writeFile(".env", "KEY=value", repo, owner)).rejects.toThrow("Access denied");

    // listFiles blocked
    await expect(listFiles("src", repo, owner)).rejects.toThrow("Access denied");
    await expect(listFiles("node_modules", repo, owner)).rejects.toThrow("Access denied");
  });

  it("path traversal blocked with deep nesting", async () => {
    const traversalPaths = [
      "memory/../../../etc/passwd",
      "memory/subdir/../../../src/secret.ts",
      "tasks/../../.env",
      "sessions/../../package.json",
    ];

    for (const path of traversalPaths) {
      await expect(readFile(path, repo, owner)).rejects.toThrow("Access denied");
    }
  });

  it("allowed paths work for all three directories", () => {
    expect(isPathAllowed("memory/note.md")).toBe(true);
    expect(isPathAllowed("memory/projects/previously/context.md")).toBe(true);
    expect(isPathAllowed("tasks/status.md")).toBe(true);
    expect(isPathAllowed("sessions/2025-06-25.md")).toBe(true);
    expect(isPathAllowed("memory")).toBe(true);
    expect(isPathAllowed("tasks")).toBe(true);
    expect(isPathAllowed("sessions")).toBe(true);
  });

  it("list directory returns files and subdirectories", async () => {
    mockGetContent.mockResolvedValueOnce({
      data: [
        { name: "readme.md", type: "file", path: "memory/readme.md" },
        { name: "projects", type: "dir", path: "memory/projects" },
        { name: "notes.md", type: "file", path: "memory/notes.md" },
      ],
    });

    const result = await listFiles("memory/", repo, owner);
    expect(result).toHaveLength(3);
    expect(result[0].name).toBe("readme.md");
    expect(result[1].name).toBe("projects");
    expect(result[2].name).toBe("notes.md");
  });

  it("error recovery: write fails then succeeds on retry", async () => {
    // First attempt: GitHub API error
    mockGetContent.mockRejectedValueOnce(new Error("Not Found"));
    mockCreateOrUpdate.mockRejectedValueOnce(new Error("Network error"));

    await expect(
      writeFile("memory/retry.md", "content", repo, owner)
    ).rejects.toThrow("Network error");

    // Second attempt: succeeds
    mockGetContent.mockRejectedValueOnce(new Error("Not Found"));
    mockCreateOrUpdate.mockResolvedValueOnce({});

    const result = await writeFile("memory/retry.md", "content", repo, owner);
    expect(result.created).toBe(true);
  });
});
