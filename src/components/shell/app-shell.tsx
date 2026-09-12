"use client";

/**
 * AppShell (v0.11) — the single-route shell that hosts both chat and timeline
 * views on `/`. The view is selected by the `?view=timeline` search param
 * (absent = chat view). The left time axis (AxisBand) is always mounted; the
 * right pane switches between the persistent chat stream and the timeline
 * scene. The chat stream stays MOUNTED when the timeline is open (hidden and
 * pointer-events-disabled) so Virtuoso scroll state and the live useChat stream
 * survive the view switch.
 *
 * Catalog loading is lazy: the timeline data layer (catalog window + strand
 * list) is fetched on the first switch to the timeline view. A deep link
 * `/?view=timeline&at=<sliceId>` loads the full catalog so the linked slice is
 * always resolvable, mirroring the old `/timeline` page behavior.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useSearchParams } from "next/navigation";
import { useReducedMotion } from "motion/react";
import { AnimatePresence, motion } from "motion/react";
import { useRouter } from "@/i18n/navigation";
import type { UserConfig } from "@/lib/config/types";
import type { TimelineSliceEntry } from "@/lib/episodic/timeline/types";
import type { StackLevel } from "@/lib/timeline3d/stacks";
import { DEFAULT_LEVEL } from "@/lib/timeline3d/stacks";
import type { FieldAnchor } from "@/lib/timeline3d/winding";
import {
  getStrandList,
  getTimelineCatalog,
  getTimelineCatalogPage,
  type StrandListItem,
} from "@/lib/episodic/actions";
import { modeFromSearch, parseAtParam } from "@/lib/chat/mode-switch";
import { ChatPage } from "@/components/chat/chat-page";
import { AxisBand } from "@/components/timeline-3d/axis-band";
import { TimelineScene } from "@/components/timeline-3d/timeline-scene";
import { TimelineFallback } from "@/components/timeline-3d/timeline-fallback";

interface AppShellProps {
  /** Server-preloaded user config passed through to ChatPage. */
  initialConfig?: UserConfig;
}

function detectWebGL(): boolean {
  try {
    const canvas = document.createElement("canvas");
    return Boolean(
      canvas.getContext("webgl2") ?? canvas.getContext("webgl"),
    );
  } catch {
    return false;
  }
}

export function AppShell({ initialConfig }: AppShellProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const rawSearch = searchParams.toString();
  const view = modeFromSearch(rawSearch);
  const at = parseAtParam(rawSearch);
  const reducedMotion = useReducedMotion() ?? false;

  // null = not yet checked (first client render matches the server shell).
  const [webgl, setWebgl] = useState<boolean | null>(null);
  useEffect(() => {
    setWebgl(detectWebGL());
  }, []);

  // ── Shared timeline state (owned by the shell so the left AxisBand and the
  //    right TimelineScene read the same refs). ─────────────────────────────
  const progressRef = useRef<number>(1);
  const zoomLevelRef = useRef<StackLevel>(DEFAULT_LEVEL);
  /** The zoom level, owned here so the floating lens switcher and the
   *  AxisBand read the same value CardField transitions through. A deep link
   *  (`?at=`) lands on slice level. */
  const [level, setLevel] = useState<StackLevel>(at ? 0 : DEFAULT_LEVEL);
  /** The current view's nodes as screen-Y fractions (0=top, 1=bottom) plus
   *  the strands each carries — CardField's row starts in timeline view, the
   *  chat stream's seam rows in chat view. The band winds its strand lines at
   *  these heights. */
  const anchorsRef = useRef<FieldAnchor[]>([]);
  const [strand, setStrand] = useState<string | null>(null);
  const [strandList, setStrandList] = useState<StrandListItem[]>([]);
  const [entries, setEntries] = useState<TimelineSliceEntry[]>([]);
  const [oldestMonth, setOldestMonth] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [timelineReady, setTimelineReady] = useState(false);
  const loadingRef = useRef(false);

  const selectedCount = useMemo(() => {
    if (!strand) return null;
    const item = strandList.find((s) => s.name === strand);
    return item?.count ?? null;
  }, [strand, strandList]);

  const ambientStrands = useMemo(
    () => strandList.slice(0, 12).map((s) => s.name),
    [strandList],
  );

  const range = useMemo(() => {
    const today = new Date().toISOString().slice(0, 10);
    if (entries.length === 0) return { oldest: today, now: today };
    return { oldest: entries[0].date, now: today };
  }, [entries]);

  // ── Strand list loads on mount in BOTH views (the axis focus chip lives in
  //    the always-mounted band); the catalog stays lazy for the timeline. ────
  useEffect(() => {
    if (strandList.length > 0) return;
    let cancelled = false;
    getStrandList()
      .then((strands) => {
        if (!cancelled) setStrandList(strands);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [strandList.length]);

  // ── Lazy catalog load on first timeline view (or a deep link that starts
  //    there). Mirrors the old /timeline page: `?at=` loads the full catalog;
  //    otherwise loads the latest month window. ─────────────────────────────
  useEffect(() => {
    if (view !== "timeline" || timelineReady) return;
    let cancelled = false;
    (async () => {
      try {
        if (at) {
          const catalog = await getTimelineCatalog();
          if (cancelled) return;
          setEntries(catalog);
          setOldestMonth(catalog[0]?.date.slice(0, 7) ?? null);
          setHasMore(false);
        } else {
          const page = await getTimelineCatalogPage(null);
          if (cancelled) return;
          setEntries(page.entries);
          setOldestMonth(page.oldestMonth);
          setHasMore(page.hasMore);
        }
        setTimelineReady(true);
      } catch {
        // A failed boot load leaves the fallback in place; the user can retry
        // by toggling the view.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [view, at, timelineReady]);

  const loadOlder = useCallback(async () => {
    if (!hasMore || loadingRef.current || !oldestMonth) return;
    loadingRef.current = true;
    try {
      const page = await getTimelineCatalogPage(oldestMonth);
      if (page.entries.length === 0) {
        setHasMore(false);
        return;
      }
      setEntries((prev) => {
        const have = new Set(prev.map((e) => e.id));
        const older = page.entries.filter((e) => !have.has(e.id));
        return older.length > 0 ? [...older, ...prev] : prev;
      });
      setOldestMonth(page.oldestMonth);
      setHasMore(page.hasMore);
    } catch {
      // A failed prefetch is silent: the list just finds no older rows and the
      // next edge approach retries.
    } finally {
      loadingRef.current = false;
    }
  }, [hasMore, oldestMonth]);

  const openSlice = useCallback(
    (sliceId: string, start?: string) => {
      // `atStart` carries the slice's ISO start — the chat page's jump
      // handler needs it for the travel clock and would otherwise spend a
      // full catalog fetch to learn it.
      const startParam = start
        ? `&atStart=${encodeURIComponent(start)}`
        : "";
      router.push(`/?at=${encodeURIComponent(sliceId)}${startParam}`);
    },
    [router],
  );

  const showTimeline = view === "timeline";

  return (
    <div className="flex h-dvh overflow-hidden">
      {/* LEFT: the time axis, present in BOTH views. It is not a timeline-view
          affordance — it is where the app's strands live, and it stays put
          across the switch (which also keeps the R3F canvas and its WebGL
          context alive, so the braid is never re-mounted). The right pane
          supplies the anchors either way: the card field's rows in the
          timeline, the chat stream's slice seams in chat, so the braid winds
          at whatever the user is actually looking at. */}
      {webgl === true && (
        <AxisBand
          showChrome={showTimeline}
          range={range}
          progressRef={progressRef}
          levelRef={zoomLevelRef}
          anchorsRef={anchorsRef}
          strand={strand}
          strandList={strandList}
          ambientStrands={ambientStrands}
          selectedCount={selectedCount}
          reducedMotion={reducedMotion}
          onSelectStrand={setStrand}
        />
      )}

      {/* RIGHT: chat stream (always mounted) + timeline overlay when active. */}
      <div className="relative flex-1 min-w-0 flex flex-col">
        <div
          className={`absolute inset-0 flex flex-col transition-opacity duration-300 ${
            showTimeline ? "opacity-30 pointer-events-none" : "opacity-100"
          }`}
        >
          <ChatPage
            initialConfig={initialConfig}
            suppressAtJump={showTimeline}
            anchorsRef={anchorsRef}
            anchorsActive={!showTimeline}
            progressRef={progressRef}
          />
        </div>

        <AnimatePresence>
          {showTimeline && (
            <motion.div
              key="timeline"
              initial={{ opacity: 0, x: 24 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 24 }}
              transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
              className="absolute inset-0 z-10 flex flex-col bg-background"
            >
              {/* Fallback → scene crossfade: the catalog arrival swaps a
                  structured skeleton for the live scene without a hard cut. */}
              <AnimatePresence mode="wait" initial={false}>
                {!timelineReady || webgl === null ? (
                  <motion.div
                    key="fallback"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: reducedMotion ? 0 : 0.25 }}
                    className="absolute inset-0"
                  >
                    <TimelineFallback />
                  </motion.div>
                ) : (
                  <motion.div
                    key="scene"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ duration: reducedMotion ? 0 : 0.25 }}
                    className="absolute inset-0"
                  >
                    <TimelineScene
                      entries={entries}
                      hasMore={hasMore}
                      onNeedOlder={loadOlder}
                      onOpenSlice={openSlice}
                      initialAtId={at ?? undefined}
                      strand={strand}
                      progressRef={progressRef}
                      levelRef={zoomLevelRef}
                      level={level}
                      onLevelChange={setLevel}
                      anchorsRef={anchorsRef}
                      reducedMotion={reducedMotion}
                      webgl={webgl}
                    />
                  </motion.div>
                )}
              </AnimatePresence>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
