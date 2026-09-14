/**
 * The offset table (v0.13) — the running layout both fields stand on.
 *
 * The conversation field and the card field had grown two answers to the same
 * question, "where does each unit start, in pixels". The card field could state
 * it in closed form — `i * pitch`, because every card is the same size — and
 * its own comment made a virtue of never measuring the DOM. The conversation
 * field could not: a block of turns is exactly as tall as its text, so it kept
 * a table of MEASURED heights. Those are one table with two `heightOf`s, and
 * merging the two renderers means there can be only one.
 *
 * WHY THE CARRY IS NOT AN OPTIMISATION. A block that has not reported its height
 * yet must not move the ones above it — the field's whole contract is "a block
 * that grows grows DOWNWARD and moves nothing above it". So the table walks a
 * RUNNING height: an index with no measurement inherits the last real one
 * instead of collapsing to zero. Seeding that running height from the first
 * positive measurement anywhere in the table (not the first one encountered) is
 * what keeps the head of a freshly-paged window from sitting at the wrong
 * offset for the frames before it measures.
 *
 * The units here are INDICES, not objects. The caller owns whatever it is
 * laying out and supplies the height; that keeps the arithmetic testable with
 * no scene, which is the thing the field's layout most needed.
 */

/**
 * A running start offset per unit: `tops.length === count + 1`, so the last
 * entry is the total extent and every unit's own extent is
 * `tops[i + 1] - tops[i]`.
 *
 * A bare array rather than an object, because the field's frame loop reads it
 * sixty times a second and a wrapper would be one allocation per frame for a
 * length the caller already knows.
 */
export type OffsetTops = readonly number[];

/** The table plus the one number a caller usually wants off the end of it. */
export interface OffsetTable {
  tops: number[];
  /** The total extent of every unit, `tops[count]`. */
  total: number;
}

/**
 * Build the running offset table for `count` units.
 *
 * `heightOf(i)` is called up to twice per index (once to seed the running
 * height, once to walk), so it must be pure and cheap — every caller today
 * either reads an array or evaluates a formula.
 *
 * `fallbackExtent` is what a unit with no height at all is assumed to occupy,
 * used only until some unit reports a real one.
 */
export function buildOffsets(
  count: number,
  heightOf: (index: number) => number,
  fallbackExtent: number,
): OffsetTable {
  // The seed is the first POSITIVE height anywhere in the table, not the first
  // one encountered: a window whose head has not measured yet still sizes
  // itself like the blocks it is made of rather than like an estimate.
  let carry = fallbackExtent;
  for (let i = 0; i < count; i++) {
    const h = heightOf(i);
    if (h > 0) {
      carry = h;
      break;
    }
  }
  const tops: number[] = [0];
  for (let i = 0; i < count; i++) {
    const h = heightOf(i);
    if (h > 0) carry = h;
    tops.push(tops[i] + carry);
  }
  return { tops, total: tops[count] };
}

/**
 * The units intersecting the viewport, in order — the ONE virtualization rule.
 *
 * `margin` is how far past the viewport a unit stays mounted. It is generous on
 * purpose in both fields: mounting is cheap next to a reflow, and a unit that
 * unmounts just off-screen takes its measured height with it, so the table
 * would lose a measurement the reader is one flick away from needing again.
 *
 * A unit is `[tops[i], tops[i + 1])`. When the table is SHORTER than the unit
 * count — the frames between a list growing and its table being rebuilt — the
 * last units fall back to `fallbackExtent` rather than vanishing.
 */
export function visibleRangeFor(
  tops: OffsetTops,
  count: number,
  scrollPx: number,
  fieldH: number,
  margin: number,
  fallbackExtent: number,
): number[] {
  const top = scrollPx - margin;
  const bottom = scrollPx + fieldH + margin;
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const start = tops[i] ?? 0;
    const end = tops[i + 1] ?? start + fallbackExtent;
    if (end < top || start > bottom) continue;
    out.push(i);
  }
  return out;
}

/**
 * The scroll that puts unit `anchorIdx`'s CENTRE at screen-Y `screenY`, clamped
 * to the content.
 *
 * Stating it as "where the anchor's centre should land" rather than "centre the
 * anchor" is the difference between a zoom that keeps the reader's place and
 * one that does not: a rung change re-anchors, and re-anchoring must preserve
 * the anchor's screen offset (which is what the reader was looking at), not
 * move it to the middle of the viewport.
 */
export function anchorScrollFor(
  tops: OffsetTops,
  anchorIdx: number,
  anchorHeight: number,
  screenY: number,
  minOffset: number,
  maxOffset: number,
): number {
  const raw = (tops[anchorIdx] ?? 0) + anchorHeight / 2 - screenY;
  return Math.min(maxOffset, Math.max(minOffset, raw));
}

/**
 * The unit containing `px`, by binary search — or -1 when the table is empty.
 *
 * The companion to `anchorScrollFor`: one asks "where should this unit be",
 * this asks "which unit is here". Both are needed because a rung change reads
 * the first to write the second's answer back.
 */
export function unitAtPx(tops: OffsetTops, count: number, px: number): number {
  if (count <= 0) return -1;
  // The last unit whose START is at or before px. A px past the end of the last
  // unit, or before the first (the field clamps its scroll, so both are
  // rounding rather than a place), still answers with the nearest unit — which
  // is what a caller anchoring on it wants.
  let lo = 0;
  let hi = count - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((tops[mid] ?? 0) <= px) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}
