"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type RefObject,
} from "react";
import { Virtuoso, type VirtuosoHandle, type ListRange } from "react-virtuoso";
import type { UIMessage } from "ai";
import { Loader2, History } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { ChatMessage } from "./chat-message";
import { HistoryTurn } from "./history-turn";
import { SliceSeam, formatSeamDate } from "./slice-seam";
import { StreamTimeIndicator } from "./stream-time-indicator";
import { EmptyBriefing } from "./empty-briefing";
import { ErrorBanner } from "./error-banner";
import { ResumeBanner } from "./resume-banner";
import { ConversationField, type ConversationFieldHandle } from "./conversation-field";
import { useIsMobile } from "@/hooks/use-is-mobile";
import type { HistoryStreamItem } from "@/lib/chat/stream-items";
import type { FieldAnchor } from "@/lib/timeline3d/winding";
import type { SliceSummary } from "@/lib/episodic/actions";

/** A live message rendered through the full chat renderer (tool states,
 *  housekeeping cards, phase indicators — design §1.2's live/history split).
 *  Display props are precomputed by the parent so items stay plain data. */
import type { ChatStreamItem } from "@/lib/chat/stream-items";
export type { ChatStreamItem } from "@/lib/chat/stream-items";

/** How long after the scroll stops before the time indicator fades (§1.3). */
const INDICATOR_HOLD_MS = 1000;

interface UnifiedChatStreamProps {
  items: ChatStreamItem[];
  firstItemIndex: number;
  loadingOlder: boolean;
  /** Fired when the scroller reaches the top — the parent pages older slices
   *  and shifts firstItemIndex by the returned count. */
  onStartReached: () => void;
  error: Error | undefined;
  virtuosoRef: RefObject<VirtuosoHandle | null>;
  /** Reports the top visible item's time (the travel clock's "from") and the
   *  slice it belongs to (the mode switcher's `?at=` anchor; null = live). */
  onTopItemChange?: (timeIso: string, sliceId: string | null) => void;
  /** Briefing-mode arrival card props (§1.2 Rev 2). When set, the parent seats
   *  a `briefing` item at the stream tail and it renders through these. */
  briefing?: {
    persona?: string;
    active: SliceSummary | null;
    recent: SliceSummary[];
    onSend: (message: string) => void;
  } | null;
  /** Shared strand-field anchors owned by the app shell — the band winds each
   *  strand at these heights. Chat-mode counterpart of the card field's
   *  row-start anchors (timeline view): one anchor per visible slice seam,
   *  carrying that slice's strands. */
  anchorsRef?: MutableRefObject<FieldAnchor[]>;
  /** True only when the chat view is the FOREGROUND view. The stream stays
   *  mounted (dimmed) while the timeline is open, but the timeline's CardField
   *  owns the ref then — no measuring here, the two would fight. */
  anchorsActive?: boolean;
  /** Shared 0..1 progress for the band — only the field publishes it. */
  progressRef?: MutableRefObject<number>;
  /** Render as a camera-navigated field instead of a Virtuoso list. Both paths
   *  stay in the tree so the field can be switched off with `?field=0` and
   *  compared against the old behaviour on the same data. */
  useField?: boolean;
  /** Filled by the field with its imperative handle. Only meaningful when
   *  `useField` is on — the Virtuoso path is driven through `virtuosoRef`. */
  fieldApiRef?: MutableRefObject<ConversationFieldHandle | null>;
}

/** The "继续 <date> 的对话" banner now lives in its own module — the
 *  conversation field renders it too, and it must not have to import this
 *  file to get a presentational pill. */

/**
 * The unified message stream (v0.10 §1): ONE continuous, virtualized,
 * bottom-anchored list — historical slice blocks (seam header + plain-body
 * turns) above, live turns below. Pure presentation: the parent owns the
 * items, the paging and the firstItemIndex bookkeeping.
 */
export function UnifiedChatStream({
  items,
  firstItemIndex,
  loadingOlder,
  onStartReached,
  error,
  virtuosoRef,
  onTopItemChange,
  briefing,
  anchorsRef,
  anchorsActive,
  progressRef,
  useField,
  fieldApiRef,
}: UnifiedChatStreamProps) {
  const tSeam = useTranslations("chat.seam");

  // ── Scroll-transient time chrome (§1.3): floating indicator on mobile.
  //  (The desktop left time rail was retired — the 3D axis carries time.)
  // rAF-throttled read of the top visible item (the wheel's scroll-throttle
  // precedent), shown while scrolling, faded 1s after it stops.
  const [indicatorTime, setIndicatorTime] = useState<string | null>(null);
  const [indicatorVisible, setIndicatorVisible] = useState(false);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const firstIndexRef = useRef(firstItemIndex);
  firstIndexRef.current = firstItemIndex;
  const onTopItemChangeRef = useRef(onTopItemChange);
  onTopItemChangeRef.current = onTopItemChange;
  const rafRef = useRef<number | null>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleRangeChanged = useCallback((range: ListRange) => {
    if (rafRef.current !== null) return; // one read per frame
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      const rel = range.startIndex - firstIndexRef.current;
      const item = itemsRef.current[rel] ?? itemsRef.current[0];
      if (!item) return;
      setIndicatorTime(item.timeIso);
      // The slice the top item belongs to — seam/resume keys carry the NEWER
      // slice's id ("seam-<id>" / "resume-<id>", see stream-items.ts); live
      // items are "now" (null).
      const sliceId =
        item.kind === "history-turn"
          ? item.sliceId
          : item.kind === "seam"
            ? item.key.slice("seam-".length)
            : item.kind === "resume-banner"
              ? item.key.slice("resume-".length)
              : null;
      onTopItemChangeRef.current?.(item.timeIso, sliceId);
    });
  }, []);

  const handleIsScrolling = useCallback((scrolling: boolean) => {
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    if (scrolling) {
      setIndicatorVisible(true);
    } else {
      hideTimerRef.current = setTimeout(
        () => setIndicatorVisible(false),
        INDICATOR_HOLD_MS,
      );
    }
  }, []);

  useEffect(
    () => () => {
      // Reset the refs to null after cancelling — otherwise a dev StrictMode
      // remount cancels the pending rAF but leaves the stale id in the ref,
      // and every later handleRangeChanged call early-returns on
      // the `!== null` guard: the range reporting would be dead forever.
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    },
    [],
  );

  const isMobile = useIsMobile();

  // Seam key → the newer slice's strands. The anchors are measured off the
  // DOM (`[data-seam-anchor]`), so the rows only carry their key as a data
  // attribute; the strands come back from this lookup.
  const seamStrands = useMemo(() => {
    const map = new Map<string, readonly string[]>();
    for (const item of items) {
      if (item.kind === "seam") map.set(item.key, item.strands);
    }
    return map;
  }, [items]);

  // ── Item rendering ──────────────────────────────────────────────────────
  // Row gutters: mobile (<md) gets SYMMETRIC px-3 gutters — the old right-only
  // padding left content left-flush with dead space on the right, which read
  // as misaligned on a narrow phone column. Desktop (≥md) keeps today's exact
  // geometry: left-flush, pr-6 (lg: pr-8) — `md:pl-0` cancels the mobile left
  // gutter, `sm:pr-6`/`lg:pr-8` reproduce the legacy right padding.
  const renderItem = useCallback((_index: number, item: ChatStreamItem) => {
    switch (item.kind) {
      case "seam":
        return (
          <div
            className="px-3 sm:pr-6 md:pl-0 lg:pr-8"
            data-seam-anchor
            data-seam-key={item.key}
          >
            <SliceSeam
              seam={item.seam}
              dateIso={item.dateIso}
              prevActivityIso={item.prevActivityIso}
            />
          </div>
        );
      case "resume-banner":
        return <ResumeBanner startIso={item.startIso} />;
      case "briefing":
        // §1.2 Rev 2 — the arrival briefing seated at the stream's tail.
        return briefing ? (
          <EmptyBriefing
            variant="card"
            persona={briefing.persona}
            active={briefing.active}
            recent={briefing.recent}
            onSend={briefing.onSend}
          />
        ) : null;
      case "history-turn":
        return (
          <div className="px-3 sm:pr-6 md:pl-0 lg:pr-8">
            <HistoryTurn
              role={item.turn.role}
              content={item.turn.content}
              sliceId={item.sliceId}
              turnId={item.turn.turnId}
              timestamp={item.turn.timestamp}
              strands={item.strands}
            />
          </div>
        );
      case "live":
        return (
          <div className="px-3 sm:pr-6 md:pl-0 lg:pr-8">
            <ChatMessage
              message={item.message}
              isStreaming={item.isStreaming}
              startedAt={item.startedAt}
              onRegenerate={item.onRegenerate}
              strands={item.strands}
            />
          </div>
        );
    }
  }, [briefing]);

  // Virtuoso's Header/Footer take no props — memoized closures over state.
  const Header = useMemo(
    () =>
      function StreamHeader() {
        return (
          <div className="px-3 pt-3 sm:pr-6 md:pl-0 lg:pr-8">
            {loadingOlder && (
              <div className="flex items-center justify-center gap-2 py-3 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {tSeam("loadingOlder")}
              </div>
            )}
          </div>
        );
      },
    [loadingOlder, tSeam],
  );

  const Footer = useMemo(
    () =>
      function StreamFooter() {
        return (
          <div className="px-3 sm:pr-6 md:pl-0 lg:pr-8">
            {error && <ErrorBanner error={error} />}
            {/* Safe area clearing the fixed bottom input bar (was pb-36).
                Mobile: wrapper pt-2 (8px) + the input card (~88px collapsed:
                pt-3 + 24px textarea + toolbar) + the safe-area padding
                (≥8px) ≈ 104px, so h-28 (112px) clears it with margin —
                desktop keeps the original h-36. An expanded textarea can
                still lap the tail; that was true of pb-36 too. */}
            <div className="h-28 md:h-36" />
          </div>
        );
      },
    [error],
  );

  // The components object itself must be referentially stable too — a fresh
  // `{ Header, Footer }` literal every render makes Virtuoso tear down and
  // re-measure the header/footer on EVERY scroll-driven setState (indicator,
  // rail), which feeds its size-compensation loop.
  const components = useMemo(() => ({ Header, Footer }), [Header, Footer]);

  // ── Bottom-follow, hand-rolled (Rev 2 arrival bug) ───────────────────────
  // Virtuoso's followOutput="auto" scrolls to ITS computed bottom on every
  // size change — and that bottom is derived from internal totalHeight, which
  // undershoots the real DOM bottom by ~280px while unmeasured-item estimates
  // are in play. Net effect on arrival: even wheel scrolling toward the tail
  // got dragged back on every resize — the last ~280px (briefing card +
  // footer) were unreachable (design doc §11). We track atBottom ourselves
  // and pin to the DOM max instead: on a tail append, and on every items
  // change while a live turn is streaming. Note this deliberately does NOT
  // re-pin on pure resizes, so the arrival landing can sit a little above
  // the tail until the user scrolls — the accepted Rev 2 remainder.
  const atBottomRef = useRef(true);
  const handleAtBottomChange = useCallback((at: boolean) => {
    atBottomRef.current = at;
  }, []);
  const liveStreaming = items.some((i) => i.kind === "live" && i.isStreaming);
  const prevCountRef = useRef(items.length);
  useEffect(() => {
    const grew = items.length > prevCountRef.current;
    prevCountRef.current = items.length;
    if (!atBottomRef.current || (!grew && !liveStreaming)) return;
    const raf = requestAnimationFrame(() => {
      virtuosoRef.current?.scrollTo({ top: Number.MAX_SAFE_INTEGER });
    });
    return () => cancelAnimationFrame(raf);
  }, [items, liveStreaming, virtuosoRef]);

  // ── Strand-field anchors for the band (chat view) ───────────────────────
  // The band is wound where the CONTENT is and straight where the boundaries
  // are — one rule, and the timeline view is its reference: there the knot
  // sits on each card and unwinds in the gap between cards. The chat's
  // equivalent of "the card" is the slice BLOCK (its seam header plus its
  // turns), so the anchor is the block's MIDDLE and the seams fall in the
  // straight parts.
  //
  // Publishing the seam rows as the anchors — which is what this did first —
  // puts the knot on the divider and leaves the conversation itself unwound:
  // the exact inverse of the timeline. Seams mark block STARTS, so they are
  // the boundaries between anchors, and the block's extent is the gap between
  // one seam and the next.
  //
  // Virtuoso's scroller element arrives via its scrollerRef prop.
  const scrollerElRef = useRef<HTMLElement | null>(null);
  // Virtuoso types scrollerRef as `HTMLElement | Window | null` (window
  // scroll mode) — this stream scrolls in its own element, so keep the
  // element and ignore a window.
  const handleScrollerRef = useCallback((el: HTMLElement | Window | null) => {
    scrollerElRef.current = el instanceof HTMLElement ? el : null;
  }, []);
  const anchorsRafRef = useRef<number | null>(null);
  // Ref mirrors (the file's onTopItemChangeRef pattern) so the unmount cleanup
  // below can see the latest props without re-subscribing.
  const anchorsRefRef = useRef(anchorsRef);
  anchorsRefRef.current = anchorsRef;
  const anchorsActiveRef = useRef(anchorsActive);
  anchorsActiveRef.current = anchorsActive;
  const seamStrandsRef = useRef(seamStrands);
  seamStrandsRef.current = seamStrands;

  const measureAnchors = useCallback(() => {
    if (!anchorsActive || !anchorsRef) return;
    const scroller = scrollerElRef.current;
    if (!scroller) return;
    const scrollerRect = scroller.getBoundingClientRect();
    if (scrollerRect.height <= 0) return;

    // Every seam row in the DOM, as the screen-Y fraction of its TOP edge —
    // a block boundary, not a node.
    const bounds: { y: number; strands: readonly string[] }[] = [];
    for (const row of scroller.querySelectorAll("[data-seam-anchor]")) {
      const r = row.getBoundingClientRect();
      const key = row.getAttribute("data-seam-key");
      bounds.push({
        y: (r.top - scrollerRect.top) / scrollerRect.height,
        strands: (key ? seamStrandsRef.current.get(key) : undefined) ?? [],
      });
    }
    if (bounds.length === 0) {
      anchorsRef.current = [];
      return;
    }

    // Where the newest block ends. It has no seam after it, so its extent has
    // to come from the last ROW actually rendered — and NOT from
    // `scroller.scrollHeight`, which in Virtuoso is its ESTIMATED total,
    // including placeholders for items that are not mounted. Measured on the
    // demo stream that estimate was 8x the real content (a block centre
    // computed from it landed ~7 viewports below the fold and was dropped), so
    // every block but the last lost its anchor and the band fell back to a
    // single knot pinned to the viewport centre — which is why the chat band
    // had no braid to speak of.
    //
    // `[data-index]` is Virtuoso's own item wrapper. Reading it is reading an
    // implementation detail, but the alternative is a marker element of our
    // own and the measurement is the same either way.
    const rows = scroller.querySelectorAll("[data-index]");
    let contentEnd = bounds[bounds.length - 1].y;
    if (rows.length > 0) {
      const lastBottom = rows[rows.length - 1].getBoundingClientRect().bottom;
      contentEnd = (lastBottom - scrollerRect.top) / scrollerRect.height;
    }

    // A block is wound across its OWN extent, so the anchor carries that
    // extent (`span`) as well as its middle. The seam between two blocks is
    // then the region the twist leaves at 0 and returns to 0 — the straight
    // part, and the place the strand set changes.
    //
    // The window is deliberately WIDER than the viewport (a slice is often
    // taller than one screen): the band blends the anchor above the centre
    // with the one below, and if the neighbouring slice's anchor is dropped
    // for being off-screen there is nothing to blend to — no handoff, and the
    // twist has nowhere to travel as the seam crosses the centre.
    const list: FieldAnchor[] = [];
    for (let i = 0; i < bounds.length && list.length < 24; i++) {
      const end = i + 1 < bounds.length ? bounds[i + 1].y : contentEnd;
      // A zero- or negative-height block (two seams rendered on top of each
      // other during a paging swap) has no middle to anchor to.
      if (!(end > bounds[i].y)) continue;
      const y = (bounds[i].y + end) / 2;
      if (y < -1.5 || y > 2.5) continue;
      list.push({ y, strands: bounds[i].strands, span: end - bounds[i].y });
    }
    anchorsRef.current = list;
  }, [anchorsActive, anchorsRef]);

  // Scroll-driven remeasure, rAF-throttled (the wheel's one-read-per-frame
  // precedent). Re-subscribes when measureAnchors changes identity (the
  // activation toggle), so no listener fires while the timeline owns the ref.
  useEffect(() => {
    const scroller = scrollerElRef.current;
    if (!scroller) return;
    const onScroll = () => {
      if (anchorsRafRef.current !== null) return; // one measure per frame
      anchorsRafRef.current = requestAnimationFrame(() => {
        anchorsRafRef.current = null;
        measureAnchors();
      });
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      // Cancel AND reset — the StrictMode-remount pattern documented above:
      // a stale id would dead-end every later scroll behind the `!== null`
      // guard.
      if (anchorsRafRef.current !== null) {
        cancelAnimationFrame(anchorsRafRef.current);
        anchorsRafRef.current = null;
      }
    };
  }, [measureAnchors]);

  // Item-set / activation changes: paging prepends seams, streaming appends
  // them, and re-activation after the timeline closes must refill the ref
  // CardField's unmount cleanup emptied. All reshape the anchor set without a
  // scroll event, so measure on the next frame.
  useEffect(() => {
    if (!anchorsActive) return;
    const raf = requestAnimationFrame(measureAnchors);
    return () => cancelAnimationFrame(raf);
  }, [items, anchorsActive, measureAnchors]);

  // Unmount cleanup: mirrors CardField's — the weave relaxes back to straight
  // when the stream goes away while it owned the anchors.
  useEffect(() => {
    return () => {
      if (anchorsActiveRef.current) {
        const ref = anchorsRefRef.current;
        if (ref) ref.current = [];
      }
    };
  }, []);

  // ── The field path ──────────────────────────────────────────────────────
  // Everything above this point is SHARED: the item model, the paging policy,
  // the arrival and resume state all stay where they were. Only the renderer
  // changes — which is the whole reason the field takes the same
  // `ChatStreamItem[]` instead of a payload of its own.
  //
  // The Virtuoso-only machinery (firstItemIndex, atBottom, the scroller ref,
  // the rAF anchor measurement) simply does not run here: the field owns its
  // own position and publishes its own anchors.
  if (useField) {
    return (
      <div className="relative mx-auto h-full w-full max-w-5xl xl:max-w-7xl">
        <ConversationField
          items={items}
          anchorsRef={anchorsRef}
          progressRef={progressRef}
          onNeedOlder={onStartReached}
          briefing={briefing}
          apiRef={fieldApiRef}
        />
      </div>
    );
  }

  return (
    <div className="relative mx-auto h-full w-full max-w-5xl xl:max-w-7xl">
      <Virtuoso
        ref={virtuosoRef}
        className="h-full"
        data={items}
        firstItemIndex={firstItemIndex}
        initialTopMostItemIndex={Math.max(0, items.length - 1)}
        computeItemKey={(_index, item) => item.key}
        startReached={onStartReached}
        atBottomStateChange={handleAtBottomChange}
        isScrolling={handleIsScrolling}
        rangeChanged={handleRangeChanged}
        scrollerRef={handleScrollerRef}
        increaseViewportBy={{ top: 600, bottom: 600 }}
        // Height prior for not-yet-rendered items (real rows: seam ~26, turns
        // 74-156) — narrows the gap between Virtuoso's internal totalHeight
        // and the real DOM bottom, so atBottomStateChange means what it says.
        defaultItemHeight={90}
        itemContent={renderItem}
        components={components}
      />
      {/* §1.3: mobile keeps the floating indicator; the desktop rail is
          retired — the 3D axis carries time. */}
      {isMobile && (
        <StreamTimeIndicator timeIso={indicatorTime} visible={indicatorVisible} />
      )}
    </div>
  );
}
