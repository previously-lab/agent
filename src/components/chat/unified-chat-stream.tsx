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
import { useIsMobile } from "@/hooks/use-is-mobile";
import type { HistoryStreamItem } from "@/lib/chat/stream-items";
import type { SliceSummary } from "@/lib/episodic/actions";

/** A live message rendered through the full chat renderer (tool states,
 *  housekeeping cards, phase indicators — design §1.2's live/history split).
 *  Display props are precomputed by the parent so items stay plain data. */
export interface LiveStreamItem {
  kind: "live";
  key: string;
  message: UIMessage;
  /** The current slice's strands — the user bubble's tint source. */
  strands?: string[];
  timeIso: string;
  isStreaming: boolean;
  startedAt?: string;
  onRegenerate?: () => void;
}

export type ChatStreamItem = HistoryStreamItem | LiveStreamItem;

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
  /**
   * The stream column's pixel width — driven by the SAME frame geometry as
   * the timeline card field (useFrameColumn), so the stream's left/right
   * edges sit exactly on the card column's edges in both views. Null/undefined
   * before the first measurement → the legacy responsive classes apply.
   */
  columnWidth?: number | null;
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
  /** Shared convergence anchors owned by the app shell — the threadline
   *  pinches its helices toward them. Chat-mode counterpart of the card
   *  field's row-start anchors (timeline view). */
  anchorsRef?: MutableRefObject<number[]>;
  /** True only when the chat view is the FOREGROUND view. The stream stays
   *  mounted (dimmed) while the timeline is open, but the timeline's CardField
   *  owns the ref then — no measuring here, the two would fight. */
  anchorsActive?: boolean;
}

/** The "继续 <date> 的对话" banner — the light top hint of a resumed
 *  conversation (design §2), sitting directly above the restored turns. */
function ResumeBanner({ startIso }: { startIso: string }) {
  const t = useTranslations("chat.resume");
  const locale = useLocale();
  return (
    <div className="my-4 flex justify-center pr-4 sm:pr-6 lg:pr-8">
      <span className="inline-flex items-center gap-1.5 rounded-full border border-brand-500/25 bg-brand-500/8 px-3 py-1 text-[0.65rem] font-medium text-brand-600 dark:text-brand-400">
        <History className="h-3 w-3" />
        {t("banner", { date: formatSeamDate(startIso, locale) })}
      </span>
    </div>
  );
}

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
  columnWidth,
  onTopItemChange,
  briefing,
  anchorsRef,
  anchorsActive,
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

  // ── Item rendering ──────────────────────────────────────────────────────
  const renderItem = useCallback((_index: number, item: ChatStreamItem) => {
    switch (item.kind) {
      case "seam":
        return (
          <div className="pr-4 sm:pr-6 lg:pr-8" data-seam-anchor>
            <SliceSeam seam={item.seam} dateIso={item.dateIso} />
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
          <div className="pr-4 sm:pr-6 lg:pr-8">
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
          <div className="pr-4 sm:pr-6 lg:pr-8">
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
          <div className="pr-4 pt-3 sm:pr-6 lg:pr-8">
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
          <div className="pr-4 sm:pr-6 lg:pr-8">
            {error && <ErrorBanner error={error} />}
            {/* Safe area clearing the fixed bottom input bar (was pb-36). */}
            <div className="h-36" />
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

  // ── Convergence anchors for the threadline (chat view) ──────────────────
  // In chat view the stream's slice seams are the weave's nodes: each seam
  // row's screen-Y fraction is one anchor, mirroring the card field's
  // row-start anchors in timeline view (same 24-anchor cap, same center-based
  // fraction). Virtuoso's scroller element arrives via its scrollerRef prop.
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

  const measureAnchors = useCallback(() => {
    if (!anchorsActive || !anchorsRef) return;
    const scroller = scrollerElRef.current;
    if (!scroller) return;
    const scrollerRect = scroller.getBoundingClientRect();
    const list: number[] = [];
    // Virtuoso keeps overscan rows mounted, so a seam slightly outside the
    // viewport is still in the DOM — keep a small margin but drop the rest.
    const rows = scroller.querySelectorAll("[data-seam-anchor]");
    for (let i = 0; i < rows.length && list.length < 24; i++) {
      const r = rows[i].getBoundingClientRect();
      const fraction = (r.top + r.height / 2 - scrollerRect.top) / scrollerRect.height;
      if (fraction < -0.05 || fraction > 1.05) continue;
      list.push(fraction);
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

  return (
    <div
      className={`relative mx-auto h-full ${
        columnWidth == null ? "w-full max-w-5xl xl:max-w-7xl" : ""
      }`}
      style={
        columnWidth != null ? { width: columnWidth, maxWidth: "100%" } : undefined
      }
    >
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
