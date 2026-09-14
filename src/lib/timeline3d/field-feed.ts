/**
 * The field feed (v0.13) — everything the left band needs to know about the
 * right pane, in one object with one writer.
 *
 * WHY THIS EXISTS. The band reads four things off whatever is in the right
 * pane: how far through the content the reader is, what zoom they are at, where
 * the visible units sit, and which boundary is announcing itself. Those were
 * four separate `MutableRefObject`s, created by the shell and handed to BOTH
 * renderers, each with its own ad-hoc rule about who was allowed to write it.
 *
 * Four refs is not the problem. FOUR WRITERS IS. The chat field and the card
 * field are both mounted whenever the timeline view is open — one behind the
 * other — and both wrote `progressRef` every frame, so which one the band saw
 * was decided by render order. The ad-hoc half-fix was already visible in the
 * shell: `crossingRef` was passed to the chat as
 * `anchorsActive ? crossingRef : undefined` while `progressRef` was passed
 * unconditionally, so exactly one of the four had an ownership rule and the
 * other three did not.
 *
 * So this module states the rule once, as a fact about the object rather than a
 * habit of its callers: A FIELD PUBLISHES ONLY WHILE IT OWNS THE PANE. The
 * shell says which one that is (`publishing`), and the other writes nothing —
 * not "writes the same value", nothing. There is no ordering to get wrong
 * because there is no second writer.
 *
 * It is a mutable object and not a ref TO one. The fields run their writes in a
 * frame loop that must not re-render, so the thing they write has to be shared
 * mutable state; making callers wrap it in a ref would be a second layer of the
 * same idea, and the one that gets forgotten when a new field is added.
 */
import type { FieldAnchor } from "./winding";
import { DEFAULT_LEVEL, type StackLevel } from "./stacks";

/**
 * Where the announcing boundary sits, or `null` when the reader is inside a
 * unit and none is speaking.
 *
 * A screen-Y FRACTION of the shared viewport height rather than a pixel offset:
 * the band is a fixed 32px strip and the field is the whole pane, so the two
 * have different heights and the fraction is the only thing that maps onto both
 * without a second measurement. It lived in the chat renderer until every
 * consumer of it — the card field, the timeline scene, the shell — turned out
 * to be somewhere else.
 */
export interface CrossingMark {
  y: number | null;
}

/**
 * What the right pane publishes to the left band, every frame.
 *
 * Mutated in place. Nothing sets React state through it and nothing should:
 * these are read sixty times a second by three different rAF loops, which is
 * the one place in this app where a re-render per value is not an option.
 */
/**
 * A SEEK REQUEST — the band asking the field to jump somewhere.
 *
 * This is the ONE thing in the feed that flows the other way, and it is worth
 * being explicit about why it is not a violation of the one-writer rule above.
 * The rule exists because `progress` is DERIVED — the field computes it from
 * its rig every frame, so a second writer would be overwritten and the band
 * would be lying about where the reader is. A seek is not a claim about where
 * the reader is; it is an instruction. The band writes the request, the field
 * reads it, nothing is derived from it, and no value is ever contested.
 *
 * It is deliberately NOT `progress` written from the band. Writing `progress`
 * would be overwritten on the next frame and the band's own scrubber would
 * spring back under the reader's finger — the failure the one-writer rule was
 * written to prevent, arrived at from the other direction.
 */
export interface SeekRequest {
  /** 0 = the oldest thing loaded, 1 = now — `progress`'s own scale, inverted
   *  by `offsetFor`, which is `progressFor` read backwards. */
  progress: number;
  /** Monotonic. The field consumes a request by `gen`, so a frame that sees
   *  the same request twice seeks once — and a re-render that republishes the
   *  same object does not move the reader a second time. */
  gen: number;
  /** True for the frames the pointer is still down: the field tracks the
   *  finger EXACTLY rather than easing toward it, because a scrubber that
   *  eases is a scrubber that lags the thing doing the scrubbing. */
  dragging: boolean;
}

export interface FieldFeed {
  /** 0 = the oldest thing loaded, 1 = now. */
  progress: number;
  /** The zoom the field is at. The band scales its braid by this, because the
   *  band's scale is a statement about the content's grouping — see the note on
   *  `CardFieldProps.levelRef`, which is why the two finest rungs, sharing a
   *  grouping, share a level here too. */
  level: StackLevel;
  /** The visible units, as screen-Y fractions plus the strands each carries. */
  anchors: FieldAnchor[];
  /** Where the announcing boundary sits. */
  crossing: CrossingMark;
  /** A pending instruction from the band, or null. See `SeekRequest`. */
  seek: SeekRequest | null;
}

export function createFieldFeed(): FieldFeed {
  return {
    // 1, not 0: an empty field is at the present, and a band drawing a
    // freshly-mounted field at its oldest end would swing to zero and back on
    // every view switch.
    progress: 1,
    level: DEFAULT_LEVEL,
    anchors: [],
    crossing: { y: null },
    seek: null,
  };
}

/**
 * Ask the field to jump. THE way to publish a seek.
 *
 * The generation is derived from the feed's own last request rather than from a
 * counter private to the caller, so any number of controls can publish without
 * coordinating: each one simply takes the next number. A per-caller counter
 * works until the second caller exists, and then two buttons in different
 * components can hand the field the same generation and the field — which
 * consumes by generation, precisely so a re-published request does not move the
 * reader twice — would silently drop one of them.
 */
export function requestSeek(
  feed: FieldFeed,
  progress: number,
  dragging = false,
): void {
  const t = progress < 0 ? 0 : progress > 1 ? 1 : progress;
  feed.seek = { progress: t, gen: (feed.seek?.gen ?? 0) + 1, dragging };
}

/**
 * `progressFor` read BACKWARDS — the offset a seek's progress names.
 *
 * The two are one equation and belong together: `progressFor` normalises an
 * offset into 0..1, this denormalises it, and `field-feed.test.ts` asserts they
 * round-trip. Written as its own function rather than inlined at the call site
 * so that stays provable.
 */
export function offsetFor(
  progress: number,
  minOffset: number,
  maxOffset: number,
): number {
  const t = progress < 0 ? 0 : progress > 1 ? 1 : progress;
  return minOffset + t * (maxOffset - minOffset);
}

/**
 * Relax the feed — the pane that was publishing is gone or has stopped.
 *
 * Cleared rather than left alone, because a frozen feed is a lie the band
 * cannot distinguish from a still one: the previous field's anchors would keep
 * the braid wound around units that are no longer on screen. The reader's
 * position (`progress`) is deliberately NOT reset — the band is a scale, and a
 * scale that jumps back to the beginning when a pane unmounts is worse than one
 * that holds where the reader was.
 */
export function clearFeed(feed: FieldFeed): void {
  feed.anchors = [];
  feed.crossing.y = null;
}

/**
 * How far through the content the reader is, as 0..1 — THE one progress rule.
 *
 * The two fields used to compute this differently: the card field as
 * `offset / (total - fieldH)`, the chat field as
 * `(offset - minOffset) / (total - minOffset)`. Both are the same statement —
 * "how far into the scrollable range" — about ranges with different lower
 * bounds, and the difference was not a decision anybody made. Stating it as a
 * range makes the lower bound a number the caller passes instead of a formula
 * it re-derives — and both fields now pass the same one: each has an ORIGIN
 * region above its oldest unit (`originMinOffset`), so the band's ruler means
 * the same thing at every rung.
 *
 * Content that fits entirely in the pane reports 1: there is nowhere to scroll
 * to, and the reader is already looking at the present. Reporting 0 there would
 * peg the band's ruler to the oldest end of a memory the reader can see all of.
 */
export function progressFor(
  offset: number,
  minOffset: number,
  maxOffset: number,
): number {
  const span = maxOffset - minOffset;
  if (!(span > 0)) return 1;
  const t = (offset - minOffset) / span;
  return t < 0 ? 0 : t > 1 ? 1 : t;
}
