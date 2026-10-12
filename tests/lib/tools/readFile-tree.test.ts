import { describe, it, expect, vi, beforeEach } from "vitest";

// The content-addressed tree + blob layer of `@/lib/tools/readFile` (Wave A,
// audit doc/audit-github-reads.md §4.1). The Data Cache stand-in is a REAL
// memo keyed the way Next keys it (the key parts), so a test can tell "served
// from the cache" apart from "ran the fetch again" — a passthrough stub
// cannot (see tests/lib/cache/data-cache.test.ts, the same pattern).
const hoisted = vi.hoisted(() => {
  const cacheStore = new Map<string, unknown>();
  const mockRevalidateTag = vi.fn();
  const mockUnstableCache = vi.fn(
    (
      cb: (...args: unknown[]) => Promise<unknown>,
      keyParts: string[],
      _options?: { revalidate: number; tags: string[] },
    ) => {
      const key = JSON.stringify(keyParts);
      return async (...args: unknown[]): Promise<unknown> => {
        if (cacheStore.has(key)) return cacheStore.get(key);
        const value = await cb(...args);
        cacheStore.set(key, value);
        return value;
      };
    },
  );
  const mockGetRef = vi.fn();
  const mockGetTree = vi.fn();
  const mockGetBlob = vi.fn();
  const mockGetContent = vi.fn();
  return {
    cacheStore,
    mockRevalidateTag,
    mockUnstableCache,
    mockGetRef,
    mockGetTree,
    mockGetBlob,
    mockGetContent,
  };
});

vi.mock("next/cache", () => ({
  unstable_cache: hoisted.mockUnstableCache,
  revalidateTag: hoisted.mockRevalidateTag,
}));

vi.mock("@/lib/github/client", () => ({
  getOctokit: () => ({
    rest: {
      git: {
        getRef: hoisted.mockGetRef,
        getTree: hoisted.mockGetTree,
        getBlob: hoisted.mockGetBlob,
      },
      repos: { getContent: hoisted.mockGetContent },
    },
  }),
}));

// The default-branch lookup is the only thing readFile.ts takes from
// batch-write; mocking the module keeps the commit machinery out of the graph.
vi.mock("@/lib/tools/batch-write", () => ({
  getDefaultBranch: async () => "main",
}));

import {
  getRepoTree,
  readFileViaTree,
  listRepoChildren,
  readBinaryFileViaTree,
  invalidateTreeCache,
} from "@/lib/tools/readFile";

const repo = "test-repo";
const owner = "test-owner";

const REF = { data: { object: { sha: "headsha" } } };
const ROOT_TREE = {
  data: {
    tree: [
      { path: "memory", type: "tree", sha: "memsha" },
      { path: "src", type: "tree", sha: "srcsha" },
      { path: "README.md", type: "blob", sha: "readmesha", size: 10 },
    ],
  },
};
/**
 * The recursive memory/ subtree payload. Deliberately unsorted (to prove the
 * projection sorts) and carrying the raw payload's noise fields plus a
 * submodule and a symlink (to prove they are dropped).
 */
const MEMORY_SUBTREE = {
  data: {
    tree: [
      {
        path: "user/card.md",
        type: "blob",
        sha: "cardsha",
        size: 9,
        mode: "100644",
        url: "https://api.github.com/...",
      },
      { path: "records", type: "tree", sha: "t-records" },
      { path: "user", type: "tree", sha: "t-user" },
      {
        path: "records/2026/08/11/1115/core.md",
        type: "blob",
        sha: "coresha",
        size: 11,
      },
      { path: "records/2026", type: "tree", sha: "t-2026" },
      { path: "records/2026/08", type: "tree", sha: "t-08" },
      { path: "records/2026/08/11", type: "tree", sha: "t-11" },
      { path: "records/2026/08/11/1115", type: "tree", sha: "t-1115" },
      { path: "assets", type: "tree", sha: "t-assets" },
      { path: "assets/pic.png", type: "blob", sha: "picsha", size: 4 },
      { path: "big.bin", type: "blob", sha: "bigsha", size: 2_000_000 },
      { path: "vendor", type: "commit", sha: "subsha", mode: "160000" },
      { path: "link.md", type: "blob", sha: "linksha", mode: "120000" },
    ],
    truncated: false,
  },
};

function primeTreeFetch(subtree: unknown = MEMORY_SUBTREE): void {
  hoisted.mockGetRef.mockResolvedValue(REF);
  hoisted.mockGetTree
    .mockResolvedValueOnce(ROOT_TREE)
    .mockResolvedValueOnce(subtree);
}

/** GitHub wraps base64 blob payloads in newlines; the reader strips them. */
function wrappedB64(bytes: Buffer): string {
  return bytes.toString("base64").match(/.{1,4}/g)!.join("\n");
}

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.cacheStore.clear();
});

// ─── getRepoTree ─────────────────────────────────────────────────────────

describe("getRepoTree", () => {
  it("fetches ref → root tree → memory/ subtree, and caches a compact sorted projection", async () => {
    primeTreeFetch();

    const tree = await getRepoTree(repo, owner);

    expect(hoisted.mockGetRef).toHaveBeenCalledWith({
      owner,
      repo,
      ref: "heads/main",
    });
    expect(hoisted.mockGetTree).toHaveBeenCalledTimes(2);
    expect(hoisted.mockGetTree).toHaveBeenNthCalledWith(1, {
      owner,
      repo,
      tree_sha: "headsha",
    });
    expect(hoisted.mockGetTree).toHaveBeenNthCalledWith(2, {
      owner,
      repo,
      tree_sha: "memsha",
      recursive: "1",
    });

    expect(tree.treeSha).toBe("memsha");
    expect(tree.truncated).toBe(false);
    const paths = tree.entries.map((e) => e.path);
    // Repo-relative, memory/-prefixed, sorted.
    expect(paths.length).toBeGreaterThan(0);
    expect(paths.every((p) => p.startsWith("memory/"))).toBe(true);
    expect(paths).toEqual([...paths].sort((a, b) => a.localeCompare(b)));
    // Submodules and symlinks are not memory files.
    expect(paths).not.toContain("memory/vendor");
    expect(paths).not.toContain("memory/link.md");
    // The compact projection: exactly {path, type, sha, size?} — none of the
    // raw payload's url/mode noise.
    expect(
      tree.entries.find((e) => e.path === "memory/user/card.md"),
    ).toEqual({ path: "memory/user/card.md", type: "blob", sha: "cardsha", size: 9 });
    expect(tree.entries.find((e) => e.path === "memory/records")).toEqual({
      path: "memory/records",
      type: "tree",
      sha: "t-records",
    });
  });

  it("serves a second read from the Data Cache — zero further API calls", async () => {
    primeTreeFetch();

    await getRepoTree(repo, owner);
    const again = await getRepoTree(repo, owner);

    expect(again.treeSha).toBe("memsha");
    expect(hoisted.mockGetRef).toHaveBeenCalledTimes(1);
    expect(hoisted.mockGetTree).toHaveBeenCalledTimes(2);
  });

  it("single-flights concurrent cold reads of the tree identity", async () => {
    hoisted.mockGetRef.mockResolvedValue(REF);
    // The gate is created HERE so the releaser exists synchronously — the
    // recursive getTree call only happens several microtasks after
    // getRepoTree() is invoked, too late to assign it inside the mock.
    let releaseSubtree!: () => void;
    const gate = new Promise((resolve) => {
      releaseSubtree = () => resolve(MEMORY_SUBTREE);
    });
    hoisted.mockGetTree.mockImplementation((args: { recursive?: string }) =>
      args.recursive ? gate : Promise.resolve(ROOT_TREE),
    );

    // The Data Cache only memoizes on RESOLUTION, so without the in-flight
    // dedupe two concurrent cold reads would each pay the full fetch.
    const first = getRepoTree(repo, owner);
    const second = getRepoTree(repo, owner);
    releaseSubtree();
    const [a, b] = await Promise.all([first, second]);

    expect(a).toBe(b); // the same in-flight promise answered both
    expect(hoisted.mockGetRef).toHaveBeenCalledTimes(1);
    expect(hoisted.mockGetTree).toHaveBeenCalledTimes(2);
  });

  it("returns an empty tree when the repo has no memory/ root", async () => {
    hoisted.mockGetRef.mockResolvedValue(REF);
    hoisted.mockGetTree.mockResolvedValueOnce({
      data: { tree: [{ path: "src", type: "tree", sha: "srcsha" }] },
    });

    const tree = await getRepoTree(repo, owner);

    expect(tree).toEqual({ treeSha: "", entries: [], truncated: false });
    expect(hoisted.mockGetTree).toHaveBeenCalledTimes(1); // no recursive call
  });

  it("fresh bypasses the cache and writes nothing back", async () => {
    primeTreeFetch();
    await getRepoTree(repo, owner);

    hoisted.mockGetTree
      .mockResolvedValueOnce(ROOT_TREE)
      .mockResolvedValueOnce({
        data: {
          tree: [{ path: "user/card.md", type: "blob", sha: "newsha", size: 9 }],
          truncated: false,
        },
      });
    const fresh = await getRepoTree(repo, owner, { fresh: true });
    expect(fresh.entries.map((e) => e.sha)).toContain("newsha");

    // The fresh read did NOT replace the cached entry.
    const cached = await getRepoTree(repo, owner);
    expect(cached.entries.map((e) => e.sha)).toContain("coresha");
    expect(hoisted.mockGetRef).toHaveBeenCalledTimes(2); // prime + fresh only
  });
});

// ─── readFileViaTree ─────────────────────────────────────────────────────

describe("readFileViaTree", () => {
  it("reads a file's text via path → tree sha → blob", async () => {
    primeTreeFetch();
    hoisted.mockGetBlob.mockResolvedValue({
      data: { content: wrappedB64(Buffer.from("hello\nworld", "utf-8")) },
    });

    const text = await readFileViaTree("memory/user/card.md", repo, owner);

    expect(text).toBe("hello\nworld");
    expect(hoisted.mockGetBlob).toHaveBeenCalledWith({
      owner,
      repo,
      file_sha: "cardsha",
    });
  });

  it("answers a second read of the same file with zero further API calls", async () => {
    primeTreeFetch();
    hoisted.mockGetBlob.mockResolvedValue({
      data: { content: wrappedB64(Buffer.from("hello", "utf-8")) },
    });

    await readFileViaTree("memory/user/card.md", repo, owner);
    const again = await readFileViaTree("memory/user/card.md", repo, owner);

    expect(again).toBe("hello");
    expect(hoisted.mockGetRef).toHaveBeenCalledTimes(1);
    expect(hoisted.mockGetTree).toHaveBeenCalledTimes(2);
    expect(hoisted.mockGetBlob).toHaveBeenCalledTimes(1);
  });

  it("throws File not found for an absent path, without fetching a blob", async () => {
    primeTreeFetch();

    await expect(
      readFileViaTree("memory/nope.md", repo, owner),
    ).rejects.toThrow('File not found: "memory/nope.md"');
    expect(hoisted.mockGetBlob).not.toHaveBeenCalled();
  });

  it("throws the directory error for a tree entry", async () => {
    primeTreeFetch();

    await expect(
      readFileViaTree("memory/records", repo, owner),
    ).rejects.toThrow('"memory/records" is a directory, not a file');
  });

  it("enforces the 1MB cap from the tree entry BEFORE fetching the blob", async () => {
    primeTreeFetch();

    await expect(
      readFileViaTree("memory/big.bin", repo, owner),
    ).rejects.toThrow(
      'File "memory/big.bin" is too large (2000000 bytes). Maximum is 1000000 bytes.',
    );
    expect(hoisted.mockGetBlob).not.toHaveBeenCalled();
  });

  it("falls back to the raw per-file read when the tree is truncated", async () => {
    primeTreeFetch({
      data: { tree: MEMORY_SUBTREE.data.tree, truncated: true },
    });
    hoisted.mockGetContent.mockResolvedValue({
      data: {
        type: "file",
        name: "card.md",
        path: "memory/user/card.md",
        size: 4,
        encoding: "base64",
        content: Buffer.from("raw!", "utf-8").toString("base64"),
        sha: "cardsha",
      },
    });

    const text = await readFileViaTree("memory/user/card.md", repo, owner);

    expect(text).toBe("raw!");
    expect(hoisted.mockGetContent).toHaveBeenCalledTimes(1);
    expect(hoisted.mockGetBlob).not.toHaveBeenCalled();
  });

  it("falls back to the raw per-file read for non-memory roots", async () => {
    primeTreeFetch();
    hoisted.mockGetContent.mockResolvedValue({
      data: {
        type: "file",
        name: "todo.md",
        path: "tasks/todo.md",
        size: 4,
        encoding: "base64",
        content: Buffer.from("task", "utf-8").toString("base64"),
        sha: "tasksha",
      },
    });

    const text = await readFileViaTree("tasks/todo.md", repo, owner);

    expect(text).toBe("task");
    expect(hoisted.mockGetContent).toHaveBeenCalledTimes(1);
    expect(hoisted.mockGetBlob).not.toHaveBeenCalled();
  });
});

// ─── listRepoChildren ────────────────────────────────────────────────────

describe("listRepoChildren", () => {
  it("lists exactly one level of a directory from the cached tree", async () => {
    primeTreeFetch();

    const entries = await listRepoChildren("memory/records/2026/08/11", repo, owner);

    expect(entries).toEqual([
      {
        name: "1115",
        type: "dir",
        path: "memory/records/2026/08/11/1115",
      },
    ]);
  });

  it("lists the memory root itself", async () => {
    primeTreeFetch();

    const entries = await listRepoChildren("memory", repo, owner);
    const byName = Object.fromEntries(entries.map((e) => [e.name, e.type]));

    expect(byName).toEqual({
      records: "dir",
      user: "dir",
      assets: "dir",
      "big.bin": "file",
    });
  });

  it("lists a file path as itself, with size", async () => {
    primeTreeFetch();

    const entries = await listRepoChildren("memory/user/card.md", repo, owner);

    expect(entries).toEqual([
      { name: "card.md", type: "file", path: "memory/user/card.md", size: 9 },
    ]);
  });

  it("throws Directory not found for an absent directory", async () => {
    primeTreeFetch();

    await expect(
      listRepoChildren("memory/nowhere", repo, owner),
    ).rejects.toThrow('Directory not found: "memory/nowhere"');
  });

  it("falls back to the raw listing when the tree is truncated", async () => {
    primeTreeFetch({
      data: { tree: MEMORY_SUBTREE.data.tree, truncated: true },
    });
    hoisted.mockGetContent.mockResolvedValue({
      data: [
        { name: "2026", type: "dir", path: "memory/records/2026" },
      ],
    });

    const entries = await listRepoChildren("memory/records", repo, owner);

    expect(entries).toEqual([
      { name: "2026", type: "dir", path: "memory/records/2026" },
    ]);
    expect(hoisted.mockGetContent).toHaveBeenCalledWith({
      owner,
      repo,
      path: "memory/records",
    });
  });

  it("falls back to the raw listing for non-memory roots", async () => {
    primeTreeFetch();
    hoisted.mockGetContent.mockResolvedValue({
      data: [{ name: "todo.md", type: "file", path: "tasks/todo.md" }],
    });

    const entries = await listRepoChildren("tasks", repo, owner);

    expect(entries).toEqual([
      { name: "todo.md", type: "file", path: "tasks/todo.md" },
    ]);
    expect(hoisted.mockGetContent).toHaveBeenCalledWith({
      owner,
      repo,
      path: "tasks",
    });
  });
});

// ─── readBinaryFileViaTree ───────────────────────────────────────────────

describe("readBinaryFileViaTree", () => {
  it("reads raw bytes via the blob cache", async () => {
    primeTreeFetch();
    const bytes = Buffer.from([1, 2, 3, 255]);
    hoisted.mockGetBlob.mockResolvedValue({
      data: { content: wrappedB64(bytes) },
    });

    const out = await readBinaryFileViaTree("memory/assets/pic.png", repo, owner);

    expect(out).toEqual(bytes);
    expect(hoisted.mockGetBlob).toHaveBeenCalledWith({
      owner,
      repo,
      file_sha: "picsha",
    });
  });

  it("throws Not a file for a directory path", async () => {
    primeTreeFetch();

    await expect(
      readBinaryFileViaTree("memory/records", repo, owner),
    ).rejects.toThrow('Not a file: "memory/records"');
    expect(hoisted.mockGetBlob).not.toHaveBeenCalled();
  });
});

// ─── invalidateTreeCache ─────────────────────────────────────────────────

describe("invalidateTreeCache", () => {
  it("revalidates the tree tag with immediate expiry", () => {
    invalidateTreeCache(repo, owner);

    expect(hoisted.mockRevalidateTag).toHaveBeenCalledTimes(1);
    expect(hoisted.mockRevalidateTag).toHaveBeenCalledWith("tree:test-owner/test-repo", {
      expire: 0,
    });
  });
});
