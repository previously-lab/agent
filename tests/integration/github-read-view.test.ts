import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createNextDataCacheContext } from "../helpers/next-data-cache-context";

const api = vi.hoisted(() => ({
  get: vi.fn(), getRef: vi.fn(), getTree: vi.fn(), getBlob: vi.fn(),
  getContent: vi.fn(), createOrUpdateFileContents: vi.fn(),
  getCommit: vi.fn(), createCommit: vi.fn(), updateRef: vi.fn(),
}));
vi.mock("@/lib/github/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/github/client")>()),
  getOctokit: () => ({ rest: { repos: api, git: api } }),
}));

let reads: typeof import("@/lib/tools/readFile");
let views: typeof import("@/lib/github/read-view");
let cache: typeof import("@/lib/cache/data-cache");
let writes: typeof import("@/lib/tools/writeFile");
let batches: typeof import("@/lib/tools/batch-write");

beforeAll(async () => {
  // Initialize real Next AsyncLocalStorage before loading next/cache.
  createNextDataCacheContext();
  reads = await import("@/lib/tools/readFile");
  views = await import("@/lib/github/read-view");
  cache = await import("@/lib/cache/data-cache");
  writes = await import("@/lib/tools/writeFile");
  batches = await import("@/lib/tools/batch-write");
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  views.resetGitHubDefaultBranches();
  batches._resetHeadStateCache();
  api.get.mockResolvedValue({ data: { default_branch: "main" } });
  api.getRef.mockImplementation(async ({ repo }: { repo: string }) => ({
    data: { object: { sha: `${repo}-head` } },
  }));
  api.getTree.mockImplementation(async ({ tree_sha }: { tree_sha: string }) => ({
    data: tree_sha.endsWith("-memory")
      ? { sha: tree_sha, truncated: false, tree: [{ path: "f.md", type: "blob", sha: "body", size: 5 }] }
      : { sha: `${tree_sha.replace(/-root$/, "")}-root`, tree: [{ path: "memory", type: "tree", sha: `${tree_sha.replace(/-root$/, "")}-memory` }] },
  }));
  api.getBlob.mockResolvedValue({ data: { content: Buffer.from("hello").toString("base64") } });
  api.getContent.mockRejectedValue(Object.assign(new Error("Not Found"), { status: 404 }));
  api.createOrUpdateFileContents.mockResolvedValue({ data: { commit: { sha: "written-head", tree: { sha: "written-head-root" } } } });
  api.getCommit.mockResolvedValue({ data: { tree: { sha: "one-head-root" } } });
  api.createCommit.mockResolvedValue({ data: { sha: "empty-head" } });
  api.updateRef.mockResolvedValue({ data: {} });
});
afterEach(() => vi.restoreAllMocks());

describe("GitHub read views with real Next Data Cache", () => {
  it("keeps Next's actual pending-tag behavior in the test harness", async () => {
    const context = createNextDataCacheContext();
    const producer = vi.fn(async () => "same");
    await context.run(async () => {
      const read = () => cache.cachedFetch(["test", "mutable"], 300, ["test:tag"], producer);
      await read(); await context.flush();
      await read();
      expect(producer).toHaveBeenCalledTimes(1);
      cache.invalidate("test:tag");
      for (let i = 0; i < 3; i++) { await read(); await context.flush(); }
      expect(producer).toHaveBeenCalledTimes(4);
      expect(context.store.pendingRevalidatedTags).toContainEqual({ tag: "test:tag", profile: { expire: 0 } });
    });
  });

  it("refreshes the phase once after invalidation, not once per file", async () => {
    const context = createNextDataCacheContext();
    await context.run(async () => {
      await reads.readFileViaTree("memory/f.md", "one", "owner");
      await context.flush();
      reads.invalidateTreeCache("one", "owner");
      for (let i = 0; i < 100; i++) {
        expect(await reads.readFileViaTree("memory/f.md", "one", "owner")).toBe("hello");
        await context.flush();
      }
    });
    expect(api.getRef).toHaveBeenCalledTimes(2);
    expect(api.getTree).toHaveBeenCalledTimes(2);
    expect(api.getBlob).toHaveBeenCalledTimes(1);
  });

  it("uses the confirmed writer head without another ref read", async () => {
    const context = createNextDataCacheContext();
    await context.run(async () => {
      await reads.readFileViaTree("memory/f.md", "one", "owner");
      views.publishGitHubHead("one", "owner", { headSha: "new-head" });
      for (let i = 0; i < 100; i++) {
        await reads.readFileViaTree("memory/f.md", "one", "owner");
        await context.flush();
      }
    });
    expect(api.getRef).toHaveBeenCalledTimes(1);
    expect(api.getTree).toHaveBeenCalledTimes(4);
    expect(api.getBlob).toHaveBeenCalledTimes(1);
  });

  it("does not share an in-flight tree between different repositories", async () => {
    const context = createNextDataCacheContext();
    const [one, two] = await context.run(() => Promise.all([
      reads.getRepoTree("one", "owner"), reads.getRepoTree("two", "owner"),
    ]));
    expect(one.treeSha).toBe("one-head-memory");
    expect(two.treeSha).toBe("two-head-memory");
    expect(api.getRef).toHaveBeenCalledTimes(2);
    expect(api.getTree).toHaveBeenCalledTimes(4);
  });

  it("shares a live head once in an explicit phase without any Next request", async () => {
    await views.withGitHubReadView(async () => {
      const head = await views.getGitHubReadHead("one", "owner");
      for (let i = 0; i < 100; i++) {
        expect(await views.getGitHubReadHead("one", "owner")).toBe(head);
      }
    }, { fresh: true });
    expect(api.getRef).toHaveBeenCalledTimes(1);
  });

  it("does not retain an unscoped snapshot across separate no-store calls", async () => {
    await reads.getRepoTree("one", "owner");
    await reads.getRepoTree("one", "owner");
    expect(api.getRef).toHaveBeenCalledTimes(2);
    expect(api.getTree).toHaveBeenCalledTimes(4);
  });

  it("a nested writer advances its parent phase as well", async () => {
    await views.withGitHubReadView(async () => {
      expect((await views.getGitHubReadHead("one", "owner")).headSha).toBe("one-head");
      await views.withGitHubReadView(async () => {
        views.publishGitHubHead("one", "owner", { headSha: "new-head" });
      });
      expect((await views.getGitHubReadHead("one", "owner")).headSha).toBe("new-head");
    }, { fresh: true });
    expect(api.getRef).toHaveBeenCalledTimes(1);
  });

  it("seeds a durable basis only in the resumed phase without invalidating the parent", async () => {
    const context = createNextDataCacheContext();
    await context.run(() => views.withGitHubReadView(async () => {
      expect((await views.getGitHubReadHead("one", "owner")).headSha).toBe("one-head");
      await views.withGitHubReadView(async () => {
        views.seedGitHubReadHead("one", "owner", { headSha: "durable-basis" });
        expect((await views.getGitHubReadHead("one", "owner")).headSha).toBe("durable-basis");
        expect((await reads.getRepoTree("one", "owner")).treeSha).toBe("durable-basis-memory");
      });
      expect((await views.getGitHubReadHead("one", "owner")).headSha).toBe("one-head");
      expect(context.store.pendingRevalidatedTags).toBeUndefined();
    }, { fresh: true }));
    expect(api.getRef).toHaveBeenCalledTimes(1);
  });

  it("a real single-file writer publishes its confirmed head and expires the log tag", async () => {
    const context = createNextDataCacheContext();
    await context.run(async () => {
      await reads.getRepoTree("one", "owner");
      await writes.writeFile("memory/f.md", "hello", "one", "owner");
      expect(await views.getGitHubReadHead("one", "owner")).toEqual({ headSha: "written-head", treeSha: "written-head-root" });
      for (let i = 0; i < 5; i++) await reads.readFileViaTree("memory/f.md", "one", "owner");
      expect(context.store.pendingRevalidatedTags).toContainEqual({ tag: "tree:owner/one", profile: { expire: 0 } });
    });
    expect(api.getRef).toHaveBeenCalledTimes(1);
    expect(api.getTree).toHaveBeenCalledTimes(4);
    expect(api.createOrUpdateFileContents).toHaveBeenCalledTimes(1);
  });

  it("a real empty commit refreshes the log head while preserving the memory object", async () => {
    const context = createNextDataCacheContext();
    await context.run(async () => {
      const before = await reads.getRepoTree("one", "owner");
      expect(await batches.commitEmptyToGitHub("idle round", "one", "owner")).toBe("empty-head");
      expect((await views.getGitHubReadHead("one", "owner")).headSha).toBe("empty-head");
      expect(await reads.getRepoTree("one", "owner")).toEqual(before);
      expect(context.store.pendingRevalidatedTags).toContainEqual({ tag: "tree:owner/one", profile: { expire: 0 } });
    });
    // The branch probe for the empty write is explicit. The subsequent read
    // uses its returned SHA and never probes the mutable head a third time.
    expect(api.getRef).toHaveBeenCalledTimes(2);
    expect(api.getTree.mock.calls.filter(([args]) => args.recursive === "1")).toHaveLength(1);
  });
});
