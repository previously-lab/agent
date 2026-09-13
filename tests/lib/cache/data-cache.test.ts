import { describe, it, expect, vi, beforeEach } from "vitest";

const hoisted = vi.hoisted(() => {
  /** Stands in for the Next Data Cache store. */
  const cacheStore = new Map<string, unknown>();
  const mockRevalidateTag = vi.fn();
  /**
   * A REAL memo behind the cache spy, keyed the way Next keys it (the key
   * parts; the arguments add nothing here — see data-cache.ts). A passthrough
   * mock cannot tell "hit the cache" apart from "ran the reader again", and
   * the whole point of the `fresh` flag is that it does NEITHER.
   */
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
  return {
    cacheStore,
    /**
     * The stand-in filesystem. `reads` counts REAL disk reads, which is the
     * only honest signal that a read was served from the cache: a wrapper is
     * built per call by design (see data-cache.ts), so counting calls to
     * `unstable_cache` counts calls, not misses.
     */
    disk: { content: "", reads: 0 },
    mockRevalidateTag,
    mockUnstableCache,
  };
});

vi.mock("next/cache", () => ({
  unstable_cache: hoisted.mockUnstableCache,
  revalidateTag: hoisted.mockRevalidateTag,
}));

// fs is mocked so `demo-fs.ts` can be driven without a dataset on disk: the
// cache decision (does a second read hit the Data Cache?) is what is under
// test, not the dataset or how its path is spelled on this platform.
vi.mock("fs", () => ({
  existsSync: () => true,
  readFileSync: () => {
    hoisted.disk.reads += 1;
    return hoisted.disk.content;
  },
  readdirSync: () => [],
  statSync: () => ({ isDirectory: () => false, isFile: () => true, size: 10 }),
}));

import {
  CACHE_TTLS,
  cacheTagFor,
  cachedFetch,
  invalidate,
  ttlForPath,
} from "@/lib/cache/data-cache";
import { readFileDemo, setDemoPersona } from "@/lib/demo/demo-fs";

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.cacheStore.clear();
  hoisted.disk.content = "";
  hoisted.disk.reads = 0;
});

// ─── ttlForPath: the three backends ──────────────────────────────────────

describe("ttlForPath — github", () => {
  it("caches closed slice files for a day (immutable)", () => {
    expect(
      ttlForPath("memory/episodic/slices/2026-01/slice-abc/core.md", "github")
    ).toBe(CACHE_TTLS.CLOSED_SLICE_SECONDS);
    expect(
      ttlForPath("memory/episodic/slices/2026-01/slice-abc/previously.md", "github")
    ).toBe(CACHE_TTLS.CLOSED_SLICE_SECONDS);
    expect(
      ttlForPath("memory/episodic/slices/2026-01/slice-abc/core.md", "github")
    ).toBe(86_400);
  });

  it("uses a short TTL for the timeline index (mutates on open/close)", () => {
    expect(ttlForPath("memory/episodic/timeline/index.json", "github")).toBe(
      CACHE_TTLS.TIMELINE_INDEX_SECONDS
    );
    expect(ttlForPath("memory/episodic/timeline/index.json", "github")).toBe(60);
  });

  it("treats the MONTHLY index as mutable, not as a closed slice", () => {
    // It lives under `slices/`, so it used to inherit the 24-hour rule meant
    // for immutable closed slices — on a file rewritten every time a slice in
    // that month opens, closes or flushes.
    expect(ttlForPath("memory/episodic/slices/2026/08/_index.json", "github")).toBe(60);
  });

  it("uses a moderate TTL for other memory files", () => {
    expect(ttlForPath("memory/episodic/strands.json", "github")).toBe(
      CACHE_TTLS.MEMORY_DEFAULT_SECONDS
    );
    expect(ttlForPath("memory/episodic/current-previously.md", "github")).toBe(
      CACHE_TTLS.MEMORY_DEFAULT_SECONDS
    );
    expect(ttlForPath("memory/user/card.md", "github")).toBe(300);
    expect(ttlForPath("memory/evolution/direction.md", "github")).toBe(300);
  });

  it("normalizes backslashes before classifying", () => {
    expect(
      ttlForPath("memory\\episodic\\slices\\2026-01\\slice-a\\core.md", "github")
    ).toBe(CACHE_TTLS.CLOSED_SLICE_SECONDS);
  });
});

describe("ttlForPath — demo", () => {
  it("caches everything for 30 days, whatever the path", () => {
    // The demo dataset is a published read-only snapshot, so the path classes
    // that bound staleness on GitHub have nothing to bound here.
    for (const path of [
      "memory/episodic/timeline/index.json",
      "memory/episodic/slices/2026/08/_index.json",
      "memory/episodic/slices/2026-01/slice-a/core.md",
      "memory/user/config.json",
      "memory/evolution/direction.md",
    ]) {
      expect(ttlForPath(path, "demo")).toBe(CACHE_TTLS.DEMO_SECONDS);
      expect(ttlForPath(path, "demo")).toBe(2_592_000);
    }
  });
});

describe("ttlForPath — local", () => {
  it("caches nothing, whatever the path", () => {
    // Deliberate: a dev filesystem is written by processes that never touch
    // our write path, so no tag is ever revalidated and any TTL would serve a
    // stale copy of the file the developer is looking at.
    for (const path of [
      "memory/episodic/timeline/index.json",
      "memory/episodic/slices/2026-01/slice-a/core.md",
      "memory/user/config.json",
    ]) {
      expect(ttlForPath(path, "local")).toBe(CACHE_TTLS.UNCACHED);
      expect(ttlForPath(path, "local")).toBe(0);
    }
  });
});

// ─── Tags ────────────────────────────────────────────────────────────────

describe("cacheTagFor", () => {
  it("is kind + identity", () => {
    expect(cacheTagFor("file", "owner/repo:memory/f.md")).toBe(
      "file:owner/repo:memory/f.md"
    );
  });
});

// ─── cachedFetch ─────────────────────────────────────────────────────────

describe("cachedFetch", () => {
  it("caches the reader's result under the identity", async () => {
    const reader = vi.fn(async () => "v1");

    const first = await cachedFetch(["github", "file", "x"], 300, ["file:x"], reader);
    const second = await cachedFetch(["github", "file", "x"], 300, ["file:x"], reader);

    expect(first).toBe("v1");
    expect(second).toBe("v1");
    expect(reader).toHaveBeenCalledTimes(1);
    expect(hoisted.mockUnstableCache).toHaveBeenCalledWith(
      expect.any(Function),
      ["aftrbrez-data-cache", JSON.stringify(["github", "file", "x"])],
      { revalidate: 300, tags: ["file:x"] },
    );
  });

  it("does not share an entry between identities", async () => {
    const a = vi.fn(async () => "a");
    const b = vi.fn(async () => "b");

    await cachedFetch(["github", "file", "a"], 300, [], a);
    await cachedFetch(["github", "file", "b"], 300, [], b);

    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("does not cache at CACHE_TTLS.UNCACHED", async () => {
    const reader = vi.fn(async () => "v1");

    await cachedFetch(["local", "file", "x"], CACHE_TTLS.UNCACHED, [], reader);
    await cachedFetch(["local", "file", "x"], CACHE_TTLS.UNCACHED, [], reader);

    expect(reader).toHaveBeenCalledTimes(2);
    expect(hoisted.mockUnstableCache).not.toHaveBeenCalled();
  });

  describe("the fresh escape flag", () => {
    it("reads past the cache", async () => {
      const reader = vi.fn(async () => "v1");
      await cachedFetch(["github", "file", "x"], 300, [], reader);

      reader.mockResolvedValue("v2");
      const fresh = await cachedFetch(["github", "file", "x"], 300, [], reader, {
        fresh: true,
      });

      expect(fresh).toBe("v2");
      expect(reader).toHaveBeenCalledTimes(2);
    });

    it("does NOT write what it read back to the cache", async () => {
      const reader = vi.fn(async () => "v1");
      await cachedFetch(["github", "file", "x"], 300, [], reader);

      // A fresh read must not refresh the entry: the next cached read still
      // sees the value the first (non-fresh) read stored.
      reader.mockResolvedValue("v2");
      await cachedFetch(["github", "file", "x"], 300, [], reader, { fresh: true });

      const cached = await cachedFetch(["github", "file", "x"], 300, [], reader);
      expect(cached).toBe("v1");
      expect(reader).toHaveBeenCalledTimes(2);
    });

    it("never touches the cache machinery at all", async () => {
      const reader = vi.fn(async () => "v1");
      await cachedFetch(["github", "file", "x"], 300, [], reader, { fresh: true });

      expect(hoisted.mockUnstableCache).not.toHaveBeenCalled();
    });
  });

  it("degrades to a direct read when there is no Data Cache store", async () => {
    // What unit tests, script contexts, and any non-request server context
    // look like: unstable_cache throws its missing-store invariant before the
    // callback runs.
    hoisted.mockUnstableCache.mockImplementationOnce(() => async () => {
      throw new Error("Invariant: incrementalCache missing in unstable_cache");
    });
    const reader = vi.fn(async () => "direct");

    expect(await cachedFetch(["github", "file", "x"], 300, [], reader)).toBe("direct");
    expect(reader).toHaveBeenCalledTimes(1);
  });

  it("does not treat a reader failure as a missing store", async () => {
    const reader = vi.fn(async () => {
      throw new Error("File not found: memory/f.md");
    });

    await expect(
      cachedFetch(["github", "file", "x"], 300, [], reader)
    ).rejects.toThrow("File not found");
    // Not retried as a fallback read — an error raised by the reader is the
    // answer, and (since unstable_cache stores only results) it is not cached.
    expect(reader).toHaveBeenCalledTimes(1);
  });
});

// ─── invalidate ──────────────────────────────────────────────────────────

describe("invalidate", () => {
  it("revalidates every tag with immediate expiry", () => {
    invalidate("file:a", "file:b");

    expect(hoisted.mockRevalidateTag).toHaveBeenCalledTimes(2);
    expect(hoisted.mockRevalidateTag).toHaveBeenCalledWith("file:a", { expire: 0 });
    expect(hoisted.mockRevalidateTag).toHaveBeenCalledWith("file:b", { expire: 0 });
  });

  it("is a safe no-op when there is no Next request store", () => {
    hoisted.mockRevalidateTag.mockImplementation(() => {
      throw new Error("Invariant: static generation store missing in revalidateTag");
    });

    expect(() => invalidate("file:a")).not.toThrow();
  });

  it("swallows a failure for one tag without skipping the rest", () => {
    hoisted.mockRevalidateTag
      .mockImplementationOnce(() => {
        throw new Error(
          "Invariant: static generation store missing in revalidateTag"
        );
      })
      .mockImplementationOnce(() => undefined);

    invalidate("file:a", "file:b");

    expect(hoisted.mockRevalidateTag).toHaveBeenCalledTimes(2);
  });
});

// ─── the demo backend, cached through this module ────────────────────────

describe("demo reads go through the cache", () => {
  it("serves a repeated demo read from the cache, at the demo TTL", async () => {
    setDemoPersona("user");
    hoisted.disk.content = '{"a":1}';

    const first = await readFileDemo("memory/episodic/strands.json");
    const second = await readFileDemo("memory/episodic/strands.json");

    expect(first).toBe('{"a":1}');
    expect(second).toBe('{"a":1}');
    expect(hoisted.disk.reads).toBe(1);
    expect(hoisted.mockUnstableCache.mock.calls[0][2]).toEqual({
      revalidate: CACHE_TTLS.DEMO_SECONDS,
      tags: ["demo-file:user:memory/episodic/strands.json"],
    });
  });

  it("keys the cache by persona, not just by path", async () => {
    // `currentPersona` is module state set from the URL during SSR; without
    // the persona in the identity one persona's slice answers another's read
    // (what the removed manager Maps guarded with a persona key prefix).
    setDemoPersona("user");
    await readFileDemo("memory/episodic/strands.json");
    expect(hoisted.disk.reads).toBe(1);

    setDemoPersona("alice");
    await readFileDemo("memory/episodic/strands.json");

    expect(hoisted.disk.reads).toBe(2);
    expect(JSON.stringify(hoisted.mockUnstableCache.mock.calls[1][1])).toContain(
      "alice"
    );
  });

  it("reads past the cache on the escape flag", async () => {
    setDemoPersona("user");
    hoisted.disk.content = "before";

    await readFileDemo("memory/episodic/strands.json");
    hoisted.disk.content = "after";
    const fresh = await readFileDemo("memory/episodic/strands.json", undefined, {
      fresh: true,
    });

    expect(fresh).toBe("after");
    expect(hoisted.disk.reads).toBe(2);
  });
});
