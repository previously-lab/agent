"use client";

/**
 * ConversationField — the conversation as a camera-navigated field instead of a
 * browser scroll container.
 *
 * WHY. A scroll container makes the browser own the position, and every hard
 * problem in this stream is a consequence of that ownership: a total height
 * that is ESTIMATED and then corrected under the reader, scroll anchoring
 * fighting the virtualizer's own compensation, momentum that cannot be handed
 * from one element to another. Measured on the old stack: `scrollHeight`
 * reported 13,471 px for ~1,000 px of real content, and setting `scrollTop`
 * came back 32-64 px away because something else had moved it. Here the
 * position is a NUMBER WE OWN — the camera — and none of that exists.
 *
 * EVERY BLOCK IS A BILLBOARD, and the whole model follows from one property:
 *
 *   A BILLBOARD IS ANCHORED BY ITS TOP EDGE, so a block that grows grows
 *   DOWNWARD and moves nothing above it.
 *
 * That is why history and the live turn can use the same mechanism. A finished
 * block is measured once, when it enters the overscan window, and its height is
 * then FIXED — reading it, scrolling it or evicting it can never change it. The
 * live block grows as tokens arrive, and because it is last, its growth cannot
 * move a single block that is already placed. The camera decides what to do
 * about the growth: follow if the reader is already at the live edge, do
 * nothing at all if they have scrolled away.
 *
 * THE ONE DIRECTION THAT PROPERTY DOES NOT COVER IS UPWARD. A block arriving
 * ABOVE the reader is exactly the case where "grows downward, moves nothing
 * above" gives no protection, because everything the reader can see is below
 * it. Paging older is therefore handled by COMPENSATION rather than by
 * anchoring: when the block list gains blocks at its head, the camera is moved
 * by the height they add, which leaves the reader's view of the content they
 * were already reading pixel-identical — and puts the new conversations
 * off-screen above them, to be scrolled into. See `relayout`. This is the
 * "infinite canvas" the product is: slices are placed above and below, and the
 * reader moves the camera.
 *
 * SCALE IS NOT A CONCERN. Only the blocks crossing the viewport, plus one
 * screen of overscan, exist as portals. The rest are numbers in an offset
 * table, so the mounted count is a handful however long the conversation gets.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Html } from "@react-three/drei";
import { useReducedMotion } from "motion/react";
import {
  NextIntlClientProvider,
  useLocale,
  useMessages,
  useTranslations,
} from "next-intl";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { useTier } from "@/hooks/use-tier";
import { ErrorBanner } from "./error-banner";
import { StreamTimeIndicator } from "./stream-time-indicator";
import type { ChatStreamItem } from "@/lib/chat/stream-items";
import type { FieldAnchor } from "@/lib/timeline3d/winding";
import {
  clearFeed,
  offsetFor,
  progressFor,
  type FieldFeed,
} from "@/lib/timeline3d/field-feed";
import {
  armedGate,
  FIELD_ORIGIN_PX,
  gateBands,
  groupBlocks,
  maxOffsetFor,
  minOffsetFor,
  ORIGIN_REGION,
  prependHeadCount,
  sliceIdOf,
  splitItems,
  type GateBand,
  type GateSignal,
  type StreamBlock,
} from "@/lib/chat/field-blocks";
import { buildOffsets, visibleRangeFor } from "@/lib/timeline3d/field-offsets";
import { SliceGate } from "./slice-gate";
import { FieldOrigin } from "./field-origin";
import { HistoryTurn } from "./history-turn";
import { ChatMessage } from "./chat-message";
import { ResumeBanner } from "./resume-banner";
import { EmptyBriefing } from "./empty-briefing";

/*
 * The column width is no longer a module constant. It is `columnFor(w)` from
 * `@/lib/layout/tiers`, resolved once per render by `useTier()` and threaded
 * down as `column` — because it is now viewport-derived and two components
 * must agree on it (`field-blocks.ts` states why). The orthographic camera is
 * still at zoom 1, so the number is also its width in world units and the text
 * is still never scaled; only the number's SOURCE changed.
 */
/** How far past the viewport a block stays MOUNTED (never a fetch: paging is
 *  manual). About one screen — the reader should be able to scroll a little in
 *  either direction without a block appearing from nowhere. */
const OVERSCAN_PX = 700;
/** Follow fraction per frame; higher is snappier, lower is floatier. */
const FOLLOW = 0.22;
/** Height assumed for a block that has not reported yet. Only ever applies to
 *  offscreen history, and it is replaced the moment the block measures. */
const FALLBACK_BLOCK_PX = 320;
/** How long the scroll-transient time pill lingers after the camera stops. */
const INDICATOR_HOLD_MS = 1000;

/** What a caller outside the field can ask it to do. Filled into a ref rather
 *  than exposed through a component ref, matching the shared `FieldFeed` —
 *  this codebase has no `forwardRef`/`useImperativeHandle` anywhere and the
 *  ref-object handshake is its established shape for exactly this. */
export interface ConversationFieldHandle {
  /** Bring the block containing `key` to the top of the viewport. Returns false
   *  when that key is not loaded, which is the caller's signal to page more in
   *  and try again — the field never fetches on its own. */
  scrollToKey(key: string): boolean;
  /** Absolute offset in px, clamped. */
  scrollToOffset(px: number): void;
  /** Where the camera is now, px. */
  offset(): number;
  /** Pin to the live edge — what sending a message does. */
  scrollToBottom(): void;
}

export interface ConversationFieldProps {
  items: ChatStreamItem[];
  /** What the left band reads — see `field-feed.ts`. The card field publishes
   *  through the SAME object in the timeline view, so the band needs no second
   *  code path. */
  feed?: FieldFeed;
  /** Whether this field owns the band right now. False means it writes NOTHING:
   *  both fields are mounted at once whenever the timeline is open, and when
   *  two of them wrote the same refs the band's position came down to render
   *  order. */
  publishing?: boolean;
  /** Filled with the imperative handle; see `ConversationFieldHandle`. */
  apiRef?: React.MutableRefObject<ConversationFieldHandle | null>;
  /** Called when the reader asks for the older page at the window's head. */
  onNeedOlder: () => void;
  /** The block at the top of the viewport, reported only when it CHANGES.
   *  Replaces what the virtualized list read off `rangeChanged`. Its one
   *  consumer is the travel clock, which reads the time it is travelling FROM;
   *  the slice id used to be published to the deleted mode switcher and is now
   *  read by nothing, but it is still reported because the clock's caller
   *  signature carries it. `sliceId` is null for the live run. */
  onTopItemChange?: (timeIso: string, sliceId: string | null) => void;
  /** True while older slices are being paged in — shown at the window's head. */
  loadingOlder?: boolean;
  /** Whether the catalog still holds slices older than the loaded window.
   *  False turns the head of the window into "the beginning of this memory"
   *  rather than an invitation to load more. */
  hasMore?: boolean;
  /** A failed turn, shown as a banner under the content. */
  error?: Error;
  /** Briefing payload, seated as the tail card exactly as in the stream. */
  briefing?: React.ComponentProps<typeof EmptyBriefing> | null;
  /** False while the reader has scrolled away from the live edge — growth must
   *  then move nothing at all. Omitted, the field tracks it itself. */
  following?: boolean;
  /** How much of the pane's top edge the floating chrome covers, px — measured
   *  by `use-chrome-inset`. It comes off the camera's extent, never off this
   *  field's box: the field fills the pane and the content passes UNDER the
   *  chrome while the reader moves, coming to rest clear of it. See
   *  `minOffsetFor` for why a container padding is the wrong lever here. */
  insetTop?: number;
  /** How much of the pane's foot the floating composer covers, px — measured
   *  by `ComposerHost` and owned by the shell. The live edge rests above it. */
  insetBottom?: number;
}

/** The field lays out exactly the blocks `groupBlocks` produces — the type is
 *  imported rather than re-declared so the two cannot drift. */
type Block = StreamBlock;

/** One stream item, in its plain form. Shared by history blocks and the live
 *  block so the two cannot drift apart visually. */
function renderStreamItem(
  item: ChatStreamItem,
  briefing: ConversationFieldProps["briefing"] | undefined,
  gateSignal: GateSignal | undefined,
) {
  switch (item.kind) {
    case "seam":
      // The gate REPLACES the hairline divider in the field. It carries the
      // same two times the seam did, but as a region tall enough for the band
      // to unwind in — a release needs somewhere to happen.
      return gateSignal ? (
        <SliceGate
          dateIso={item.dateIso}
          prevActivityIso={item.prevActivityIso}
          focus={item.focus}
          prevFocus={item.prevFocus}
          signal={gateSignal}
        />
      ) : null;
    case "resume-banner":
      return <ResumeBanner startIso={item.startIso} />;
    case "history-turn":
      return (
        <HistoryTurn
          role={item.turn.role}
          content={item.turn.content}
          sliceId={item.sliceId}
          turnId={item.turn.turnId}
          timestamp={item.turn.timestamp}
          strands={item.strands}
        />
      );
    case "live":
      return (
        <ChatMessage
          message={item.message}
          isStreaming={item.isStreaming}
          startedAt={item.startedAt}
          onRegenerate={item.onRegenerate}
          strands={item.strands}
        />
      );
    case "briefing":
      return briefing ? <EmptyBriefing variant="card" {...briefing} /> : null;
  }
}

/**
 * One billboard's contents. Its height is reported upward and then FROZEN for
 * history; the live block reports on every growth instead, which is what lets
 * the camera follow the streamed text.
 *
 * THE PROVIDER IS REQUIRED, NOT DEFENSIVE. drei's `<Html>` mounts its children
 * into a SEPARATE React root, so nothing above the `<Canvas>` reaches them —
 * every context, `NextIntlClientProvider` included, is cut at the portal. This
 * repo already met this: `frame-card.tsx` takes all its strings as props for
 * exactly this reason. Re-wrapping is the cheaper half of that trade while the
 * components are ones the real stream also uses verbatim; passing strings would
 * mean forking them. It is also why the gate's arm state travels as a MUTABLE
 * OBJECT rather than a prop — a prop change per crossing would re-render the
 * portal, and a mutable signal read by the gate's own frame loop costs nothing.
 */
function BillboardBlock({
  blockKey,
  items,
  briefing,
  gateSignal,
  messages,
  locale,
  /** Called with the block's DOM height whenever it settles. */
  onHeight,
}: {
  blockKey: string;
  items: ChatStreamItem[];
  briefing?: ConversationFieldProps["briefing"];
  gateSignal?: GateSignal;
  messages: ReturnType<typeof useMessages>;
  locale: string;
  onHeight: (h: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const onHeightRef = useRef(onHeight);
  onHeightRef.current = onHeight;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const report = () => {
      const h = el.offsetHeight;
      if (h) onHeightRef.current(h);
    };
    report();
    // A block can settle late — a font, a wrapped line. Re-reporting is safe
    // for HISTORY (its height only ever feeds its own row) and is the whole
    // point for the LIVE block.
    const ro = new ResizeObserver(report);
    ro.observe(el);
    return () => ro.disconnect();
  }, [blockKey]);

  return (
    <div ref={ref} className="px-3 sm:pr-6 md:pl-0 lg:pr-8">
      <NextIntlClientProvider messages={messages} locale={locale}>
        {items.map((item) => (
          <div key={item.key}>
            {renderStreamItem(item, briefing, gateSignal)}
          </div>
        ))}
      </NextIntlClientProvider>
    </div>
  );
}

// ─── The scene ──────────────────────────────────────────────────────────────

interface SceneProps {
  blocks: Block[];
  liveItems: ChatStreamItem[];
  briefing?: ConversationFieldProps["briefing"];
  /** The reading column, px — `columnFor(w)` resolved by `useTier()` above the
   *  canvas and threaded down. It is also the column's width in world units
   *  (orthographic, zoom 1), which is why it is one number and not two. */
  column: number;
  /** The reader is at the window's head, so the head announces itself. */
  hasOrigin: boolean;
  oldestIso: string;
  hasMore: boolean;
  loadingOlder: boolean;
  onNeedOlder: () => void;
  /** Eased camera offset, px — read every frame, never a prop. */
  offsetRef: React.MutableRefObject<number>;
  /** The direction the reader last moved — written by `setTarget`. */
  dirRef: React.MutableRefObject<"past" | "future">;
  /** Measured DOM height per history block. */
  heightsRef: React.MutableRefObject<number[]>;
  /** Running world offset of each block's top, derived from the heights. */
  offsetsRef: React.MutableRefObject<number[]>;
  /** The lowest offset the camera can reach — the origin sits above block 0. */
  minOffset: number;
  /** The field's maximum camera offset, refreshed every render. A REF and not
   *  a number: it moves with the live block's height, and a prop would
   *  re-render the scene on every streamed token. */
  maxOffsetRef: React.MutableRefObject<number>;
  feed?: FieldFeed;
  publishing: boolean;
  /** The mutable arm signal for a gate block, keyed by the block's key. */
  signalFor: (key: string) => GateSignal;
  originSignal: GateSignal;
  messages: ReturnType<typeof useMessages>;
  locale: string;
  onBlockHeight: (index: number, h: number) => void;
  onLiveHeight: (h: number) => void;
  /** The live block's measured height, px. A REF like `maxOffsetRef`: it moves
   *  with every streamed token, and the frame loop needs it to publish the live
   *  turn's own anchor — see the note on `feed.anchors` below. */
  liveHeightRef: React.MutableRefObject<number>;
  onMountCount: (n: number) => void;
}

function FieldScene({
  blocks,
  liveItems,
  briefing,
  column,
  hasOrigin,
  oldestIso,
  hasMore,
  loadingOlder,
  onNeedOlder,
  offsetRef,
  dirRef,
  heightsRef,
  offsetsRef,
  minOffset,
  maxOffsetRef,
  feed,
  publishing,
  signalFor,
  originSignal,
  messages,
  locale,
  onBlockHeight,
  onLiveHeight,
  liveHeightRef,
  onMountCount,
}: SceneProps) {
  const group = useRef<THREE.Group>(null);
  const { size } = useThree();
  // The mounted set is React state because it decides which portals exist; it
  // changes only when the window crosses a block boundary, never per frame.
  const [visible, setVisible] = useState<number[]>([]);
  const visibleKey = useRef("");
  const statsKey = useRef("");
  // Reused between frames so the arm computation allocates nothing.
  const bandsRef = useRef<GateBand[]>([]);

  useFrame(() => {
    if (group.current) {
      group.current.position.y = size.height / 2 + offsetRef.current;
    }

    const offsets = offsetsRef.current;
    const next = visibleRangeFor(
      offsets,
      blocks.length,
      offsetRef.current,
      size.height,
      OVERSCAN_PX,
      FALLBACK_BLOCK_PX,
    );
    const key = next.join(",");
    if (key !== visibleKey.current) {
      visibleKey.current = key;
      setVisible(next);
    }
    if (String(next.length) !== statsKey.current) {
      statsKey.current = String(next.length);
      onMountCount(next.length);
    }

    // ── The boundary that announces itself ───────────────────────────────
    // One decision per frame for the WHOLE field, written into per-boundary
    // signal objects. It is a single winner rather than a flag each boundary
    // reads: that is what stops a boundary nowhere near the reader from
    // claiming the reader is crossing it.
    // A gate belongs to the block it CLOSES, so its band sits at that block's
    // tail — see `gateBands`, which owns the rule.
    const bands = gateBands(
      bandsRef.current,
      blocks.length,
      (i) => blocks[i].gate,
      offsets,
      FALLBACK_BLOCK_PX,
      hasOrigin,
    );
    const armed = armedGate(bands, offsetRef.current, size.height, minOffset);
    let armedBand: GateBand | null = null;
    for (const band of bands) {
      const isArmed = band.index === armed;
      if (isArmed) armedBand = band;
      const signal =
        band.index === ORIGIN_REGION
          ? originSignal
          : signalFor(blocks[band.index].key);
      if (signal.armed !== isArmed) signal.armed = isArmed;
      if (isArmed && signal.dir !== dirRef.current) signal.dir = dirRef.current;
    }
    // THE ONE PLACE THIS FIELD TOUCHES THE FEED, and the ownership test is at
    // the top of it rather than on each write: a field that does not own the
    // pane publishes NOTHING. It is not a matter of writing the same numbers —
    // the card field is mounted behind this one whenever the timeline is open,
    // and the band's position must not come down to which of the two rendered
    // last.
    if (!feed || !publishing) return;

    feed.crossing.y = armedBand
      ? (armedBand.top + armedBand.height / 2 - offsetRef.current) / size.height
      : null;

    // BOTH ENDS OF THE RANGE, and neither is zero. The floor is the ORIGIN
    // region, one region above block 0 — the chat field scrolls to `minOffset`,
    // not to 0 — and the ceiling is `maxOffset`, NOT the history's height.
    // Passing the history total here was a real slip: the live block's height
    // is part of what the reader can scroll through, so the band's ruler
    // saturated before they reached the live edge and the two panes' rulers
    // meant different things — which is the one thing this unification exists
    // to prevent. See `field-feed.ts` for why the range is a parameter.
    feed.progress = progressFor(
      offsetRef.current,
      minOffset,
      maxOffsetRef.current,
    );

    const list: FieldAnchor[] = [];
    for (const i of next) {
      const start = offsets[i] ?? 0;
      const h = (offsets[i + 1] ?? start + FALLBACK_BLOCK_PX) - start;
      // A slice id is minted from the clock (`YYYY-MM-DD-HHMM`), so its first
      // ten characters ARE the date the catalog would report. Guarded rather
      // than sliced blind: a block whose id is not that shape (the briefing
      // card's is null) publishes no date rather than a wrong one, and the
      // band's readout falls back to the fraction.
      const sid = blocks[i].sliceId;
      const date =
        sid && /^\d{4}-\d{2}-\d{2}/.test(sid) ? sid.slice(0, 10) : undefined;
      list.push({
        y: (start + h / 2 - offsetRef.current) / size.height,
        strands: blocks[i].strands,
        span: h / size.height,
        date,
      });
    }

    // THE LIVE TURN IS AN ANCHOR TOO, and this is the one place it could have
    // been forgotten. It sits inside the field's extent like any block — it is
    // simply not IN `blocks`, because its height changes every token and the
    // offset table is built once per settled measurement. `next` above indexes
    // history only, so the turn being written published NOTHING.
    //
    // WHICH IS THE ONE PLACE THE READER USUALLY IS. At the live edge with the
    // reply filling the pane, `next` is either empty or holds history blocks
    // already scrolled off the top — so the band had no anchor near the middle
    // and `activeAnchorIndex` picked whatever was nearest, off-screen. The
    // braid rested grey and the conversation scrolls underneath it: the band
    // stopped following the thing it exists to follow, and did it exactly while
    // the agent was talking.
    //
    // It carries the CURRENT slice's strands (`liveItems` are built with
    // `activeSlice.strands`, the same source the user bubbles are tinted from),
    // so "now" lights the same threads the card rungs would. The date is the
    // item's own timestamp — a live turn is happening now, so today is the
    // honest answer and needs no lookup. Both are `undefined`-safe: an anchor
    // with no strands simply lights nothing, and one with no date falls back to
    // the band's fraction readout, as a history block with a non-clock id does.
    const liveStart = offsets[blocks.length] ?? 0;
    const liveH = liveHeightRef.current;
    const live = liveItems[0];
    if (
      live?.kind === "live" &&
      liveH > 0 &&
      liveStart + liveH > offsetRef.current &&
      liveStart < offsetRef.current + size.height
    ) {
      list.push({
        y: (liveStart + liveH / 2 - offsetRef.current) / size.height,
        strands: live.strands ?? [],
        span: liveH / size.height,
        date: live.timeIso.slice(0, 10),
      });
    }

    feed.anchors = list;
  });

  // THE LEASE, BOTH WAYS. A field that owns the pane starts from a RELAXED
  // feed and relaxes it again when it stops owning it (or unmounts) — the
  // frame loop fills it in from there. Without the clear-on-lose, the band
  // keeps whatever the outgoing field last published: the reader opens the
  // timeline and the braid stays wound around the CHAT's slice seams, with the
  // crossing dot lit on a boundary that is no longer on screen, for the whole
  // window before the card field has a catalog to publish from. Clearing on
  // ACQUIRE covers the other end — a field that mounts but never reaches its
  // frame loop (an empty catalog) leaves the band resting rather than holding
  // someone else's picture.
  useEffect(() => {
    if (!feed || !publishing) return;
    clearFeed(feed);
    return () => clearFeed(feed);
  }, [feed, publishing]);

  const offsets = offsetsRef.current;
  const liveTop = offsets[blocks.length] ?? 0;

  return (
    <group ref={group}>
      {/* THE HEAD OF THE WINDOW — one region above block 0, at a constant
          world offset. A page of older slices lands BELOW it (between it and
          the old head), so the head is always above everything loaded, and the
          camera compensation leaves the reader looking at exactly what they
          were looking at. */}
      {hasOrigin && (
        // `width` is the tier's reading column in px (useTier → columnFor);
        // drei <Html> takes it as a style prop — the third-party API's shape.
        <Html
          key="origin"
          position={[-column / 2, FIELD_ORIGIN_PX, 0]}
          zIndexRange={[10, 0]}
          style={{ width: column }}
        >
          {/* The provider is REQUIRED here for the same reason BillboardBlock
              needs one: `<Html>` mounts into a separate React root, so every
              context above the canvas — NextIntlClientProvider included — is
              cut at the portal. */}
          <NextIntlClientProvider messages={messages} locale={locale}>
            <FieldOrigin
              oldestIso={oldestIso}
              hasMore={hasMore}
              loading={loadingOlder}
              onLoadOlder={onNeedOlder}
              signal={originSignal}
            />
          </NextIntlClientProvider>
        </Html>
      )}

      {visible.map((i) => (
        <Html
          // NOT `transform`: screen-space mode positions the element by
          // projection and leaves it at 1:1, so text is never scaled.
          // `width` is the tier's reading column, px (useTier → columnFor) —
          // drei <Html> takes it as a style prop.
          key={blocks[i].key}
          position={[-column / 2, -(offsets[i] ?? 0), 0]}
          zIndexRange={[10, 0]}
          style={{ width: column }}
        >
          <BillboardBlock
            blockKey={blocks[i].key}
            items={blocks[i].items}
            // EVERY block gets it, not just the live one. The briefing is a
            // TAIL item — `groupBlocks` seats it in whatever block is already
            // open rather than opening one for it, because it is not a
            // boundary — so the block that needs to render the card is a
            // HISTORY block. Handing the prop only to the live block is what
            // made the card unreachable: it is set exactly when there IS
            // history (`showBriefingCard` excludes the empty memory), and the
            // item is seated in that history, so `renderStreamItem` saw
            // `undefined` every time and drew nothing.
            briefing={briefing}
            gateSignal={blocks[i].gate ? signalFor(blocks[i].key) : undefined}
            messages={messages}
            locale={locale}
            onHeight={(h) => onBlockHeight(i, h)}
          />
        </Html>
      ))}

      {/* THE LIVE TURN — a billboard like the others, whose DOM grows inside.
          Anchored by its TOP, so everything it gains it gains downward. */}
      {liveItems.length > 0 && (
        <Html
          // Same as the block portals above: the tier's reading column, px,
          // via drei <Html>'s style prop.
          key="live"
          position={[-column / 2, -liveTop, 0]}
          zIndexRange={[10, 0]}
          style={{ width: column }}
        >
          <BillboardBlock
            blockKey="live"
            items={liveItems}
            briefing={briefing}
            messages={messages}
            locale={locale}
            onHeight={onLiveHeight}
          />
        </Html>
      )}
    </group>
  );
}

// ─── The field ──────────────────────────────────────────────────────────────

export function ConversationField({
  items,
  feed,
  // No lease, no writes. Defaulting the other way would quietly restore the
  // bug this exists to kill: two writers on one band, ordered by render.
  publishing = false,
  apiRef,
  onNeedOlder,
  onTopItemChange,
  loadingOlder,
  hasMore,
  error,
  briefing,
  following,
  insetTop = 0,
  insetBottom = 0,
}: ConversationFieldProps) {
  const messages = useMessages();
  const locale = useLocale();
  const isMobile = useIsMobile();
  const reducedMotion = useReducedMotion() ?? false;
  const { column } = useTier();
  const tField = useTranslations("timeline3d");

  const { history, live } = useMemo(() => splitItems(items), [items]);
  const blocks = useMemo<Block[]>(() => groupBlocks(history), [history]);
  const hasOrigin = history.length > 0;
  const oldestIso = history[0]?.timeIso ?? "";
  // The chrome's room comes off the RANGE, not off this field's box — see
  // `minOffsetFor`. The wrapper below is `h-full` of an unpadded pane, so the
  // viewport the camera measures against is the whole pane and content travels
  // under the floating controls on its way past them.
  const minOffset = minOffsetFor(hasOrigin, insetTop);
  const minOffsetRef = useRef(minOffset);
  minOffsetRef.current = minOffset;
  /** The last seek this field acted on — see `SeekRequest.gen`. */
  const seekGenRef = useRef(-1);

  const heightsRef = useRef<number[]>([]);
  const offsetsRef = useRef<number[]>([0]);
  const offsetRef = useRef(0);
  const targetRef = useRef(0);
  const liveHeightRef = useRef(0);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const viewportHRef = useRef(0);
  const maxOffsetRef = useRef(0);
  const [, forceRender] = useState(0);
  const [mountedCount, setMountedCount] = useState(0);
  const [indicatorVisible, setIndicatorVisible] = useState(false);
  const movingRef = useRef(0);
  const indicatorShownRef = useRef(false);
  const topKeyRef = useRef("");
  const onTopItemChangeRef = useRef(onTopItemChange);
  onTopItemChangeRef.current = onTopItemChange;
  const [topTime, setTopTime] = useState<string | null>(null);
  // Following is SELF-MANAGED unless the caller insists: the field is the only
  // thing that knows whether the camera is at the live edge, and deriving it
  // here means a caller cannot forget to keep it up to date.
  const followingRef = useRef(following !== false);
  if (following !== undefined) followingRef.current = following;
  // The conversation opens at the LIVE EDGE, not at the top. Content is still
  // being measured during the first frames, so the bottom keeps moving —
  // `arrivingRef` holds the camera there until the reader scrolls, which is
  // also what makes a late-arriving measurement invisible instead of a jump.
  const arrivingRef = useRef(true);
  const arrivedRef = useRef(false);

  /** The direction the reader last moved. The armed boundary reads it to
   *  choose which of its two times to show; see `SliceGate`. */
  const dirRef = useRef<"past" | "future">("future");

  /** A jump the caller asked for before its target had finished paging in.
   *  See the effect below — this is what makes `scrollToKey` reliable without
   *  making the caller poll. */
  const pendingKeyRef = useRef<string | null>(null);

  // ── The boundary signals ──────────────────────────────────────────────
  // One mutable object per gate block, plus one for the window's head. They
  // are the only channel into the `<Html>` portals that costs no render.
  const gateSignalsRef = useRef(new Map<string, GateSignal>());
  const originSignalRef = useRef<GateSignal>({ armed: false, dir: "past" });
  const signalFor = useCallback((key: string): GateSignal => {
    const map = gateSignalsRef.current;
    let signal = map.get(key);
    if (!signal) {
      signal = { armed: false, dir: "future" };
      map.set(key, signal);
    }
    return signal;
  }, []);

  // ── Prepend detection ─────────────────────────────────────────────────
  // A prepend is the only way the block list grows at its HEAD, and `relayout`
  // needs to know how many blocks arrived that way so it can compensate the
  // camera by exactly their height. Written during render, like the prop
  // mirrors above, and idempotent, so a double render cannot double-count.
  //
  // The identity used is each block's SLICE, never its key: the block at the
  // head of the window opens with a turn and gains a seam as soon as a page
  // lands above it, so its key changes on precisely the event being detected.
  const blockIds = useMemo(
    () => blocks.map((b) => b.sliceId),
    [blocks],
  );
  const prevBlockIdsRef = useRef<(string | null)[] | null>(null);
  const headCountRef = useRef(0);
  const prependShiftRef = useRef<number | null>(null);
  const prevBlockIds = prevBlockIdsRef.current;
  if (prevBlockIds !== null) {
    const nextHead = prependHeadCount(
      headCountRef.current,
      prevBlockIds,
      blockIds,
    );
    const added = nextHead - headCountRef.current;
    if (added > 0) {
      // A height is recorded against the block's INDEX, and a prepend moves
      // every block that already exists down by `added`. Without this the
      // measurements stay where they were: each arriving block inherits the
      // height of whichever block used to sit at its index, and the blocks the
      // reader is actually looking at lose theirs and fall back to an
      // estimate — which puts THEM somewhere else while the camera is tracking
      // the head, and the view drifts. Re-indexing by the same amount keeps
      // every block's own measurement with it.
      heightsRef.current = [
        ...new Array<number>(added).fill(0),
        ...heightsRef.current,
      ];
      if (headCountRef.current === 0) {
        // The first prepend of this mount: the baseline the compensation
        // measures FROM is the head's offset before anything arrived above it.
        prependShiftRef.current = 0;
      }
    }
    headCountRef.current = nextHead;
  }
  prevBlockIdsRef.current = blockIds;

  /** The block holding `key`, matching the whole key first and then a key
   *  SUFFIX (a slice id), so a caller that only knows the slice reaches it
   *  without walking the item list itself. */
  const findBlockFor = useCallback(
    (key: string): number | null => {
      for (let i = 0; i < blocks.length; i++) {
        if (blocks[i].items.some((it) => it.key === key)) return i;
      }
      for (let i = 0; i < blocks.length; i++) {
        if (blocks[i].items.some((it) => it.key.endsWith(key))) return i;
      }
      return null;
    },
    [blocks],
  );

  /** The ONLY way the camera moves. Clamping, the follow state and the
   *  direction all live together so no input path can leave them
   *  disagreeing. */
  const setTarget = useCallback(
    (next: number) => {
      const max = maxOffsetRef.current;
      const min = minOffsetRef.current;
      const clamped = Math.min(max, Math.max(min, next));
      const prev = targetRef.current;
      targetRef.current = clamped;
      if (following === undefined) followingRef.current = clamped >= max - 4;
      if (clamped !== prev) {
        dirRef.current = clamped < prev ? "past" : "future";
      }
    },
    [following],
  );

  /** Recompute the running offsets. A block that has never reported inherits
   *  the last known height, so the table stays monotonic and a block far below
   *  can never make the ones above it move — the failure mode that made the old
   *  stack twitch. */
  const relayout = useCallback(() => {
    const h = heightsRef.current;
    const { tops: next } = buildOffsets(
      blocks.length,
      (i) => h[i] ?? 0,
      FALLBACK_BLOCK_PX,
    );
    offsetsRef.current = next;

    // ── The prepend compensation ─────────────────────────────────────────
    // `next[head]` is the world offset of the block that was at the head
    // before the prepends began; before any of them it was 0. Every px it has
    // moved is a px every block below it has moved, so moving the camera by
    // the same amount leaves the reader looking at exactly what they were
    // looking at. It also fires again each time a newly prepended block
    // reports its real height, which is what keeps the view stable while the
    // page above settles from estimate to measurement.
    const head = headCountRef.current;
    if (head > 0) {
      const shift = next[head] ?? 0;
      const previousShift = prependShiftRef.current;
      if (previousShift !== null && shift !== previousShift) {
        const delta = shift - previousShift;
        offsetRef.current += delta;
        targetRef.current += delta;
      }
      prependShiftRef.current = shift;
    }
  }, [blocks.length]);

  useEffect(() => {
    relayout();
    forceRender((n) => n + 1);
  }, [relayout]);

  const historyTotal = offsetsRef.current[blocks.length] ?? 0;
  const totalPx = historyTotal + liveHeightRef.current;
  // The live edge comes to rest above the composer rather than under it — see
  // `maxOffsetFor`. `viewportHRef` is the wrapper's own height, which is the
  // pane's: nothing insets this field, by design.
  const maxOffset = maxOffsetFor(
    totalPx,
    viewportHRef.current,
    minOffset,
    insetBottom,
  );
  maxOffsetRef.current = maxOffset;

  // Honour a jump whose target was still paging in when it was asked for.
  // `findBlockFor` changes identity whenever the block list does, so this runs
  // exactly when new content could have brought the target with it.
  useEffect(() => {
    const key = pendingKeyRef.current;
    if (!key) return;
    const i = findBlockFor(key);
    if (i === null) return;
    pendingKeyRef.current = null;
    setTarget(offsetsRef.current[i] ?? 0);
  }, [findBlockFor, setTarget]);

  // Arrival: sit on the live edge and stay there while the first measurements
  // land. The first placement is instant — a conversation should not animate
  // itself into view — and every later one is the normal eased follow.
  useEffect(() => {
    if (!arrivingRef.current) return;
    targetRef.current = maxOffset;
    if (!arrivedRef.current) {
      offsetRef.current = maxOffset;
      arrivedRef.current = true;
    }
  }, [maxOffset]);

  // The imperative handle. `scrollToKey` deliberately does NOT fetch: the
  // caller pages until the key exists and calls again, which keeps the paging
  // policy in one place instead of split across two components.
  useEffect(() => {
    if (!apiRef) return;
    apiRef.current = {
      scrollToKey(key) {
        // A PROGRAMMATIC jump also ends the arrival. Without this the arrival
        // pin keeps re-targeting the bottom whenever paging changes maxOffset,
        // and it silently overrides the jump the caller just asked for.
        arrivingRef.current = false;
        const i = findBlockFor(key);
        if (i !== null) {
          setTarget(offsetsRef.current[i] ?? 0);
          return true;
        }
        if (key === "live" && live.length > 0) {
          setTarget(offsetsRef.current[blocks.length] ?? 0);
          return true;
        }
        // NOT LOADED YET — and this is the normal case, not an error. A jump
        // pages its target in first, and the caller scrolls on the frame after
        // the paging resolves, which is BEFORE React has committed the new
        // blocks; the handle it calls therefore still closes over the old
        // list. Remembering the key and honouring it when the block appears
        // makes the jump reliable without the caller polling. The field still
        // fetches nothing itself — the paging policy stays with the caller.
        pendingKeyRef.current = key;
        return false;
      },
      scrollToOffset(px) {
        arrivingRef.current = false;
        setTarget(px);
      },
      scrollToBottom() {
        // The one programmatic move that KEEPS the arrival pin: it is going
        // where the pin wants to be, and the pin is what holds it there while
        // the tail keeps growing.
        arrivingRef.current = true;
        arrivedRef.current = true;
        setTarget(maxOffsetRef.current);
      },
      offset() {
        return offsetRef.current;
      },
    };
    return () => {
      apiRef.current = null;
    };
  }, [apiRef, findBlockFor, blocks.length, live.length, setTarget]);

  // The eased follow. A rAF rather than `useFrame` because the position must
  // keep advancing even if the canvas is briefly idle.
  //
  // It also reports the block at the top of the viewport, but only when that
  // block CHANGES — the same one-read-per-crossing shape the virtualized list
  // had, and the reason the reader's position is not published per frame.
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);

      // A SEEK from the band — see `SeekRequest`. Consumed by `gen`, so a
      // request that stays published across many frames moves the reader once.
      // Routed through `setTarget`, the ONE way this camera moves, so the
      // clamping/follow/direction it keeps together cannot be left disagreeing.
      //
      // `dragging` skips the ease entirely: while the pointer is down the
      // camera goes exactly where it was told, because a scrubber that eases
      // toward the finger is one that lags it. A released seek needs no special
      // case — the eased follow below carries it the last few px and lands.
      //
      // Only the field that OWNS the pane acts on it. The other is mounted
      // behind this one and must not move.
      const seek = feed?.seek;
      if (seek && publishing && seek.gen !== seekGenRef.current) {
        seekGenRef.current = seek.gen;
        setTarget(
          offsetFor(seek.progress, minOffsetRef.current, maxOffsetRef.current),
        );
        if (seek.dragging) offsetRef.current = targetRef.current;
      }

      const d = targetRef.current - offsetRef.current;
      if (d !== 0) {
        // Reduced motion snaps: the camera is the scroll position, and an
        // ease here is exactly the kind of animation the preference is about.
        offsetRef.current += reducedMotion
          ? d
          : Math.abs(d) < 0.5
            ? d
            : d * FOLLOW;
        movingRef.current = performance.now();
        if (!reducedMotion && !indicatorShownRef.current) {
          indicatorShownRef.current = true;
          setIndicatorVisible(true);
        }
      } else if (
        indicatorShownRef.current &&
        performance.now() - movingRef.current > INDICATOR_HOLD_MS
      ) {
        indicatorShownRef.current = false;
        setIndicatorVisible(false);
      }

      const cb = onTopItemChangeRef.current;
      if (!cb || blocks.length === 0) return;
      const off = offsetRef.current;
      const offsets = offsetsRef.current;
      let idx = 0;
      for (let i = 0; i < blocks.length; i++) {
        if ((offsets[i] ?? 0) <= off) idx = i;
        else break;
      }
      const first = blocks[idx]?.items[0];
      if (!first || first.key === topKeyRef.current) return;
      topKeyRef.current = first.key;
      setTopTime(first.timeIso);
      cb(first.timeIso, sliceIdOf(first));
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // `feed`/`publishing` are here because this loop is where the band's seek
    // is consumed; `setTarget` because it is the seam the seek goes through.
  }, [blocks, reducedMotion, feed, publishing, setTarget]);

  const onBlockHeight = useCallback(
    (index: number, h: number) => {
      if (heightsRef.current[index] === h) return;
      heightsRef.current[index] = h;
      relayout();
      forceRender((n) => n + 1);
    },
    [relayout],
  );

  /** The live turn grew. The camera follows ONLY if the reader is already at
   *  the live edge; otherwise nothing moves, which is the rule that keeps
   *  reading history from being yanked by the answer being written below. */
  const onLiveHeight = useCallback(
    (h: number) => {
      if (h === liveHeightRef.current) return;
      liveHeightRef.current = h;
      if (followingRef.current) {
        setTarget((offsetsRef.current[blocks.length] ?? 0) + h - viewportHRef.current);
      }
      forceRender((n) => n + 1);
    },
    [blocks.length, setTarget],
  );

  // ── Input ────────────────────────────────────────────────────────────────
  // DESKTOP: a wheel listener. Trackpad inertia arrives as a decaying stream of
  // wheel events, so summing deltas preserves the feel without re-implementing
  // momentum.
  //
  // TOUCH: pointer events plus our own inertia, because there is no native
  // scroller to borrow momentum from — that is the price of owning the
  // position. Velocity is sampled over the last few moves and decays
  // exponentially on release; a press anywhere stops a coast dead, which is
  // what a touch user expects.
  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    viewportHRef.current = el.clientHeight;

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      arrivingRef.current = false; // the reader has taken over
      setTarget(targetRef.current + e.deltaY);
    };

    let dragging = false;
    let lastY = 0;
    let lastT = 0;
    let velocity = 0; // px per ms
    let coasting = false;

    const onPointerDown = (e: PointerEvent) => {
      if (e.pointerType === "mouse") return; // the mouse uses the wheel
      arrivingRef.current = false;
      dragging = true;
      coasting = false;
      lastY = e.clientY;
      lastT = e.timeStamp;
      velocity = 0;
      el.setPointerCapture(e.pointerId);
    };
    const onPointerMove = (e: PointerEvent) => {
      if (!dragging) return;
      const now = e.timeStamp;
      const dy = e.clientY - lastY; // finger down = content down = offset down
      const dt = Math.max(1, now - lastT);
      velocity = dy / dt;
      lastY = e.clientY;
      lastT = now;
      setTarget(targetRef.current - dy);
    };
    const onPointerUp = (e: PointerEvent) => {
      if (!dragging) return;
      dragging = false;
      el.releasePointerCapture?.(e.pointerId);
      // A flick coasts; a slow release does not.
      coasting = !reducedMotion && Math.abs(velocity) > 0.25;
    };

    let raf = 0;
    const coast = () => {
      raf = requestAnimationFrame(coast);
      if (!coasting) return;
      setTarget(targetRef.current - velocity * 16);
      velocity *= 0.94;
      if (Math.abs(velocity) < 0.05) coasting = false;
    };
    raf = requestAnimationFrame(coast);

    const stopCoast = () => {
      coasting = false;
      velocity = 0;
    };

    const ro = new ResizeObserver(() => {
      viewportHRef.current = el.clientHeight;
    });
    ro.observe(el);
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("pointerdown", onPointerDown);
    el.addEventListener("pointermove", onPointerMove);
    el.addEventListener("pointerup", onPointerUp);
    el.addEventListener("pointercancel", onPointerUp);
    el.addEventListener("pointerdown", stopCoast);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("pointerdown", onPointerDown);
      el.removeEventListener("pointermove", onPointerMove);
      el.removeEventListener("pointerup", onPointerUp);
      el.removeEventListener("pointercancel", onPointerUp);
      el.removeEventListener("pointerdown", stopCoast);
    };
  }, [setTarget, reducedMotion]);

  // Paging older is MANUAL — the reader asks for it at the head of the window,
  // in the origin region. There is deliberately no scroll-position trigger: an
  // earlier version fired at `target <= LOAD_OLDER_PX` from an effect keyed on
  // the mounted count, and the mounted count changes while the first
  // measurement pass settles, so arriving alone paged history in. It also fired
  // unconditionally whenever the loaded content was shorter than the threshold.
  // A slice read is a repository call in production; it should be asked for,
  // not inferred.

  // ── Keyboard: the field had NO keyboard scroll at all before this ────────
  // Position here is a camera offset with no scroll container behind it, so
  // there was nothing for the browser to scroll with a key. A reader without a
  // pointer could reach the cards and the links by Tab and could not travel
  // between them except by following those links. The steps mirror a scroll
  // container: a line for the arrows, a viewport for Page, the ends for
  // Home/End — and here the ends mean the oldest loaded slice and the LIVE
  // EDGE, which is this field's "now".
  //
  // A React prop, not `addEventListener` in an effect: see the note in
  // `card-field.tsx` — an effect that runs before its element exists binds
  // nothing and never retries.
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      // Never steal a key from something typed into or activated inside the
      // field — the composer is outside this wrapper, but markdown links and
      // tool cards are not.
      const target = e.target as HTMLElement | null;
      if (
        target &&
        target !== e.currentTarget &&
        target.closest("input, textarea, button, a, [contenteditable]")
      ) {
        return;
      }
      const viewH = viewportHRef.current || e.currentTarget.clientHeight;
      const max = maxOffsetRef.current;
      const min = minOffsetRef.current;
      const page = Math.max(120, viewH * 0.9);
      let next: number;
      switch (e.key) {
        case "ArrowDown":
          next = targetRef.current + 120;
          break;
        case "ArrowUp":
          next = targetRef.current - 120;
          break;
        case "PageDown":
          next = targetRef.current + page;
          break;
        case "PageUp":
          next = targetRef.current - page;
          break;
        case "Home":
          next = min;
          break;
        case "End":
          next = max;
          break;
        default:
          return;
      }
      e.preventDefault();
      setTarget(next);
    },
    [setTarget],
  );

  return (
    // `touch-none` is load-bearing: without it the browser claims the touch
    // gesture for its own panning and no pointermove ever arrives.
    <div
      ref={wrapperRef}
      // The stable hook, mirroring `data-card-field`. `touch-none` used to be
      // the only way to find this element, and that stopped being safe the
      // moment the time rail's scrub surface also took `touch-none` — the rail
      // is rendered BEFORE this in the document, so a `div.touch-none` selector
      // silently started matching the rail instead of the conversation.
      data-conversation-field
      // Focusable for the same reason the card field is: the conversation
      // scrolls in a space with no scroll container, so Tab could reach the
      // cards and the links but never the space between them.
      tabIndex={0}
      role="group"
      aria-label={tField("fieldLabel")}
      onKeyDown={onKeyDown}
      className="relative h-full w-full touch-none overflow-hidden outline-none"
    >
      {/* R3F's Canvas defaults its wrapper to position:relative INLINE, so
          overriding it requires the style prop — the third-party API's shape,
          not a styling choice. Fills the field wrapper. */}
      <Canvas
        orthographic
        camera={{ position: [0, 0, 100], zoom: 1, near: 0.1, far: 1000 }}
        gl={{ antialias: true, alpha: true }}
        style={{ position: "absolute", inset: 0 }}
      >
        <FieldScene
          blocks={blocks}
          liveItems={live}
          briefing={briefing}
          column={column}
          hasOrigin={hasOrigin}
          oldestIso={oldestIso}
          hasMore={hasMore !== false}
          loadingOlder={loadingOlder === true}
          onNeedOlder={onNeedOlder}
          offsetRef={offsetRef}
          dirRef={dirRef}
          heightsRef={heightsRef}
          offsetsRef={offsetsRef}
          minOffset={minOffset}
          maxOffsetRef={maxOffsetRef}
          feed={feed}
          publishing={publishing}
          signalFor={signalFor}
          originSignal={originSignalRef.current}
          messages={messages}
          locale={locale}
          onBlockHeight={onBlockHeight}
          onLiveHeight={onLiveHeight}
          liveHeightRef={liveHeightRef}
          onMountCount={setMountedCount}
        />
      </Canvas>

      {/* §1.3: mobile keeps the floating time pill. The desktop left rail is
          retired — the 3D axis carries time. */}
      {isMobile && (
        <StreamTimeIndicator timeIso={topTime} visible={indicatorVisible} />
      )}

      {error && <ErrorBanner error={error} />}
    </div>
  );
}
