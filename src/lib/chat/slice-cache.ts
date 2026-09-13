/**
 * The client's ONE cache for slice content (v0.10 C7).
 *
 * Two stacks used to page the same `memory/episodic/.../timeline/index.json`
 * with their own cursors AND their own content caches: the chat stream
 * (`useSliceStream`, persona-keyed pages of whole slices) and the 3D timeline
 * (`timeline-3d/slice-content.ts`, a per-slice LRU, one repository read per
 * mounted card). The same slice therefore lived in two places that could not
 * see each other — a card's preview and the conversation's copy of that slice
 * were two independent reads of one immutable file, and neither could spare
 * the other one.
 *
 * This module owns both concerns, over ONE entry per slice id. The guarantees
 * are the ones the two modules gave separately:
 *
 * - **Two faces, one entry.** They are not interchangeable: the CARD shows the
 *   slice's opening rounds (the server truncates to `FRAME_TURN_COUNT` turns
 *   because the card's frame is a fixed size — handed a whole conversation it
 *   would center on the middle of the slice), the CONVERSATION shows every
 *   turn. `SliceEntry.mode` states which completeness the entry holds.
 * - **A preview is UPGRADED IN PLACE.** A `full` read fills the same entry —
 *   never a second one — and keeps the preview face it found, so a mounted card
 *   neither re-fetches nor flashes back to a skeleton.
 * - **In-flight dedupe.** Two callers asking for the same slice share one
 *   request, and a `full` demand raised while that request is still QUEUED
 *   promotes it (`Job.require`), so a card and the conversation asking at the
 *   same moment cost one repository read rather than two.
 * - **A true LRU cap** (`CACHE_CAP`): a hit moves its key to the newest end,
 *   the trim evicts from the oldest.
 * - **Failures are sticky.** A failed read is not retried by the next
 *   subscriber — per-card retry loops are what that rule prevents.
 * - **A concurrency bound.** A fast scroll mounts a card per slice, and every
 *   miss is a `getContent` repository read behind a server action.
 */

import { getSliceContent, type SliceWithContent } from "@/lib/episodic/actions";
import type { Turn } from "@/lib/episodic/types";

// ─── Per-slice cache ────────────────────────────────────────────────────

/** `meta` = the card's truncated preview; `full` = every turn. A `full` read
 *  satisfies both: it ships the preview face too (`SliceContent.previewTurns`). */
export type SliceLoadMode = "meta" | "full";

/**
 * What the 3D card face renders — the shape `useSliceTurns` has always
 * returned, so `frame-card.tsx` needs nothing from this rework.
 */
export interface SlicePreview {
  state: "loading" | "ready" | "failed";
  turns?: Turn[];
  previously?: string | null;
  summary?: string;
  open_loops?: string[];
  decisions?: string[];
}

/** A cached slice, as a caller sees it. */
export interface SliceEntry {
  /**
   * Completeness actually held: `full` once every turn is cached, `meta` while
   * only the card's preview is, `null` while the first read is in flight or
   * after it failed.
   */
  mode: SliceLoadMode | null;
  /** The card face. Always present — the loading placeholder before the first
   *  read — so a subscriber never has to null-check it. */
  preview: SlicePreview;
  /** Every turn, or null while only the preview has been read. */
  full: Turn[] | null;
}

/**
 * Stable placeholder for "nothing here yet". Every loading slice shares this
 * one object, so a subscriber can setState it without a re-render storm. Treat
 * it as frozen.
 */
export const SLICE_LOADING: SlicePreview = { state: "loading" };

/** The card face's own failure state (sticky — see `satisfies`). */
const SLICE_FAILED: SlicePreview = { state: "failed" };

interface StoredEntry {
  preview: SlicePreview;
  full: Turn[] | null;
  /**
   * Sticky, and deliberately separate from the preview: a failed UPGRADE must
   * not blank a card that already holds its preview, and must not be re-issued
   * on every request.
   */
  fullFailed: boolean;
}

const CACHE_CAP = 200;

/**
 * How many slice reads may be in flight at once. A fast scroll mounts a card
 * per slice, and each miss is a repository read (core.md + previously.md in
 * parallel), so an unbounded fan-out is the burst the GitHub rate limiter reads
 * as abuse — the same reason the server bounds its own batch width.
 *
 * Exported so the bound is asserted against the constant rather than a copy of
 * its value.
 */
export const MAX_CONCURRENT_LOADS = 6;

const cache = new Map<string, StoredEntry>();
const inflight = new Map<string, Job>();
const listeners = new Map<string, Set<(entry: SliceEntry) => void>>();

let active = 0;
const waiting: Array<() => void> = [];

function acquirePermit(): Promise<void> {
  if (active < MAX_CONCURRENT_LOADS) {
    active += 1;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => waiting.push(resolve));
}

function releasePermit(): void {
  const next = waiting.shift();
  if (next) {
    // Hand the permit straight to the waiter: dropping the count first would
    // let a fresh caller race the woken one for the same freed slot.
    next();
    return;
  }
  active -= 1;
}

/** LRU touch — a hit moves its key to the newest end. */
function touch(id: string): void {
  const entry = cache.get(id);
  if (!entry) return;
  cache.delete(id);
  cache.set(id, entry);
}

function trimCache(): void {
  if (cache.size <= CACHE_CAP) return;
  // Map iteration order is insertion order; evict from the oldest end.
  const over = cache.size - CACHE_CAP;
  let removed = 0;
  for (const key of cache.keys()) {
    if (removed >= over) break;
    cache.delete(key);
    removed++;
  }
}

/** The entry for `id`, created empty if the cache has never seen it. */
function stored(id: string): StoredEntry {
  const entry = cache.get(id);
  if (entry) return entry;
  const fresh: StoredEntry = {
    preview: SLICE_LOADING,
    full: null,
    fullFailed: false,
  };
  cache.set(id, fresh);
  return fresh;
}

function view(entry: StoredEntry): SliceEntry {
  return {
    mode:
      entry.full !== null
        ? "full"
        : entry.preview.state === "ready"
          ? "meta"
          : null,
    preview: entry.preview,
    full: entry.full,
  };
}

/** Does this entry already answer `mode`? */
function satisfies(
  entry: StoredEntry | undefined,
  mode: SliceLoadMode,
): boolean {
  if (!entry) return false;
  if (mode === "full") return entry.full !== null || entry.fullFailed;
  // A failed preview is an ANSWER (sticky): that is what stops a mounted card
  // from re-requesting the same broken slice every time it remounts.
  return entry.preview.state !== "loading";
}

function publish(id: string): void {
  const set = listeners.get(id);
  if (!set || set.size === 0) return;
  const entry = cache.get(id);
  if (!entry) return;
  const snapshot = view(entry);
  for (const listener of set) listener(snapshot);
}

/** The cached entry for a slice, or null when the cache has never seen it. */
export function peekEntry(id: string): SliceEntry | null {
  const entry = cache.get(id);
  return entry ? view(entry) : null;
}

interface Job {
  /**
   * The requirement the ISSUED read must satisfy. Re-read when the permit is
   * granted (and again after each read), so a `full` demand raised while this
   * job is still queued turns into one `full` read instead of a second one.
   */
  require: SliceLoadMode;
  promise: Promise<SliceEntry>;
}

/**
 * Load a slice — the card's preview by default, every turn under `full`.
 * Resolves to the cache entry and never rejects: an unreadable slice is a
 * sticky `failed` preview, which is how the card face reports it.
 */
export function ensureSlice(
  id: string,
  mode: SliceLoadMode = "meta",
): Promise<SliceEntry> {
  touch(id);
  const entry = cache.get(id);
  if (satisfies(entry, mode)) return Promise.resolve(view(entry!));

  const pending = inflight.get(id);
  if (pending) {
    // Same slice, already on the wire: raise the bar for that one request
    // rather than start a second read of the same file.
    if (mode === "full") pending.require = "full";
    return pending.promise;
  }

  const job: Job = {
    require: mode,
    promise: Promise.resolve(view(stored(id))),
  };
  job.promise = run(id, job);
  inflight.set(id, job);
  return job.promise;
}

async function run(id: string, job: Job): Promise<SliceEntry> {
  await acquirePermit();
  try {
    for (;;) {
      const require = job.require;
      const payload = await getSliceContent(
        id,
        undefined,
        require === "full" ? { full: true } : undefined,
      ).catch(() => null);
      applyPayload(id, require, payload);
      trimCache();
      publish(id);

      const entry = cache.get(id)!;
      if (satisfies(entry, job.require)) return view(entry);
      // The requirement was raised while a `meta` read was ALREADY on the wire
      // (a card's preview in flight when the conversation asked for the slice).
      // A payload the server truncated cannot be un-truncated, so this costs
      // one more read — once for every caller, never once per caller.
      if (payload === null) return view(entry);
    }
  } finally {
    releasePermit();
    inflight.delete(id);
  }
}

function applyPayload(
  id: string,
  require: SliceLoadMode,
  payload: Awaited<ReturnType<typeof getSliceContent>>,
): void {
  const entry = stored(id);
  if (!payload) {
    // A failed preview IS the card face's own state; a failed upgrade keeps
    // whatever the entry already holds.
    if (require === "full") entry.fullFailed = true;
    else entry.preview = SLICE_FAILED;
    return;
  }
  entry.preview = {
    state: "ready",
    turns: payload.previewTurns ?? payload.turns,
    previously: payload.previously,
    summary: payload.summary,
    open_loops: payload.open_loops,
    decisions: payload.decisions,
  };
  if (require === "full") entry.full = payload.turns;
}

/**
 * Subscribe to one slice. Fires immediately with what the cache holds, starts
 * the read when it holds nothing, and fires again on every change — so a
 * preview upgraded by the paging path (or by another subscriber's request)
 * reaches every mounted card without a refetch.
 *
 * Returns the unsubscribe function.
 */
export function subscribeSlice(
  id: string,
  mode: SliceLoadMode,
  onChange: (entry: SliceEntry) => void,
): () => void {
  let set = listeners.get(id);
  if (!set) {
    set = new Set();
    listeners.set(id, set);
  }
  set.add(onChange);

  const current = peekEntry(id);
  if (current) onChange(current);

  void ensureSlice(id, mode).then((entry) => {
    if (listeners.get(id)?.has(onChange)) onChange(entry);
  });

  return () => {
    const live = listeners.get(id);
    if (!live) return;
    live.delete(onChange);
    if (live.size === 0) listeners.delete(id);
  };
}

/**
 * Hand the cache the FULL face of a slice it already holds. The chat's paging
 * and jump windows (`useSliceStream`) ship whole slices, and a card showing one
 * of them is the same conversation in two places — this is where the two
 * stacks' copies of a slice become one entry.
 *
 * A slice the cache has never seen is deliberately left alone: nothing is
 * rendering it, and seeding every page would push live previews out of the LRU
 * to cache content no surface asks for yet (the renderer wiring that consumes
 * the full face is the next phase's job).
 */
export function upgradeCachedSlice(id: string, turns: Turn[]): void {
  const entry = cache.get(id);
  if (!entry) return;
  if (entry.full !== null) return; // already whole — nothing to add
  entry.full = turns;
  entry.fullFailed = false;
  publish(id);
}

// ─── Unified-stream page cache (v0.10) ──────────────────────────────────
// The unified message flow pages whole slices-with-turns via
// getSlicePageWithContent. Snapshotting the loaded window per persona lets a
// remount (route change, timeline overlay round-trip) restore the stream
// instantly instead of re-paging from the newest end. Same TTL discipline:
// paged slices are closed and immutable, so only expiry evicts.

const TTL_MS = 5 * 60 * 1000; // 5 minutes

const streamCache = new Map<string, StreamCacheEntry>();

export interface StreamCacheEntry {
  slices: SliceWithContent[];
  hasMore: boolean;
  fetchedAt: number;
}

export function getStreamCache(persona: string): StreamCacheEntry | null {
  const entry = streamCache.get(persona);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > TTL_MS) {
    streamCache.delete(persona);
    return null;
  }
  return entry;
}

export function setStreamCache(
  persona: string,
  slices: SliceWithContent[],
  hasMore: boolean,
): void {
  streamCache.set(persona, { slices, hasMore, fetchedAt: Date.now() });
}
