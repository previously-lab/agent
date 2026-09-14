/**
 * The ONE place the Next.js Data Cache idiom lives.
 *
 * Every server-side cache in this app is an `unstable_cache` entry created
 * here. No other module imports `unstable_cache` or `revalidateTag` (or the
 * `fetch(..., { next: { revalidate } })` spelling of the same cache), and no
 * other module keeps a hand-rolled `Map` of cached payloads. The base read
 * utilities — `@/lib/tools/readFile`, `@/lib/tools/listFiles`, and their
 * local/demo siblings in `local-fs.ts` / `demo/demo-fs.ts` — are the ONLY
 * callers. Everything above them (episodic io-helpers and manager, agent tool
 * executors, server actions) reaches the cache by calling a base read; it
 * never caches its own copy of the result.
 *
 * WHY one module (this is not tidiness — it is a correctness rule): the Data
 * Cache is shared across instances and invalidated by TAG, while a module-
 * level Map is per-process and invalidated by nothing. Two caches over one
 * file do not agree — a write revalidates the tag, which the Map has never
 * heard of, so the Map keeps serving the pre-write bytes for the rest of its
 * TTL, and which copy you get depends on which code path ran. That is exactly
 * what the demo-mode `_indexCache` / `_bodyCache` in `episodic/manager.ts`
 * did before v0.10 (they were removed once `demo-fs.ts` cached the demo
 * backend properly). It is also why `ttlForPath` has an UNCACHED answer at
 * all rather than a short TTL for every backend.
 *
 * WHAT THE DATA CACHE IS NOT: a request-scoped memo. On a miss
 * `unstable_cache` runs the callback and stores the result; on a hit it
 * returns the stored copy and NEVER runs the callback (see
 * next/dist/server/web/spec-extension/unstable-cache.js, the `cacheEntry`
 * branch). Both are cross-request, cross-instance, and durable. So a read
 * that must observe something another instance wrote a moment ago cannot use
 * a cache hit at all — hence the ESCAPE FLAG (`fresh`).
 *
 * SCOPE NOTE (v0.10): this module covers the *base* read utilities only. Two
 * derived caches sit above them on purpose and are NOT folded in here:
 * `config/loader.ts`'s 60s parsed-config memo (it caches a parse, not a read)
 * and `demo-fs.ts`'s in-flight manifest promise (it dedupes concurrent
 * fetches, which `unstable_cache` does not — it has no single-flight on a
 * miss). Both read through the base utilities underneath.
 */

import { unstable_cache, revalidateTag } from "next/cache";
import type { DataSource } from "@/lib/data-source/resolve";

// ─── TTLs ────────────────────────────────────────────────────────────────

/**
 * The TTL table, by backend. Read `ttlForPath` for which row applies to a
 * given path — the numbers below are only meaningful next to that rule.
 */
export const CACHE_TTLS = {
  /**
   * GitHub: a slice's `core.md` / `previously.md` are written once, at close,
   * and never touched again (the checkpoint/recovery paths only ever read
   * them). 24h is a staleness bound for changes that bypass our write path
   * (a direct push to the memory repo), not a churn interval.
   */
  CLOSED_SLICE_SECONDS: 86_400,
  /**
   * GitHub: the global `timeline/index.json` and the monthly `_index.json`
   * are rewritten whenever a slice in their scope opens, closes or flushes,
   * so they get the shortest TTL of any GitHub read.
   */
  TIMELINE_INDEX_SECONDS: 60,
  /** GitHub: strands, user card, direction doc, evolution store, config. */
  MEMORY_DEFAULT_SECONDS: 300,
  /**
   * Demo, REMOTE transport only (`BENCHMARK_BASE_URL` — see demo-fs.ts): the
   * dataset repo (`previously-lab/you`) is read-only and published as a
   * finished snapshot. Nothing in this app can write it, nothing can race it,
   * and the benchmark data is fixed for the life of a deployment, so there is
   * no churn to bound — the TTL is long enough to make the persona cheap to
   * browse over the network. Only valid because that dataset is immutable to
   * everyone; the same repo read off a developer's own clone is NOT this case
   * and takes `DEMO_LOCAL_SECONDS`.
   */
  DEMO_SECONDS: 2_592_000,
  /**
   * Demo, LOCAL transport only: the sibling `../you` clone read off disk in
   * dev (see demo-fs.ts). The dataset is read-only to THIS app, but not to
   * whoever is running it — they edit that clone directly (an editor, a `git
   * checkout`, a `git pull`), and every one of those writes bypasses our write
   * path, so no tag is ever revalidated and a month-long entry would keep
   * serving the pre-edit bytes for a month. This is the `local` backend's
   * argument one step weaker: `local` is UNCACHED because it is a filesystem a
   * human is staring straight at, while this clone is still worth memoizing (a
   * persona browse re-reads the same paths), so it keeps a TTL and only the
   * length changes. 60s is the shortest bound the table uses anywhere (see
   * TIMELINE_INDEX_SECONDS) — long enough to keep the memo warm across a
   * render pass, short enough that an edit shows up without a server restart.
   */
  DEMO_LOCAL_SECONDS: 60,
  /**
   * Not a memory path: the one non-repository read in the app, the upstream
   * release tag the version badge checks (`version/actions.ts`). It was the
   * last `fetch(..., { next: { revalidate } })` in the codebase — the same
   * Data Cache under a second spelling — and 3600 is the interval it already
   * used. Nothing here is reachable by a writer, so there is no tag to
   * revalidate; the TTL is the whole policy.
   */
  RELEASE_CHECK_SECONDS: 3_600,
  /**
   * Not a TTL — the sentinel for "do not cache this read at all". Callers pass
   * it to `cachedFetch`, which then calls the reader directly; passing it to
   * `unstable_cache` would be an invariant violation (it throws on
   * `revalidate: 0`), so the sentinel never reaches it.
   */
  UNCACHED: 0,
} as const;

/** `memory/episodic/slices/YYYY/MM/_index.json` — see `ttlForPath`. */
const MONTHLY_INDEX = /^memory\/episodic\/slices\/\d{4}\/\d{2}\/_index\.json$/;

/**
 * Which transport the `demo` backend is reading its dataset through. The two
 * are the same repository and the same read-only contract FOR THIS APP, but
 * they are not the same cache target: one is a published snapshot nobody can
 * write, the other is a directory the developer edits. `ttlForPath` cannot
 * tell them apart by looking at a path, so the caller that picked the
 * transport (demo-fs.ts) states it.
 */
export type DemoTransport = "remote" | "local";

/**
 * Cache TTL for a path, by backend. Pure — unit-tested
 * (tests/lib/cache/data-cache.test.ts).
 *
 * The GitHub column reproduces the `READ_TTLS` table it absorbed from
 * readFile.ts — same numbers, same path classes, including the monthly-index
 * carve-out that table was last corrected for. The demo and local columns are
 * the reason this function is backend-aware at all: the same path means
 * something different on each, and on two of the three the answer is not a
 * shorter TTL but a different policy. See the `CACHE_TTLS` members for the
 * reasoning behind each number.
 *
 * `demo` is the one backend whose answer also depends on HOW it is read, so it
 * is the one that does not take the two-argument form: the transport is
 * required, and a bare `ttlForPath(path, "demo")` does not compile. Nothing
 * about a path reveals whether it came off the network or off a local clone,
 * and defaulting the argument would mean defaulting a month-long TTL onto a
 * file a developer edits — the exact bug this split exists to remove.
 */
export function ttlForPath(path: string, backend: Exclude<DataSource, "demo">): number;
export function ttlForPath(
  path: string,
  backend: "demo",
  transport: DemoTransport,
): number;
export function ttlForPath(
  path: string,
  backend: DataSource,
  transport?: DemoTransport,
): number {
  // ── local: UNCACHED, deliberately ──
  // A dev filesystem is written by processes that never touch our write path:
  // an editor, a `git checkout` in the memory root, the CLI in client/bridge
  // mode. Nothing revalidates a tag on any of those writes, so ANY TTL would
  // be a window of stale data on the one backend where a human is staring at
  // the file they just changed. Uncached local reads also match the behavior
  // that predates this module, so this preserves a decision rather than
  // omitting one. (Same reasoning as readFile.ts's original contract note.)
  if (backend === "local") return CACHE_TTLS.UNCACHED;

  // ── demo: one TTL for everything, chosen by TRANSPORT ──
  // The dataset is the same repo either way; what differs is who else can
  // write it. Remotely it is a finished snapshot no one can churn
  // (DEMO_SECONDS). On disk it is a clone the developer edits (see
  // DEMO_LOCAL_SECONDS) — the `local` argument above, one step weaker.
  if (backend === "demo") {
    return transport === "local"
      ? CACHE_TTLS.DEMO_LOCAL_SECONDS
      : CACHE_TTLS.DEMO_SECONDS;
  }

  // ── github: the per-path memory-file classes ──
  const normalized = path.replace(/\\/g, "/");
  // The MONTHLY index is the same class of file as the global one — it is
  // rewritten whenever a slice in that month opens, closes or flushes, and
  // `readSliceIndex` is how every boot scan finds slices. It used to fall
  // through to the closed-slice rule below, which is up to 24 hours of
  // staleness on a file the design calls mutable, so it is matched FIRST.
  if (MONTHLY_INDEX.test(normalized)) {
    return CACHE_TTLS.TIMELINE_INDEX_SECONDS;
  }
  if (normalized.startsWith("memory/episodic/slices/")) {
    return CACHE_TTLS.CLOSED_SLICE_SECONDS;
  }
  if (normalized === "memory/episodic/timeline/index.json") {
    return CACHE_TTLS.TIMELINE_INDEX_SECONDS;
  }
  return CACHE_TTLS.MEMORY_DEFAULT_SECONDS;
}

// ─── Tags ────────────────────────────────────────────────────────────────

/**
 * The tag factory: `<kind>:<identity>`. Tag names are the ONLY handle a
 * writer has on a cached read (`invalidate`), so they must be derivable from
 * the write's own arguments alone — no lookup, no registry, no shared state.
 * `fileCacheTag` in readFile.ts and `demoFileCacheTag` in demo-fs.ts are the
 * two concrete spellings.
 */
export function cacheTagFor(kind: string, identity: string): string {
  return `${kind}:${identity}`;
}

// ─── The cached read ─────────────────────────────────────────────────────

/**
 * Options accepted by every base read (`readFile`, `listFiles`, and the
 * local/demo readers), so a caller that does not know which backend it is
 * talking to — io-helpers, the agent tool executors — can still ask for the
 * escape. `fresh` is documented on `cachedFetch`; on an UNCACHED backend
 * (local) it is a no-op that exists only to keep the contract uniform.
 */
export interface ReadOptions {
  fresh?: boolean;
}

/** Stable first half of every Data Cache key from this module. */
const CACHE_KEY_PREFIX = "aftrbrez-data-cache";

/**
 * `unstable_cache` reports a missing store (unit tests, ad-hoc scripts, any
 * non-request server context) as an invariant error rather than degrading.
 * Both spellings we can hit are matched: the missing incremental cache, and
 * `revalidateTag`'s missing static generation store.
 */
const NO_DATA_CACHE_STORE = /incrementalCache missing/;

/**
 * The adapter handed to `unstable_cache`. It is a module-level function
 * because `unstable_cache` derives the fixed half of the cache key from
 * `cb.toString()` plus the key parts
 * (next/dist/server/web/spec-extension/unstable-cache.js:57, `fixedKey`), so
 * the callback's source text has to be the same for every cached read in the
 * app for one identity to mean one entry.
 */
async function runCached<T>(fn: () => Promise<T>): Promise<T> {
  return fn();
}

/**
 * Run `fn` through the Next Data Cache under `identity`.
 *
 * CONTRACT — `identity` must fully describe the computation. The arguments
 * reach the Data Cache as part of the key, but a function serializes to
 * `null` through `JSON.stringify`, so in practice the key is the identity
 * alone: two different callbacks filed under one identity share one entry.
 * Identity is therefore prose, not a hint — it names the backend, the kind of
 * read, and the full address of what is being read (`owner`, `repo`, persona,
 * path), including anything that has to be in the key but not in the tags.
 *
 * `tags` are what a writer revalidates afterwards; they do NOT have to match
 * the identity (readFile's file tag is `file:<owner>/<repo>:<path>`, which is
 * its own spelling of the same address).
 *
 * `ttlSeconds` is normally the output of `ttlForPath`. Passing
 * `CACHE_TTLS.UNCACHED` reads through with no cache entry at all.
 *
 * `opts.fresh` is the ESCAPE FLAG: read past the cache entirely and do NOT
 * write what comes back to it. Use it whenever the correctness of the caller
 * depends on the bytes on the other side right now — a re-read after a write
 * that another instance may have raced, or any read whose whole purpose is to
 * see something a cache hit would hide. Note it is not "read fresh and
 * refresh": the value returned is not stored, so a `fresh` read followed by a
 * normal read of the same path within a TTL window runs the reader twice.
 */
export async function cachedFetch<T>(
  identity: string[],
  ttlSeconds: number,
  tags: string[],
  fn: () => Promise<T>,
  opts?: { fresh?: boolean },
): Promise<T> {
  if (opts?.fresh || ttlSeconds === CACHE_TTLS.UNCACHED) {
    return fn();
  }

  // A fresh wrapper per call is deliberate, and free: the cache key is
  // derived from `runCached.toString()` + the key parts, both of which are
  // fixed by the identity, so two wrappers built for one identity address the
  // same entry. Memoizing the wrapper (as readFile.ts used to) buys nothing
  // and introduces a trap — the memoized wrapper would keep calling whichever
  // callback was bound to that identity first.
  const cached = unstable_cache(
    runCached,
    [CACHE_KEY_PREFIX, JSON.stringify(identity)],
    { revalidate: ttlSeconds, tags },
  );

  try {
    return await cached(fn);
  } catch (error) {
    // No Data Cache in this context — read directly instead of failing. The
    // store check happens BEFORE the callback runs, so `fn` has not been
    // called yet and this is not a second attempt at a real failure: an error
    // raised by `fn` itself (a 404, an oversized file) never carries this
    // message and is rethrown (readFile.ts's errors-are-never-cached rule —
    // `unstable_cache` stores the callback's result, so a thrown read leaves
    // no entry behind and a later success still fetches).
    if (error instanceof Error && NO_DATA_CACHE_STORE.test(error.message)) {
      return fn();
    }
    throw error;
  }
}

// ─── Invalidation ────────────────────────────────────────────────────────

/**
 * Expire cached entries by tag, so the next read of anything carrying one of
 * `tags` is a blocking miss — in this request and across instances, since the
 * Data Cache is shared (.next/cache on self-hosted Node).
 *
 * Safe to call with no Next request store in scope (a background step, a
 * unit test): `revalidateTag` throws an invariant error there and there is
 * nothing to revalidate anyway, so it is swallowed. A tag no cached read ever
 * used is also fine — revalidating an unknown tag is a no-op, not an error.
 */
export function invalidate(...tags: string[]): void {
  for (const tag of tags) {
    try {
      revalidateTag(tag, { expire: 0 });
    } catch {
      // No Next request store here — nothing to revalidate in this context.
    }
  }
}
