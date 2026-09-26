/**
 * Elastic snap scrolling (the card field's settle physics) — the pure math,
 * kept out of the component so it can be unit-tested without a scene.
 *
 * Two mechanisms, both fed by the field's ONE offset table (`layoutFor`):
 *
 * 1. THE RUBBER BAND. A raw wheel/touch delta added past the first or last
 *    row would hard-stop at the clamp; instead the overshoot is passed through
 *    `rubberOverscroll`, which has slope 1 at the edge and approaches
 *    `RUBBER_BAND_PX` asymptotically — the further past the edge the reader
 *    pushes, the less each new px buys. The band holds while the input holds;
 *    the snap below is what releases it.
 *
 * 2. THE IDLE SNAP. The gesture handlers stamp the rig with a deadline
 *    `snapAt = now + SNAP_IDLE_MS` on every scroll input; the frame loop, when
 *    the deadline is due, eases the target to `snapBoundaryFor`'s answer. The
 *    rests are the window's head (`min`), every row top that FITS in the
 *    viewport, and the foot (`max`) — the nearest one wins, so a settled
 *    scroll always lands on a boundary, never mid-gap.
 *
 *    THE FIT RULE IS THE CONTRACT WITH THE READER: a row taller than the
 *    viewport must never snap — the reader has to be able to stop inside a
 *    long card and read it. So the nearest boundary is found among ALL row
 *    tops first; if that boundary's own row does not fit, there is NO snap at
 *    all (skipping ahead to a farther fitting boundary would yank the reader
 *    hundreds of px). The head and foot are the range's own rests, not rows:
 *    they always qualify, which is also what makes the rubber band release.
 *
 *    Nothing here invents geometry: a row's extent is `tops[i + 1] - tops[i]`
 *    off the shared table, so the pile rungs (with their backing sheets) and
 *    the conversation rung (with its measured text) snap correctly without a
 *    single hard-coded card height.
 */
import type { OffsetTops } from "./field-offsets";

/** Input quiet time before the snap fires, ms — the hand has stopped. */
export const SNAP_IDLE_MS = 120;

/** The asymptotic ceiling of a held overscroll, px. The band never travels
 *  further than this no matter how far the reader pushes — and at rest it is
 *  the extra slack the frame-loop clamp must allow past the range ends. */
export const RUBBER_BAND_PX = 150;

/** Progressive resistance: slope 1 at the edge (the first px past it moves a
 *  full px), flattening toward `RUBBER_BAND_PX` as the overshoot grows. */
export function rubberOverscroll(overshootPx: number): number {
  const o = Math.max(0, overshootPx);
  if (!Number.isFinite(o)) return RUBBER_BAND_PX;
  return (RUBBER_BAND_PX * o) / (RUBBER_BAND_PX + o);
}

/** Add a scroll delta to an offset, resisting progressively past the range
 *  ends. The result stays within `RUBBER_BAND_PX` of `[min, max]` by
 *  construction, so the frame loop's clamp only needs the same slack. */
export function elasticAdd(
  from: number,
  delta: number,
  min: number,
  max: number,
): number {
  const next = from + delta;
  if (next < min) return min - rubberOverscroll(min - next);
  if (next > max) return max + rubberOverscroll(next - max);
  return next;
}

/** Which way the reader was travelling when the hand went quiet — on an exact
 *  midpoint tie, the snap completes the gesture rather than reversing it. */
export type SnapDir = "past" | "future";

/**
 * The offset the reader should settle at, or `null` to stay exactly where
 * they stopped.
 *
 * `tops` is the field's running offset table (`tops.length === count + 1`);
 * `total` is the column extent; `from` is the offset being snapped (the rig's
 * target — where the reader's input last said to be).
 *
 * The rule, in order:
 *  1. nearest rest wins: `min`, every row top inside `[min, max]`, `max`.
 *  2. if that nearest rest IS a row top whose row does not fit the viewport,
 *     the answer is `null` (requirement: a tall row never bounces the reader).
 *     Note the fit verdict is applied to the WINNER only — the nearest
 *     boundary is picked among ALL row tops first; skipping a near non-fitting
 *     boundary in favour of a farther fitting one would yank the reader.
 *  3. an exact tie goes to the rest in the direction of travel.
 */
export function snapBoundaryFor(
  tops: OffsetTops,
  total: number,
  fieldH: number,
  min: number,
  max: number,
  from: number,
  dir: SnapDir,
): number | null {
  const count = tops.length - 1;
  if (count <= 0 || !(max > min)) return null;

  let best: number | null = null;
  let bestDist = Infinity;
  /** The winning row's fit verdict — meaningless (true) for the head/foot. */
  let bestFits = true;
  const consider = (c: number, fits: boolean) => {
    const d = Math.abs(c - from);
    if (d > bestDist) return;
    // Distinct rests at the same distance: the gesture's direction wins.
    if (d === bestDist && best !== null && c !== best) {
      if (dir === "future" ? c < best : c > best) return;
    }
    best = c;
    bestDist = d;
    // A row top sitting exactly on a rest (unit 0's top on a zero-depth head)
    // carries the verdict that matters — the rest's "always fits" must not
    // launder a too-tall row into a snap.
    bestFits = fits;
  };

  // The head and the foot are the range's own rests, not rows: they always
  // fit. This is also the rubber band's release — an offset held past an end
  // has its nearest rest at that end. Scanned FIRST so a coincident row top
  // can still overwrite the verdict with the row's own.
  consider(min, true);
  consider(max, true);
  for (let i = 0; i < count; i++) {
    const top = tops[i] ?? 0;
    if (top < min || top > max) continue;
    const extent = (tops[i + 1] ?? total) - top;
    consider(top, extent <= fieldH);
  }
  // The nearest boundary closes a row too tall to read in one screen: the
  // reader stays exactly where they stopped, mid-row.
  if (best !== null && !bestFits) return null;
  return best;
}
