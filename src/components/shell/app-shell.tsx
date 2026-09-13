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
import type { CrossingMark } from "@/components/chat/conversation-field";
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

export function AppShell({ initialConfig }: AppShellProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const rawSearch = searchParams.toString();
  const view = modeFromSearch(rawSearch);
  const at = parseAtParam(rawSearch);
  const reducedMotion = useReducedMotion() ?? false;

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
  /** Where the announcing slice boundary sits, for the band's anchor dot. The
   *  foreground field fills it — the conversation field in chat, the card
   *  field in the timeline. */
  const crossingRef = useRef<CrossingMark>({ y: null });
  /** The strand picks, in the order they were added. An EMPTY list is 核心时间线
   *  — the unfiltered timeline — which is why this is a list and not a nullable
   *  name: "nothing selected" is a real state, not the absence of one. */
  const [strands, setStrands] = useState<string[]>([]);
  const [strandList, setStrandList] = useState<StrandListItem[]>([]);
  const [entries, setEntries] = useState<TimelineSliceEntry[]>([]);
  const [oldestMonth, setOldestMonth] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [timelineReady, setTimelineReady] = useState(false);
  const loadingRef = useRef(false);

  // Only meaningful for a SINGLE pick: with several, the counts overlap (a
  // slice can carry two chosen strands) and summing them would overcount. A
  // number that can be wrong is worse than no number, so several picks show
  // names and no count.
  const selectedCount = useMemo(() => {
    if (strands.length !== 1) return null;
    return strandList.find((s) => s.name === strands[0])?.count ?? null;
  }, [strands, strandList]);

  const toggleStrand = useCallback((name: string) => {
    setStrands((prev) =>
      prev.includes(name) ? prev.filter((s) => s !== name) : [...prev, name],
    );
  }, []);
  const clearStrands = useCallback(() => setStrands([]), []);

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

  // ── THE SHELL IS STILL TWO VIEWS, AND THAT IS THE NEXT THING TO GO ────────
  // `ChatPage` and `TimelineScene` are both mounted here, one dimmed behind the
  // other, and `?view=` picks which. They are the same thing at two
  // granularities — a conversation block is one slice plus its closing gate
  // (`field-blocks.ts`), and an L0 card row is one slice (`stacks.ts`) — so the
  // target is ONE field whose zoom picks the component each unit wears, with
  // the conversation as its finest rung and the slice/day/week cards above it.
  //
  // The ground for that is already laid and should not be re-laid:
  //   - `src/lib/timeline3d/field-offsets.ts` is the ONE running offset table
  //     (`buildOffsets` carries a measured height, a formula, or both).
  //   - `gateBands` in `src/lib/chat/field-blocks.ts` builds the boundary
  //     bands for any unit list, so the conversation's intertitle can render at
  //     the card rungs too.
  //   - The camera is the last piece: `card-field.tsx` still runs at
  //     `CAM_Z = 9` with `worldPerPxForField`, while the conversation field is
  //     orthographic at 1 world unit = 1 CSS px. Derive `CAM_Z` from the
  //     viewport height (`H / (2·tan(fov/2))`) and the two coordinate systems
  //     become the same one — `wpp ≡ 1`. SET `near`/`far` WHEN YOU DO: R3F's
  //     default `far = 1000` clips the whole field once the camera distance is
  //     derived that way (it is 1.87·H, so any viewport over ~536 px tall).
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
      <AxisBand
        showChrome={showTimeline}
        range={range}
        progressRef={progressRef}
        levelRef={zoomLevelRef}
        anchorsRef={anchorsRef}
        crossingRef={crossingRef}
        strands={strands}
        strandList={strandList}
        ambientStrands={ambientStrands}
        selectedCount={selectedCount}
        reducedMotion={reducedMotion}
        onToggleStrand={toggleStrand}
        onClearStrands={clearStrands}
      />

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
            crossingRef={crossingRef}
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
              {/* Catalog-loading crossfade: the arrival swaps a structured
                  skeleton for the live scene without a hard cut. */}
              <AnimatePresence mode="wait" initial={false}>
                {!timelineReady ? (
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
                      strands={strands}
                      progressRef={progressRef}
                      levelRef={zoomLevelRef}
                      level={level}
                      onLevelChange={setLevel}
                      anchorsRef={anchorsRef}
                      crossingRef={crossingRef}
                      reducedMotion={reducedMotion}
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
