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
 * came back 32–64 px away because something else had moved it. Here the
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
 * SCALE IS NOT A CONCERN. Only the blocks crossing the viewport, plus one
 * screen of overscan, exist as portals. The rest are numbers in an offset
 * table, so the mounted count is a handful however long the conversation gets.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Html } from "@react-three/drei";
import { NextIntlClientProvider, useLocale, useMessages } from "next-intl";
import type { ChatStreamItem } from "@/lib/chat/stream-items";
import type { FieldAnchor } from "@/lib/timeline3d/winding";
import { SliceGate } from "./slice-gate";
import { HistoryTurn } from "./history-turn";
import { ChatMessage } from "./chat-message";
import { ResumeBanner } from "./resume-banner";
import { EmptyBriefing } from "./empty-briefing";

/** The conversation column's width — and, orthographic camera at zoom 1, its
 *  width in world units. One world unit is one CSS pixel, so the numbers here
 *  are the numbers on screen and the text is never scaled. */
const COLUMN_PX = 680;
/** How far outside the viewport a block stays mounted. */
const OVERSCAN_PX = 1200;
/** The reader is this close to the top of what is loaded → ask for older. */
const LOAD_OLDER_PX = 600;
/** Follow fraction per frame; higher is snappier, lower is floatier. */
const FOLLOW = 0.22;
/** Height assumed for a block that has not reported yet. Only ever applies to
 *  offscreen history, and it is replaced the moment the block measures. */
const FALLBACK_BLOCK_PX = 320;

/** What a caller outside the field can ask it to do. Filled into a ref rather
 *  than exposed through a component ref, matching `anchorsRef`/`progressRef` —
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
}

export interface ConversationFieldProps {
  items: ChatStreamItem[];
  /** Screen-Y anchors for the left band — the same contract the card field
   *  publishes in the timeline view, so the band needs no second code path. */
  anchorsRef?: React.MutableRefObject<FieldAnchor[]>;
  /** 0..1 through the content, for the band's ruler and rotation drift. */
  progressRef?: React.MutableRefObject<number>;
  /** Filled with the imperative handle; see `ConversationFieldHandle`. */
  apiRef?: React.MutableRefObject<ConversationFieldHandle | null>;
  /** Called when the reader reaches the top of what is loaded. */
  onNeedOlder: () => void;
  /** Briefing payload, seated as the tail card exactly as in the stream. */
  briefing?: React.ComponentProps<typeof EmptyBriefing> | null;
  /** False while the reader has scrolled away from the live edge — growth must
   *  then move nothing at all. Omitted, the field tracks it itself. */
  following?: boolean;
}

interface Block {
  key: string;
  items: ChatStreamItem[];
  strands: string[];
}

/** Everything up to the first trailing `live` item is history, the rest is the
 *  live run. stream-items.ts builds them in that order, so this is one split
 *  rather than a scan carrying state. */
function splitItems(items: ChatStreamItem[]): {
  history: ChatStreamItem[];
  live: ChatStreamItem[];
} {
  const firstLive = items.findIndex((i) => i.kind === "live");
  if (firstLive < 0) return { history: items, live: [] };
  return { history: items.slice(0, firstLive), live: items.slice(firstLive) };
}

/** A new block starts at each seam and each resume banner — the same
 *  boundaries the stream itself uses. */
function groupBlocks(history: ChatStreamItem[]): Block[] {
  const out: Block[] = [];
  for (const item of history) {
    if (item.kind === "seam" || item.kind === "resume-banner" || out.length === 0) {
      out.push({ key: item.key, items: [], strands: [] });
    }
    const block = out[out.length - 1];
    block.items.push(item);
    if (item.kind === "history-turn") {
      for (const s of item.strands ?? []) {
        if (!block.strands.includes(s)) block.strands.push(s);
      }
    }
  }
  return out;
}

/** One stream item, in its plain form. Shared by history blocks and the live
 *  block so the two cannot drift apart visually. */
function renderStreamItem(
  item: ChatStreamItem,
  briefing?: ConversationFieldProps["briefing"],
) {
  switch (item.kind) {
    case "seam":
      // The gate REPLACES the hairline divider in the field. It carries the
      // same two times the seam did, but as a region tall enough for the band
      // to unwind in — a release needs somewhere to happen.
      return (
        <SliceGate
          dateIso={item.dateIso}
          prevActivityIso={item.prevActivityIso}
        />
      );
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
 * mean forking them.
 */
function BillboardBlock({
  blockKey,
  items,
  briefing,
  messages,
  locale,
  /** Called with the block's DOM height whenever it settles. */
  onHeight,
}: {
  blockKey: string;
  items: ChatStreamItem[];
  briefing?: ConversationFieldProps["briefing"];
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
          <div key={item.key}>{renderStreamItem(item, briefing)}</div>
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
  /** Eased camera offset, px — read every frame, never a prop. */
  offsetRef: React.MutableRefObject<number>;
  /** Measured DOM height per history block. */
  heightsRef: React.MutableRefObject<number[]>;
  /** Running world offset of each block's top, derived from the heights. */
  offsetsRef: React.MutableRefObject<number[]>;
  anchorsRef?: React.MutableRefObject<FieldAnchor[]>;
  progressRef?: React.MutableRefObject<number>;
  messages: ReturnType<typeof useMessages>;
  locale: string;
  onBlockHeight: (index: number, h: number) => void;
  onLiveHeight: (h: number) => void;
  onMountCount: (n: number) => void;
}

function FieldScene({
  blocks,
  liveItems,
  briefing,
  offsetRef,
  heightsRef,
  offsetsRef,
  anchorsRef,
  progressRef,
  messages,
  locale,
  onBlockHeight,
  onLiveHeight,
  onMountCount,
}: SceneProps) {
  const group = useRef<THREE.Group>(null);
  const { size } = useThree();
  // The mounted set is React state because it decides which portals exist; it
  // changes only when the window crosses a block boundary, never per frame.
  const [visible, setVisible] = useState<number[]>([]);
  const visibleKey = useRef("");
  const statsKey = useRef("");

  useFrame(() => {
    if (group.current) {
      group.current.position.y = size.height / 2 + offsetRef.current;
    }

    const offsets = offsetsRef.current;
    const top = offsetRef.current - OVERSCAN_PX;
    const bottom = offsetRef.current + size.height + OVERSCAN_PX;
    const next: number[] = [];
    for (let i = 0; i < blocks.length; i++) {
      const start = offsets[i] ?? 0;
      const end = offsets[i + 1] ?? start + FALLBACK_BLOCK_PX;
      if (end < top || start > bottom) continue;
      next.push(i);
    }
    const key = next.join(",");
    if (key !== visibleKey.current) {
      visibleKey.current = key;
      setVisible(next);
    }
    if (String(next.length) !== statsKey.current) {
      statsKey.current = String(next.length);
      onMountCount(next.length);
    }

    if (anchorsRef) {
      const total = offsets[blocks.length] ?? 1;
      if (progressRef) {
        progressRef.current = total > 0 ? offsetRef.current / total : 1;
      }
      const list: FieldAnchor[] = [];
      for (const i of next) {
        const start = offsets[i] ?? 0;
        const h = (offsets[i + 1] ?? start + FALLBACK_BLOCK_PX) - start;
        list.push({
          y: (start + h / 2 - offsetRef.current) / size.height,
          strands: blocks[i].strands,
          span: h / size.height,
        });
      }
      anchorsRef.current = list;
    }
  });

  const offsets = offsetsRef.current;
  const liveTop = offsets[blocks.length] ?? 0;

  return (
    <group ref={group}>
      {visible.map((i) => (
        <Html
          // NOT `transform`: screen-space mode positions the element by
          // projection and leaves it at 1:1, so text is never scaled.
          key={blocks[i].key}
          position={[-COLUMN_PX / 2, -(offsets[i] ?? 0), 0]}
          zIndexRange={[10, 0]}
          style={{ width: COLUMN_PX }}
        >
          <BillboardBlock
            blockKey={blocks[i].key}
            items={blocks[i].items}
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
          key="live"
          position={[-COLUMN_PX / 2, -liveTop, 0]}
          zIndexRange={[10, 0]}
          style={{ width: COLUMN_PX }}
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
  anchorsRef,
  progressRef,
  apiRef,
  onNeedOlder,
  briefing,
  following,
}: ConversationFieldProps) {
  const messages = useMessages();
  const locale = useLocale();

  const { history, live } = useMemo(() => splitItems(items), [items]);
  const blocks = useMemo(() => groupBlocks(history), [history]);

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

  /** The direction the reader last moved, written straight onto the wrapper as
   *  a data attribute. The slice gates read it to choose which of their two
   *  times to show; see `SliceGate` for why this is not React state. */
  const dirRef = useRef<"past" | "future">("future");

  /** The ONLY way the camera moves. Clamping, the follow state and the
   *  direction attribute live together so no input path can leave them
   *  disagreeing. */
  const setTarget = useCallback(
    (next: number) => {
      const max = maxOffsetRef.current;
      const clamped = Math.min(max, Math.max(0, next));
      const prev = targetRef.current;
      targetRef.current = clamped;
      if (following === undefined) followingRef.current = clamped >= max - 4;
      if (clamped !== prev) {
        const dir = clamped < prev ? "past" : "future";
        if (dir !== dirRef.current) {
          dirRef.current = dir;
          const el = wrapperRef.current;
          if (el) el.dataset.dir = dir;
        }
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
    const next: number[] = [0];
    let carry = h.find((v) => v > 0) ?? FALLBACK_BLOCK_PX;
    for (let i = 0; i < blocks.length; i++) {
      if (h[i] > 0) carry = h[i];
      next.push(next[i] + carry);
    }
    offsetsRef.current = next;
  }, [blocks.length]);

  useEffect(() => {
    relayout();
    forceRender((n) => n + 1);
  }, [relayout]);

  const historyTotal = offsetsRef.current[blocks.length] ?? 0;
  const totalPx = historyTotal + liveHeightRef.current;
  const maxOffset = Math.max(0, totalPx - viewportHRef.current);
  maxOffsetRef.current = maxOffset;

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
        for (let i = 0; i < blocks.length; i++) {
          if (blocks[i].items.some((it) => it.key === key)) {
            setTarget(offsetsRef.current[i] ?? 0);
            return true;
          }
        }
        if (key === "live" && live.length > 0) {
          setTarget(offsetsRef.current[blocks.length] ?? 0);
          return true;
        }
        return false;
      },
      scrollToOffset(px) {
        setTarget(px);
      },
      offset() {
        return offsetRef.current;
      },
    };
    return () => {
      apiRef.current = null;
    };
  }, [apiRef, blocks, live.length, setTarget]);

  // The eased follow. A rAF rather than `useFrame` because the position must
  // keep advancing even if the canvas is briefly idle.
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const d = targetRef.current - offsetRef.current;
      if (d !== 0) {
        offsetRef.current += Math.abs(d) < 0.5 ? d : d * FOLLOW;
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

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
      coasting = Math.abs(velocity) > 0.25;
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
  }, [setTarget]);

  // Prefetch when the reader nears the top of what is loaded.
  useEffect(() => {
    if (targetRef.current <= LOAD_OLDER_PX) onNeedOlder();
  }, [onNeedOlder, mountedCount]);

  return (
    // `touch-none` is load-bearing: without it the browser claims the touch
    // gesture for its own panning and no pointermove ever arrives.
    <div
      ref={wrapperRef}
      data-dir="future"
      className="relative h-full w-full touch-none overflow-hidden"
    >
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
          offsetRef={offsetRef}
          heightsRef={heightsRef}
          offsetsRef={offsetsRef}
          anchorsRef={anchorsRef}
          progressRef={progressRef}
          messages={messages}
          locale={locale}
          onBlockHeight={onBlockHeight}
          onLiveHeight={onLiveHeight}
          onMountCount={setMountedCount}
        />
      </Canvas>

      <div className="pointer-events-none absolute right-3 top-3 z-50 rounded-md bg-card/90 px-3 py-2 font-mono text-[10px] leading-relaxed text-muted-foreground ring-1 ring-foreground/10">
        <div>conversation field</div>
        <div>
          blocks {blocks.length} · mounted {mountedCount}
        </div>
        <div>
          offset {Math.round(offsetRef.current)} / {Math.round(maxOffset)}
        </div>
      </div>
    </div>
  );
}
