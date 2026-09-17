"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  getSliceJumpWindow,
  getSlicePageWithContent,
  type SliceWithContent,
} from "@/lib/episodic/actions";
import { prependPage } from "@/lib/chat/stream-items";

/** Slices per page — a page is also the seam-anchored prepend unit (§1.4). */
export const SLICE_PAGE_SIZE = 10;
/** Safety bound for the "page until the target slice is loaded" jump loop —
 *  sparse catalogs could otherwise page forever (design §10). */
const MAX_JUMP_PAGES = 50;

export interface SliceStream {
  /** Loaded historical slices, oldest → newest (the still-alive newest slice
   *  is excluded when `before` pins the initial cursor — see chat-page). */
  slices: SliceWithContent[];
  hasMore: boolean;
  loadingOlder: boolean;
  /** True once the first page has landed. */
  initialLoaded: boolean;
  /**
   * Prepend one older page. Resolves to the exact number of STREAM ITEMS the
   * prepend adds (seams + turns) — informational for the caller's paging
   * logic; the DOM stream holds the reader's place by compensating its
   * scroll position with the page's measured height, so no index delta is
   * needed. 0 when nothing was added (exhausted, in flight, or a failed
   * fetch).
   */
  loadOlder: () => Promise<number>;
  /**
   * Page backwards until `sliceId` is loaded (wheel jump to an unloaded
   * slice). `onPrepend` fires after each page with the exact stream-item
   * delta. Resolves true when the slice is in the loaded window; false when
   * the catalog was exhausted (or paging stalled) without it.
   */
  loadUntilSlice: (
    sliceId: string,
    onPrepend?: (addedItemCount: number) => void,
  ) => Promise<boolean>;
}

/**
 * Catalog-paged slice window for the unified message stream (v0.10 §1.5/§1.6).
 *
 * `initialBefore` pins the FIRST page's cursor (ISO `start` exclusive): the
 * chat page passes the resumed slice's start so the still-alive slice never
 * double-renders (its turns arrive via getArrivalState / the reconnect stash).
 *
 * The window starts EMPTY and is paged in on mount. It used to be restored
 * synchronously from a per-persona snapshot in `slice-cache` (5 min TTL), and
 * that restore is gone with the rest of the client's cache (v0.10 C7): the
 * client holds nothing, the server action reads the catalog and the server
 * caches it, and a remount pays one paging call rather than trusting a
 * client-side copy of a catalog that may have gained a slice since.
 */
export function useSliceStream(
  persona: string,
  initialBefore: string | null,
): SliceStream {
  const [slices, setSlices] = useState<SliceWithContent[]>([]);
  const [hasMore, setHasMore] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [initialLoaded, setInitialLoaded] = useState(false);

  // Refs mirror the state so the async callbacks never close over staleness.
  const slicesRef = useRef<SliceWithContent[]>([]);
  const hasMoreRef = useRef(true);
  const loadingRef = useRef(false);
  // The cursor for the NEXT page: the oldest loaded slice's start, or the
  // initial pin while nothing is loaded yet.
  const initialBeforeRef = useRef<string | null>(initialBefore);

  const applyPage = useCallback(
    (page: { slices: SliceWithContent[]; hasMore: boolean }): number => {
      const { slices: next, addedItemCount } = prependPage(
        slicesRef.current,
        page.slices,
      );
      slicesRef.current = next;
      hasMoreRef.current = page.hasMore;
      setSlices(next);
      setHasMore(page.hasMore);
      return addedItemCount;
    },
    // Every read and write goes through a ref, so this is stable for the life
    // of the mount — and it must be: `loadOlder` depends on it, and the
    // initial-fill effect depends on `loadOlder`.
    [],
  );

  const loadOlder = useCallback(async (): Promise<number> => {
    if (loadingRef.current || !hasMoreRef.current) return 0;
    loadingRef.current = true;
    setLoadingOlder(true);
    try {
      const cursor =
        slicesRef.current.length > 0
          ? slicesRef.current[0].start
          : initialBeforeRef.current;
      const page = await getSlicePageWithContent(
        cursor,
        SLICE_PAGE_SIZE,
        persona,
      );
      return applyPage(page);
    } catch {
      return 0; // paging is best-effort — the next scroll retries
    } finally {
      loadingRef.current = false;
      setLoadingOlder(false);
    }
  }, [persona, applyPage]);

  const loadUntilSlice = useCallback(
    async (
      sliceId: string,
      onPrepend?: (addedItemCount: number) => void,
    ): Promise<boolean> => {
      // A jump can race the initial fill (or a startReached page): never
      // mistake "another page is in flight" for a failed fetch — wait it out.
      const waitForIdle = () =>
        new Promise<void>((resolve) => {
          const check = () =>
            loadingRef.current ? setTimeout(check, 50) : resolve();
          check();
        });
      if (slicesRef.current.some((s) => s.id === sliceId)) return true;
      if (!hasMoreRef.current) return false;
      await waitForIdle();
      if (slicesRef.current.some((s) => s.id === sliceId)) return true;

      // Fast path: ONE server round trip loads the whole missing stretch
      // between the target and the loaded window (the server reads the
      // timeline index once and loads every slice file in parallel). The
      // result prepends as a single page, so the stream compensates once.
      if (!loadingRef.current) {
        loadingRef.current = true;
        setLoadingOlder(true);
        try {
          const win = await getSliceJumpWindow(
            sliceId,
            slicesRef.current[0]?.id ?? null,
            persona,
          );
          if (win.found && win.slices.length > 0) {
            const added = applyPage(win);
            onPrepend?.(added);
          }
          // found:false (index lag — the target isn't catalogued yet) or a
          // thrown call both fall through to the page loop below.
        } catch {
          // Server hiccup — the page loop retries, one page at a time.
        } finally {
          loadingRef.current = false;
          setLoadingOlder(false);
        }
        if (slicesRef.current.some((s) => s.id === sliceId)) return true;
      }

      // Fallback: page one at a time (index lag, a failed batch call, or the
      // batch's cap left the target beyond the window — the loop continues
      // from the batch's new head).
      for (let i = 0; i < MAX_JUMP_PAGES; i++) {
        if (slicesRef.current.some((s) => s.id === sliceId)) return true;
        if (!hasMoreRef.current) return false;
        if (loadingRef.current) {
          await waitForIdle();
          continue;
        }
        const beforeCount = slicesRef.current.length;
        const added = await loadOlder();
        // No progress (exhausted mid-loop or a failed fetch) — stop instead
        // of hammering the server for the remaining page budget.
        if (slicesRef.current.length === beforeCount) return false;
        onPrepend?.(added);
      }
      return slicesRef.current.some((s) => s.id === sliceId);
    },
    [loadOlder, persona, applyPage],
  );

  // Initial fill. (Persona is fixed per mount: it comes from the URL and a
  // switch reloads the page state, which is also why nothing here resets the
  // window when it changes.)
  useEffect(() => {
    let cancelled = false;
    void loadOlder().finally(() => {
      if (!cancelled) setInitialLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, [persona, loadOlder]);

  return { slices, hasMore, loadingOlder, initialLoaded, loadOlder, loadUntilSlice };
}
