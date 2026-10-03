/**
 * Elastic scroll (the card field's settle physics) — the pure math, kept out
 * of the component so it can be unit-tested without a scene.
 *
 * One mechanism, fed by the field's ONE offset table (`layoutFor`):
 *
 * THE RUBBER BAND. A raw wheel/touch delta added past the first or last row
 * would hard-stop at the clamp; instead the overshoot is passed through
 * `rubberOverscroll`, which has slope 1 at the edge and approaches
 * `RUBBER_BAND_PX` asymptotically — the further past the edge the reader
 * pushes, the less each new px buys. The band holds while the input holds and
 * releases when the hand goes quiet: the gesture handlers stamp the rig with
 * a deadline (see `releaseAt` in field-rig.ts), and the frame loop, when the
 * deadline is due, clamps the target back into the range (see
 * `card-field.tsx`) — inside the range that clamp is a no-op, past an end it
 * eases the band home through the existing per-frame ease.
 *
 * THE IDLE SNAP-TO-BOUNDARY IS GONE, on user decision (2026-09-29): the
 * deadline used to ease the target to the nearest row boundary that fits the
 * viewport, and that ratchet felt wrong. Settling now leaves the offset
 * exactly where the reader stopped — the deadline's only job left is the
 * rubber band's release described above.
 */

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
