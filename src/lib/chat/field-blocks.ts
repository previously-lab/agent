/**
 * The conversation field's block model — pure, no React, no three.js.
 *
 * The field lays the stream out as a vertical run of BLOCKS, each anchored by
 * its top edge. A block is one slice's region, and the gate that follows it —
 * the `seam` between that slice and the next — is its bottom edge. This module
 * owns that grouping, the fixed sizes the layout assumes, and the rule that
 * decides which boundary is currently announcing itself.
 *
 * It was lifted out of `conversation-field.tsx` because every one of these was
 * already pure: they take a stream item list and return numbers or strings.
 * Living inside the component meant they could only be checked by driving the
 * whole R3F field in a browser, which is a bad price for arithmetic.
 */

import type { ChatStreamItem } from "./stream-items";

/**
 * The height of a slice gate, in px — FIXED, and the constant is load-bearing
 * twice over.
 *
 * The field's offset table is only stable if a block's height is a function of
 * its CONTENT, never of what the reader happens to be looking at. So the gate
 * announces itself by changing what is painted inside its box, never the box.
 * If the box ever varied with the armed state, arming a gate would move every
 * block below it — the exact failure the whole field architecture exists to
 * avoid.
 *
 * The second reason is arithmetic: the field needs to know where a gate's band
 * ends without measuring it (see `armedGate`), and a constant is how it knows.
 * `SliceGate` renders at exactly this height; Tailwind `h-32` is 128px.
 */
export const SLICE_GATE_PX = 128;

/**
 * The height of the field's ORIGIN region — the strip above the oldest loaded
 * block, where the reader is told they have reached the head of the window and
 * is offered the older page.
 *
 * It sits at a CONSTANT world offset of `-FIELD_ORIGIN_PX`, one region above
 * block 0. That is what makes "load older" behave: the blocks a page brings in
 * land between the origin and the old head, so the origin is always above
 * everything, and the camera compensation (see `prependHeadCount`) leaves the
 * reader's view exactly where it was — with the new content off-screen above
 * them, to be scrolled into.
 */
export const FIELD_ORIGIN_PX = 128;

/**
 * The scroll range's LOWER bound — how far above its oldest unit a field can
 * travel, in px: one full head when there is one, zero when there is not.
 *
 * The head is a region the reader scrolls INTO, so a field that has one scrolls
 * one region above its oldest unit; a field without one bottoms out at its
 * oldest unit's top edge. Both fields render a head now (the card rungs gained
 * theirs with `timeline-3d/origin-row.tsx`), and every clamp, every seek and
 * `progressFor` must be handed the SAME number: a range whose floor disagrees
 * with the clamp is a progress readout that saturates before the reader reaches
 * the end — the failure `field-feed.ts` documents at length.
 */
export function originMinOffset(hasOrigin: boolean): number {
  return hasOrigin ? -FIELD_ORIGIN_PX : 0;
}

/** The band index `armedGate` returns for the origin region. */
export const ORIGIN_REGION = -1;

/*
 * The conversation column's width used to be here, as a flat `680`. It is now
 * viewport-derived and lives in `@/lib/layout/tiers` (`columnFor`) with the
 * rest of the responsive table — a single field could be a constant, but a
 * phone cannot afford one. The invariant this comment used to carry still
 * holds and is now enforced by there being one function: the column width is
 * ONE number per render, shared by `conversation-field.tsx` and
 * `conversation-unit.tsx`, or the same slice reflows when the reader changes
 * rung. Both call `columnFor(window.innerWidth)`; neither re-derives it.
 */

/**
 * How close to the top clamp counts as "at the head of the window", in px.
 * Within this the origin speaks rather than whichever gate happens to be
 * nearest the middle of the screen.
 *
 * Half the origin's height: the window is exactly "at least half the origin is
 * on screen". A boundary that has scrolled fully out of view must not announce
 * itself from off-stage, and at the top clamp the origin is the whole story.
 */
export const ORIGIN_SLOP_PX = FIELD_ORIGIN_PX / 2;

/** Everything up to the first trailing `live` item is history, the rest is the
 *  live run. stream-items.ts builds them in that order, so this is one split
 *  rather than a scan carrying state. */
export function splitItems(items: readonly ChatStreamItem[]): {
  history: ChatStreamItem[];
  live: ChatStreamItem[];
} {
  const firstLive = items.findIndex((i) => i.kind === "live");
  if (firstLive < 0) return { history: [...items], live: [] };
  return {
    history: items.slice(0, firstLive),
    live: items.slice(firstLive),
  };
}

/** The slice a stream item belongs to, or null for the live run. Seam and
 *  resume keys carry the slice id (`seam-<id>` / `resume-<id>`), which is the
 *  same convention the retired virtualized list read them with. */
export function sliceIdOf(item: ChatStreamItem): string | null {
  switch (item.kind) {
    case "history-turn":
      return item.sliceId;
    case "seam":
      return item.key.slice("seam-".length);
    case "resume-banner":
      return item.key.slice("resume-".length);
    default:
      return null;
  }
}

export interface StreamBlock {
  /** The opening item's key — identity WITHIN a rendering, e.g. a React key. */
  key: string;
  /**
   * The slice this block's content belongs to, or null for the briefing card.
   *
   * This, not `key`, is the block's STABLE identity. A block holds a slice's
   * turns, and the turns are keyed by slice AND by their index within it, so
   * the key is stable too — until a page of older slices arrives and the
   * oldest block gains the seam that now precedes it. Which is exactly the
   * event prepend detection is looking for, which is why it reads this field
   * and not the key.
   */
  sliceId: string | null;
  items: ChatStreamItem[];
  /** Every strand any of the block's turns carries, in first-seen order. */
  strands: string[];
  /** True when the block ENDS with a slice gate — the boundary between this
   *  slice and the next. The last block in the window has none: nothing
   *  follows it to cross. */
  gate: boolean;
}

/**
 * Group the stream into blocks. A block is ONE SLICE'S REGION, and the gate
 * that follows it is its bottom edge.
 *
 * WHICH SIDE OF A GATE OWNS IT IS NOT A STYLE CHOICE. The gate sits between two
 * slices and looks identical either way, but the layout consequences are not:
 * a block is measured and then frozen, so anything added to it moves every
 * block below. Attaching the gate to the slice it OPENS means that when a page
 * of older slices arrives, the seam that now precedes the old head is attached
 * to the OLD HEAD — the reader's own block grows by a gate's height under them,
 * and their text slides down by exactly that much while the camera is tracking
 * something else. Attaching it to the slice it CLOSES puts that seam in the
 * region that just arrived, leaves every existing block byte-identical, and
 * makes the prepend compensation exact.
 *
 * So: turns append to the open block, a gate closes the open block, and a
 * resume banner opens a new one. The stream itself is unchanged — the gate
 * still renders between the two slices, at the same pixel.
 */
export function groupBlocks(history: readonly ChatStreamItem[]): StreamBlock[] {
  const out: StreamBlock[] = [];
  let previous: ChatStreamItem["kind"] | null = null;
  for (const item of history) {
    // A block opens on the item AFTER a gate (so the gate belongs to the block
    // above it) and at a resume banner, which is a boundary the stream states
    // outright. Everything else joins the block already open.
    if (out.length === 0 || item.kind === "resume-banner" || previous === "seam") {
      out.push({
        key: item.key,
        sliceId: sliceIdOf(item),
        items: [],
        strands: [],
        gate: false,
      });
    }
    const block = out[out.length - 1];
    block.items.push(item);
    if (item.kind === "seam") {
      // The gate closes the region above it. `gate` being true means this
      // block ENDS with a boundary; the band reads its position from the
      // block's tail, not its head.
      block.gate = true;
    } else if (item.kind === "history-turn") {
      for (const s of item.strands ?? []) {
        if (!block.strands.includes(s)) block.strands.push(s);
      }
    }
    previous = item.kind;
  }
  return out;
}

/**
 * How many blocks sit at the HEAD of `next` that were not in `prev` — the
 * count of blocks a prepend added, accumulated across prepends.
 *
 * Takes each block's STABLE ID (`StreamBlock.sliceId`), not its key. That
 * distinction is the difference between this working and silently returning
 * zero forever: the oldest block in the window opens with a turn, and gains a
 * seam the instant a page lands above it, so its key always changes on exactly
 * the event being detected. Its slice does not.
 *
 * The question then reduces to: where did the old head go? Its new index IS
 * the number of blocks that arrived above it. No suffix matching, no guessing
 * about what else might have moved — a prepend adds above the head and touches
 * nothing else, and this reads exactly that.
 *
 * `previous` is the running total, or `null` for the first list the field ever
 * saw. That first list is a plain initial fill, not a prepend: the camera is
 * arriving at the live edge anyway, so compensating for it would be a jump
 * with nothing to preserve. It therefore seeds the baseline at zero.
 *
 * Idempotent on purpose — calling it twice with the same `next` yields the
 * same total, which matters because React may run a render-phase computation
 * more than once.
 */
export function prependHeadCount(
  previous: number | null,
  prevIds: readonly (string | null)[],
  nextIds: readonly (string | null)[],
): number {
  if (previous === null || prevIds.length === 0) return 0;
  const headId = prevIds[0];
  // A head with no slice id (the briefing card) has no stable identity to look
  // up, and an id that is gone entirely cannot be reached by a prepend.
  if (headId === null) return previous;
  const headIndex = nextIds.indexOf(headId);
  if (headIndex <= 0) return previous;
  return previous + headIndex;
}

/**
 * What the field tells one boundary each frame.
 *
 * A mutable object rather than props on purpose: the arm state flips while
 * scrolling, every gate is its own `<Html>` React root, and a re-render per
 * crossing to swap two words is exactly the cost the field's design keeps
 * out. The gate reads this in its own frame loop and writes to the DOM.
 */
export interface GateSignal {
  /** True while this boundary is the one announcing itself. */
  armed: boolean;
  /** Which way the reader is travelling — decides which side speaks. */
  dir: "past" | "future";
}

/** One boundary the reader can be looking at. */
export interface GateBand {
  /** Block index, or `ORIGIN_REGION` for the head of the loaded window. */
  index: number;
  /** World offset of the band's top edge, px. */
  top: number;
  /** The band's height, px. */
  height: number;
}

/**
 * Every boundary the field could announce this frame, in unit order — the
 * producer to `armedGate`'s consumer, kept beside it because the two are one
 * mechanism: this says where the boundaries ARE, `armedGate` says which one is
 * speaking.
 *
 * A GATE BELONGS TO THE UNIT IT CLOSES, so its band sits at that unit's TAIL,
 * never its head. Getting this backwards is not a cosmetic error: the seam
 * arriving with a fresh page would then land inside the reader's own block and
 * grow it by a gate's height underneath them.
 *
 * The head of the window is a boundary too (`ORIGIN_REGION`) when the window
 * has one — the one edge with no slice beyond it, which `armedGate` lets win
 * outright.
 *
 * `fallbackExtent` covers the frames between a unit list growing and its offset
 * table being rebuilt, when the last units have no measured extent yet.
 *
 * Fills a CALLER-OWNED array and empties it first: this runs once per frame,
 * and the field already keeps a persistent buffer for it precisely so the frame
 * loop is not allocating a list sixty times a second.
 */
export function gateBands(
  out: GateBand[],
  count: number,
  closesBoundaryOf: (index: number) => boolean,
  tops: readonly number[],
  fallbackExtent: number,
  hasOrigin: boolean,
): GateBand[] {
  out.length = 0;
  if (hasOrigin) {
    out.push({
      index: ORIGIN_REGION,
      top: -FIELD_ORIGIN_PX,
      height: FIELD_ORIGIN_PX,
    });
  }
  for (let i = 0; i < count; i++) {
    // Whether a unit closes a boundary is the CALLER's rule, not a property of
    // the unit: the conversation's blocks carry the answer (`groupBlocks` sets
    // `gate` from where a seam landed), while a card row closes one simply by
    // not being the last. Taking a predicate keeps both honest instead of
    // making one of them fake a field it does not have.
    if (!closesBoundaryOf(i)) continue;
    const start = tops[i] ?? 0;
    const height = (tops[i + 1] ?? start + fallbackExtent) - start;
    out.push({
      index: i,
      top: start + Math.max(0, height - SLICE_GATE_PX),
      height: SLICE_GATE_PX,
    });
  }
  return out;
}

/**
 * Which boundary is announcing itself right now, or `null` when the reader is
 * inside a slice and no boundary is on screen.
 *
 * THE RULE IS LOCAL, and that is the whole point. An earlier version kept one
 * direction flag for the entire field, so a single wheel tick flipped every
 * gate on screen at once — gates nowhere near the reader claimed to be
 * crossing. Here each boundary answers for itself: it announces when it is
 * actually IN view, and when several are, the one nearest the middle of the
 * screen wins. So exactly one boundary ever speaks, and it is the one the
 * reader is looking at.
 *
 * At the head of the window the origin takes precedence over that rule: being
 * at the very top is itself the announcement.
 */

export function armedGate(
  bands: readonly GateBand[],
  viewTop: number,
  viewportH: number,
  minOffset: number,
): number | null {
  if (bands.length === 0) return null;

  if (viewTop <= minOffset + ORIGIN_SLOP_PX) {
    const origin = bands.find((b) => b.index === ORIGIN_REGION);
    if (origin) return ORIGIN_REGION;
  }

  const viewBottom = viewTop + viewportH;
  const centre = viewTop + viewportH / 2;
  let best: number | null = null;
  let bestDistance = Infinity;
  for (const band of bands) {
    const bottom = band.top + band.height;
    // A band that only shares an edge with the viewport has zero visible area,
    // and a boundary the reader cannot see does not speak.
    if (bottom <= viewTop || band.top >= viewBottom) continue;
    const distance =
      centre < band.top
        ? band.top - centre
        : centre > bottom
          ? centre - bottom
          : 0;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = band.index;
    }
  }
  return best;
}
