"use client";

/**
 * DomChatList — the conversation as a DOM scroll container with windowed
 * mounting. The NARROW-surface renderer: the R3F conversation field was
 * restored (`conversation-field.tsx`, see `unified-chat-stream.tsx`) and owns
 * the conversation wherever a wide surface exists, but it is authored against
 * the window-derived tier column (680 px) and cannot fit the conversation
 * panel's 420–520 px dock — so on surfaces with no wide host (the game's
 * docked/pilled panel) THIS list carries the conversation, exactly as it did
 * before the restore.
 *
 * HISTORY. Until v0.11 the conversation rendered inside an R3F canvas
 * (`conversation-field.tsx`, then deleted): every block a billboard, the
 * scroll position a camera offset the field owned. The DOM surface below was
 * written for the "the conversation in flight is plain DOM" decision (design
 * doc §13/§14.5); the user's 2026-09 ruling restores the field for the 2.5D
 * view and keeps this surface for the narrow one.
 *
 * What is KEPT from the field, because none of it was 3D-specific:
 *
 *   - ONLY THE VISIBLE ROWS EXIST. The offset table (`stream-layout.ts`)
 *     gives every item a height — measured once the row has mounted, an
 *     estimate until then — and the mounted window is the viewport plus one
 *     screen of overscan. A long conversation mounts a handful of rows.
 *
 *   - A PREPEND IS COMPENSATED, NOT ANCHORED. History pages arrive ABOVE the
 *     reader, the one direction "grows downward, moves nothing above" cannot
 *     cover. When items land at the head, `scrollTop` is shifted by exactly
 *     the height they add — MEASURED off the freshly-committed rows in the
 *     same frame, never estimated — so the reader's view of what they were
 *     reading is pixel-identical and the new conversations sit off-screen
 *     above them. The same rule fires per ROW for anything the measurement
 *     could not cover (a row that was never mounted): a row re-measuring
 *     above the viewport top shifts `scrollTop` by the delta between its
 *     estimate and its real height. `overflow-anchor: none` on the scroller
 *     keeps the browser's own anchoring out of it — two compensations
 *     fighting was the old stack's measured bug.
 *
 *   - THE LIVE EDGE IS A PIN, NOT A TRIGGER. The reader is either at the
 *     bottom (following) or not. Growth pins the scroll to the tail only
 *     while following; scrolling away releases it, scrolling back re-arms
 *     it. Sending a message re-pins (the page calls `scrollToBottom`).
 *
 *   - PAGING IS ASKED FOR, NEVER INFERRED. The window's head is a
 *     `FieldOrigin` the reader walks to; its button is the only thing that
 *     pages older slices. It arms (offers the page) when the reader stands
 *     in the head region — the same mutable `GateSignal` the field used,
 *     now driven by `scrollTop` instead of a camera.
 *
 *   - THE BAND FEED HAS ONE WRITER. While this surface owns the pane it
 *     publishes progress and block anchors to the shared `FieldFeed` and
 *     consumes its seek requests; while the timeline owns the pane it
     *     writes nothing. See `field-feed.ts` for why that rule exists.
 *
 * `ChatStreamItem` and its halves live in `lib/chat/stream-items.ts`, the
 * layout arithmetic in `lib/chat/stream-layout.ts` — both pure, both tested.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
} from "react";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { ChatMessage } from "./chat-message";
import { HistoryTurn } from "./history-turn";
import { SliceSeam } from "./slice-seam";
import { ResumeBanner } from "./resume-banner";
import { EmptyBriefing } from "./empty-briefing";
import { ErrorBanner } from "./error-banner";
import { FieldOrigin } from "./field-origin";
import { StreamTimeIndicator } from "./stream-time-indicator";
import type { ChatStreamItem } from "@/lib/chat/stream-items";
import {
  buildStreamOffsets,
  estimateHeightFor,
  topStreamIndex,
  visibleStreamRange,
} from "@/lib/chat/stream-layout";
import {
  FIELD_ORIGIN_PX,
  sliceIdOf,
  type GateSignal,
} from "@/lib/chat/field-blocks";
import {
  clearFeed,
  offsetFor,
  progressFor,
  type FieldFeed,
} from "@/lib/timeline3d/field-feed";
import type { FieldAnchor } from "@/lib/timeline3d/winding";

/** How far past the viewport a row stays MOUNTED. About one screen — the
 *  reader should be able to scroll a little in either direction without a
 *  row appearing from nowhere. */
const OVERSCAN_PX = 700;
/** At-bottom slop: inside this the reader counts as following the live edge. */
const BOTTOM_SLOP_PX = 8;
/** How long the scroll-transient time pill lingers after the scroll stops. */
const INDICATOR_HOLD_MS = 1000;
/** Breathing room below the tail, beyond the composer's own clearance. */
const TAIL_PAD_PX = 24;
/** Height reserved for the error banner when one is showing — it renders
 *  BELOW the last row, so the inner extent must make room for it. */
const ERROR_RESERVE_PX = 400;

/** What a caller outside the stream can ask it to do. Filled into a ref
 *  rather than exposed through a component ref — this codebase has no
 *  `forwardRef`/`useImperativeHandle` anywhere and the ref-object handshake
 *  is its established shape for exactly this. */
export interface ChatStreamHandle {
  /** Bring the item with `key` (exact, then a key SUFFIX so a bare slice id
   *  reaches its seam) to the top of the viewport, just under the chrome.
   *  Returns false when the key is not loaded — the caller pages more in and
   *  the stream lands on the key when it appears; the stream never fetches
   *  on its own. */
  scrollToKey(key: string): boolean;
  /** Absolute scroll position, px. */
  scrollToOffset(px: number): void;
  /** Where the reader is now, px. */
  offset(): number;
  /** Pin to the live edge — what sending a message does. */
  scrollToBottom(): void;
}

export interface DomChatListProps {
  items: ChatStreamItem[];
  /** Fired when the reader asks for the older page at the window's head. */
  onStartReached: () => void;
  /** The item at the top of the viewport — the travel clock's "from".
   *  `sliceId` is null for the live run. Reported only when it CHANGES. */
  onTopItemChange?: (timeIso: string, sliceId: string | null) => void;
  /** True while older slices are being paged in — shown at the window's head. */
  loadingOlder: boolean;
  /** Whether the catalog still holds older slices — decides whether the
   *  window's head offers the older page or reads as the beginning. */
  hasMore?: boolean;
  /** A failed turn, shown as a banner under the content. */
  error: Error | undefined;
  /** Briefing-mode arrival card props (§1.2 Rev 2). When set, the parent seats
   *  a `briefing` item at the stream tail and it renders through these. */
  briefing?: React.ComponentProps<
    typeof import("./empty-briefing").EmptyBriefing
  > | null;
  /** The shared band feed, owned by the app shell — see `field-feed.ts`. */
  feed?: FieldFeed;
  /** True only while the chat view OWNS the band. The stream keeps rendering
   *  while the timeline is open, but the card field owns the feed then, and
   *  two writers on one feed is exactly what the feed exists to prevent. */
  publishing?: boolean;
  /** Filled with the stream's imperative handle, for the page's jumps. */
  apiRef?: MutableRefObject<ChatStreamHandle | null>;
  /** The floating chrome's height at the pane's top edge, px — carried as the
   *  scroller's top padding, so content comes to rest clear of the chrome and
   *  passes under it while scrolling. See `use-chrome-inset`. */
  insetTop?: number;
  /** The floating composer's height at the pane's foot, px. */
  insetBottom?: number;
}

export function DomChatList({
  items,
  onStartReached,
  onTopItemChange,
  loadingOlder,
  hasMore,
  error,
  briefing,
  feed,
  publishing = false,
  apiRef,
  insetTop = 0,
  insetBottom = 0,
}: DomChatListProps) {
  const isMobile = useIsMobile();
  const scrollerRef = useRef<HTMLDivElement>(null);

  // ── The offset table ────────────────────────────────────────────────────
  // Measured height per item KEY (not index — a prepend renumbers indices,
  // and the height must travel with the row it belongs to). `measureTick`
  // re-derives the table when a measurement lands.
  const heightsRef = useRef(new Map<string, number>());
  const [measureTick, setMeasureTick] = useState(0);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const offsets = useMemo(
    () => buildStreamOffsets(items, (i) => heightsRef.current.get(i.key)),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- measureTick IS the heights version
    [items, measureTick],
  );
  const offsetsRef = useRef(offsets);
  offsetsRef.current = offsets;

  // The window's head (FieldOrigin) sits ABOVE item 0 as a fixed-height
  // region of its own, exactly as in the field — the first row's top is
  // `originH`, and the origin is always the top of the content.
  const hasHistory = items.some(
    (i) => i.kind !== "live" && i.kind !== "briefing",
  );
  const originH = hasHistory ? FIELD_ORIGIN_PX : 0;
  const oldestIso = hasHistory ? (items[0]?.timeIso ?? "") : "";
  const contentPx = originH + (offsets[items.length] ?? 0);
  const contentPxRef = useRef(contentPx);
  contentPxRef.current = contentPx;
  const originHRef = useRef(originH);
  originHRef.current = originH;
  const innerPx = contentPx + (error ? ERROR_RESERVE_PX : 0);

  // ── Scroll state ─────────────────────────────────────────────────────────
  // `scrollTopState` exists only to re-derive the mounted window; everything
  // else reads the ref. The reader is FOLLOWING while parked at the live
  // edge; ARRIVING is the mount-time pin that holds the live edge through
  // the first measurements, released by the reader's first upward scroll.
  const [scrollTopState, setScrollTopState] = useState(0);
  const scrollTopRef = useRef(0);
  const [viewportH, setViewportH] = useState(0);
  const followingRef = useRef(true);
  const arrivingRef = useRef(true);
  const pendingKeyRef = useRef<string | null>(null);
  const originSignalRef = useRef<GateSignal>({ armed: false, dir: "past" });
  const onTopItemChangeRef = useRef(onTopItemChange);
  onTopItemChangeRef.current = onTopItemChange;
  const topKeyRef = useRef("");
  const [topTime, setTopTime] = useState<string | null>(null);
  const [indicatorVisible, setIndicatorVisible] = useState(false);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollRafRef = useRef(0);

  const reportTop = useCallback((st: number) => {
    const its = itemsRef.current;
    if (its.length === 0) return;
    const idx = topStreamIndex(
      offsetsRef.current,
      its.length,
      Math.max(0, st - originH),
    );
    const item = its[idx];
    if (!item || item.key === topKeyRef.current) return;
    topKeyRef.current = item.key;
    setTopTime(item.timeIso);
    onTopItemChangeRef.current?.(item.timeIso, sliceIdOf(item));
  }, [originH]);

  const handleScroll = useCallback(() => {
    if (scrollRafRef.current) return; // one read per frame
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = 0;
      const el = scrollerRef.current;
      if (!el) return;
      const st = el.scrollTop;
      scrollTopRef.current = st;
      setScrollTopState(st);
      const atBottom = st >= el.scrollHeight - el.clientHeight - BOTTOM_SLOP_PX;
      if (!atBottom) arrivingRef.current = false;
      followingRef.current = atBottom;
      // The head ARMS when the reader stands in it — the same signal the
      // field drove from its camera, now read off the scroll position.
      originSignalRef.current.armed = st <= FIELD_ORIGIN_PX;
      reportTop(st);
      setIndicatorVisible(true);
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
      hideTimerRef.current = setTimeout(
        () => setIndicatorVisible(false),
        INDICATOR_HOLD_MS,
      );
    });
  }, [reportTop]);

  // ── Row measurement ──────────────────────────────────────────────────────
  // One ResizeObserver for every mounted row. A row that re-measures ABOVE
  // the reader shifts `scrollTop` by the delta — estimate or previous
  // measurement, both are covered: `oldH` is what the offset table currently
  // believes the row's height to be.
  const resizeHandlerRef = useRef<
    ((entries: ResizeObserverEntry[]) => void) | null
  >(null);
  resizeHandlerRef.current = (entries) => {
    const el = scrollerRef.current;
    let changed = false;
    for (const entry of entries) {
      const row = entry.target as HTMLElement;
      const key = row.dataset.key;
      if (!key) continue;
      const h = row.offsetHeight;
      if (!h) continue;
      let oldH = heightsRef.current.get(key);
      if (oldH === undefined) {
        const item = itemsRef.current.find((i) => i.key === key);
        oldH = item ? estimateHeightFor(item) : 0;
      }
      if (oldH === h) continue;
      heightsRef.current.set(key, h);
      changed = true;
      if (el) {
        // The row's top in scroll-content coordinates: the scroller's top
        // padding, then the row's `top` inside the inner box.
        const rowTop = insetTop + row.offsetTop;
        if (rowTop + oldH <= el.scrollTop) el.scrollTop += h - oldH;
      }
    }
    if (changed) setMeasureTick((t) => t + 1);
  };
  const roRef = useRef<ResizeObserver | null>(null);
  const rowRef = useCallback((el: HTMLDivElement | null) => {
    if (!el) return;
    roRef.current ??= new ResizeObserver((entries) =>
      resizeHandlerRef.current?.(entries),
    );
    roRef.current.observe(el);
    return () => roRef.current?.unobserve(el);
  }, []);
  useEffect(
    () => () => {
      roRef.current?.disconnect();
      roRef.current = null;
      if (scrollRafRef.current) cancelAnimationFrame(scrollRafRef.current);
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    },
    [],
  );

  // The scroller's own height, for the mounted window.
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    setViewportH(el.clientHeight);
    const ro = new ResizeObserver(() => setViewportH(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ── Prepend detection ────────────────────────────────────────────────────
  // History pages arrive at the HEAD. The old head's key is found in the new
  // array during render; the layout effect then shifts `scrollTop` by the
  // height the new items add, MEASURED off the freshly-committed DOM, which
  // leaves the reader's view pixel-identical. Written during render and
  // idempotent, so a double render cannot double-count.
  const prevHeadKeyRef = useRef<string | null>(null);
  const prependCountRef = useRef(0);
  const prevHeadKey = prevHeadKeyRef.current;
  if (prevHeadKey && items[0] && items[0].key !== prevHeadKey) {
    const idx = items.findIndex((i) => i.key === prevHeadKey);
    if (idx > 0) prependCountRef.current = idx;
  }
  prevHeadKeyRef.current = items[0]?.key ?? null;

  useLayoutEffect(() => {
    const count = prependCountRef.current;
    if (count === 0) return;
    prependCountRef.current = 0;
    const el = scrollerRef.current;
    if (!el) return;
    // THE COMPENSATION MUST BE EXACT, so it is MEASURED, not estimated. The
    // new rows are already in the DOM (a reader at the window's head has the
    // whole page inside the overscan window), and their `offsetHeight` is
    // readable in this same frame — an estimate here drifts the reader by
    // however wrong it is (measured: 164 px for a two-slice page), and the
    // ResizeObserver correction cannot fully repay it, because a row whose
    // bottom is already inside the viewport is not compensable without
    // moving the text under the reader twice. Recording the real heights
    // here also makes the later RO pass a no-op for these rows (oldH === h).
    const rowsByKey = new Map<string, HTMLElement>();
    for (const row of el.querySelectorAll<HTMLElement>("[data-key]")) {
      rowsByKey.set(row.dataset.key ?? "", row);
    }
    let shift = 0;
    for (let i = 0; i < count; i++) {
      const item = itemsRef.current[i];
      if (!item) break;
      const h = rowsByKey.get(item.key)?.offsetHeight;
      if (h) {
        heightsRef.current.set(item.key, h);
        shift += h;
      } else {
        // Not mounted (a deep jump paged many slices at once) — the
        // estimate stands in, and the row-measure rule repays the error
        // when the row mounts ABOVE the reader.
        shift += estimateHeightFor(item);
      }
    }
    el.scrollTop += shift;
    scrollTopRef.current = el.scrollTop;
    setScrollTopState(el.scrollTop);
    setMeasureTick((t) => t + 1);
  }, [items]);

  // ── The live-edge pin ────────────────────────────────────────────────────
  // Growth pins the scroll to the tail only while the reader is following
  // (or arriving). Runs AFTER the prepend compensation above: if both fire,
  // a reader at the live edge ends at the live edge.
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    if (!arrivingRef.current && !followingRef.current) return;
    el.scrollTop = el.scrollHeight;
    scrollTopRef.current = el.scrollTop;
    setScrollTopState(el.scrollTop);
  }, [contentPx, items]);

  // Report the top item after programmatic moves too (the scroll event is
  // rAF-throttled and a jump can land between frames).
  useLayoutEffect(() => {
    reportTop(scrollTopRef.current);
  }, [offsets, reportTop]);

  // ── The imperative handle ────────────────────────────────────────────────
  const findIndexFor = useCallback((key: string): number => {
    const its = itemsRef.current;
    const exact = its.findIndex((i) => i.key === key);
    if (exact >= 0) return exact;
    return its.findIndex((i) => i.key.endsWith(key));
  }, []);

  const scrollToIndex = useCallback((idx: number) => {
    const el = scrollerRef.current;
    if (!el) return;
    // The row sits `insetTop` below the scrollport's top here — clear of the
    // floating chrome, which is what the padding is for.
    el.scrollTop = (offsetsRef.current[idx] ?? 0) + originH;
    scrollTopRef.current = el.scrollTop;
    setScrollTopState(el.scrollTop);
  }, [originH]);

  // Honour a jump whose target was still paging in when it was asked for —
  // the caller scrolls on the frame after paging resolves, which is BEFORE
  // React has committed the new items. Remembering the key makes the jump
  // reliable without the caller polling. The stream still fetches nothing
  // itself — the paging policy stays with the caller.
  useEffect(() => {
    const key = pendingKeyRef.current;
    if (!key) return;
    const idx = findIndexFor(key);
    if (idx < 0) return;
    pendingKeyRef.current = null;
    arrivingRef.current = false;
    followingRef.current = false;
    scrollToIndex(idx);
  }, [items, findIndexFor, scrollToIndex]);

  useEffect(() => {
    if (!apiRef) return;
    apiRef.current = {
      scrollToKey(key) {
        // A programmatic jump ends the arrival pin and the follow — the
        // reader is going somewhere specific, and growth must not yank them
        // back to the tail.
        arrivingRef.current = false;
        followingRef.current = false;
        const idx = findIndexFor(key);
        if (idx >= 0) {
          scrollToIndex(idx);
          return true;
        }
        pendingKeyRef.current = key;
        return false;
      },
      scrollToOffset(px) {
        arrivingRef.current = false;
        followingRef.current = false;
        const el = scrollerRef.current;
        if (el) el.scrollTop = px;
      },
      scrollToBottom() {
        // The one programmatic move that KEEPS the pin: it is going where
        // the pin wants to be, and the pin is what holds it there while the
        // tail keeps growing.
        arrivingRef.current = true;
        followingRef.current = true;
        const el = scrollerRef.current;
        if (el) el.scrollTop = el.scrollHeight;
      },
      offset() {
        return scrollerRef.current?.scrollTop ?? 0;
      },
    };
    return () => {
      apiRef.current = null;
    };
  }, [apiRef, findIndexFor, scrollToIndex]);

  // ── The band feed ────────────────────────────────────────────────────────
  // THE LEASE, BOTH WAYS: publish only while this surface owns the pane, and
  // relax the feed on both acquire and release — see `field-feed.ts` and the
  // field's own note on why a frozen feed is a lie the band cannot tell from
  // a still one.
  const seekGenRef = useRef(-1);
  useEffect(() => {
    if (!feed || !publishing) return;
    clearFeed(feed);
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const el = scrollerRef.current;
      if (!el) return;
      const st = el.scrollTop;
      const vh = el.clientHeight || 1;
      const total = contentPxRef.current;
      const max = Math.max(0, total - vh);

      // A SEEK from the band, consumed by generation so a request published
      // across many frames moves the reader once. Native scrolling IS
      // immediate, so a dragging scrub needs no special case.
      const seek = feed.seek;
      if (seek && seek.gen !== seekGenRef.current) {
        seekGenRef.current = seek.gen;
        el.scrollTop = offsetFor(seek.progress, 0, max);
      }

      feed.progress = progressFor(st, 0, max);
      // The DOM stream has no gates — nothing announces a boundary here.
      feed.crossing.y = null;

      // One anchor per slice BLOCK, as in the field: the seam is the
      // boundary, the block is the extent between two seams, and the anchor
      // sits at the block's middle with its span. The live turn is an
      // anchor too — it is the one place the reader usually is.
      const its = itemsRef.current;
      const offs = offsetsRef.current;
      const list: FieldAnchor[] = [];
      const origin = originHRef.current;
      for (let i = 0; i < its.length && list.length < 24; i++) {
        const item = its[i];
        if (item.kind !== "seam") continue;
        const start = offs[i] ?? 0;
        let end = offs[its.length] ?? start;
        for (let j = i + 1; j < its.length; j++) {
          if (its[j].kind === "seam") {
            end = offs[j] ?? end;
            break;
          }
        }
        if (!(end > start)) continue;
        const y = (origin + (start + end) / 2 - st) / vh;
        if (y < -1.5 || y > 2.5) continue;
        const sid = item.key.slice("seam-".length);
        list.push({
          y,
          strands: item.strands,
          span: (end - start) / vh,
          date: /^\d{4}-\d{2}-\d{2}/.test(sid) ? sid.slice(0, 10) : undefined,
        });
      }
      const liveIdx = its.findIndex((i) => i.kind === "live");
      if (liveIdx >= 0) {
        const liveStart = (offs[liveIdx] ?? 0) + origin;
        const liveH = total - liveStart;
        const live = its[liveIdx];
        if (
          live.kind === "live" &&
          liveH > 0 &&
          liveStart < st + vh &&
          liveStart + liveH > st
        ) {
          list.push({
            y: (liveStart + liveH / 2 - st) / vh,
            strands: live.strands ?? [],
            span: liveH / vh,
            date: live.timeIso.slice(0, 10),
          });
        }
      }
      feed.anchors = list;
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      clearFeed(feed);
    };
  }, [feed, publishing]);

  // ── The mounted window ───────────────────────────────────────────────────
  const { start, end } = visibleStreamRange(
    offsets,
    items.length,
    Math.max(0, scrollTopState - insetTop),
    viewportH,
    OVERSCAN_PX,
  );

  const renderItem = (item: ChatStreamItem) => {
    switch (item.kind) {
      case "seam":
        return (
          <div className="px-3 sm:pr-6 md:pl-0 lg:pr-8">
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
        return briefing ? <EmptyBriefing variant="card" {...briefing} /> : null;
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
  };

  return (
    <div className="relative mx-auto h-full w-full max-w-5xl xl:max-w-7xl">
      <div
        ref={scrollerRef}
        // The stable hook, kept from the field: e2e specs and probes address
        // the conversation through it. It now names a REAL scroll container.
        data-conversation-field
        // Focusable so the keyboard scrolls the conversation natively
        // (arrows, Page Up/Down, Home/End) — the browser owns all of it now.
        tabIndex={0}
        role="log"
        onScroll={handleScroll}
        className="h-full overflow-y-auto overscroll-contain outline-none [overflow-anchor:none]"
        style={{
          paddingTop: insetTop,
          paddingBottom: insetBottom + TAIL_PAD_PX,
        }}
      >
        <div className="relative" style={{ height: innerPx }}>
          {hasHistory && (
            <div className="absolute inset-x-0 top-0">
              <FieldOrigin
                oldestIso={oldestIso}
                hasMore={hasMore !== false}
                loading={loadingOlder === true}
                onLoadOlder={onStartReached}
                signal={originSignalRef.current}
              />
            </div>
          )}
          {items.slice(start, end).map((item, k) => (
            <div
              key={item.key}
              ref={rowRef}
              data-key={item.key}
              className="absolute inset-x-0"
              style={{ top: originH + (offsets[start + k] ?? 0) }}
            >
              {renderItem(item)}
            </div>
          ))}
          {error && (
            <div
              className="absolute inset-x-0"
              style={{ top: contentPx }}
            >
              <ErrorBanner error={error} />
            </div>
          )}
        </div>
      </div>

      {/* §1.3: mobile keeps the floating time pill. The desktop left rail is
          retired — the 3D axis carries time. */}
      {isMobile && (
        <StreamTimeIndicator timeIso={topTime} visible={indicatorVisible} />
      )}
    </div>
  );
}
