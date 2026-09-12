/**
 * Strand-band presentation math (v0.11, doc/design/v0.11-strand-field.md
 * §2.3/§2.4) — the two responsive quantities the left band must not hard-code.
 *
 * Kept out of `winding.ts` (the geometry contract) and `convergence.ts` (the
 * envelope contract) so those tested modules stay untouched: this is the
 * binding between "what the right pane is showing" and "what the band draws".
 *
 *  - HOW MANY strands are drawn (§2.4): N is a responsive quantity, not a
 *    constant. Every lane needs a distinguishable seat around the core, and a
 *    strip can only resolve so many before the bundle smears into one line.
 *  - HOW LONG one knot is (§2.3): `lambda` is the world length of a single
 *    turn, and it must equal the on-screen height of the content that turn
 *    belongs to. That is what registers the band to the right pane: the knot
 *    is exactly as tall as the row it marks, so the two sides stay in step
 *    when the viewport resizes instead of drifting apart.
 */
import type { FieldAnchor } from "./winding";
import { screenFractionToWorldY } from "./convergence";

/** Strands drawn on the widest band. */
export const WIDE_STRAND_LIMIT = 20;
/** Strands drawn on a band too narrow to seat the full set. The band is a
 *  32 px strip (see `AxisBand`), so this is the tier that is actually live in
 *  both views — it is the one number to turn.
 *
 *  IT IS A MOIRÉ DIAL, not just a density dial. A strand's on-screen x is
 *  `R·cos(seat + spin)` and every strand shares one `spin`, so the lines cross
 *  at REGULAR intervals, and 1 px lines crossing regularly is a diffraction
 *  grating: past a handful of strands the eye stops seeing individual threads
 *  and starts seeing the beat pattern between them. The crossing period grows
 *  with the angular gap between seats, so FEWER strands means a coarser, calmer
 *  pattern as well as less clutter.
 *
 *  Seven, not ten. `cos` is even, so seats pair up — strand i and strand N−i
 *  share an x at every height and are separated only by depth and shading.
 *  Ten seats therefore collapse to six x-traces, but seven collapse to four,
 *  i.e. a 33 % drop in the number of things actually crossing, for a 30 %
 *  drop in line count. The user's read — "cut two or three" — lands on the
 *  knee of that curve. (Five was the previous value; it reads as too sparse
 *  once the strands are this quiet.) */
export const NARROW_STRAND_LIMIT = 7;
/** Strands drawn while the band is between the two widths (the 500 ms width
 *  transition, and mid-size tablet bands). */
export const MID_STRAND_LIMIT = 14;

/** Band width (CSS px) at or below which the narrow set is drawn. */
export const NARROW_BAND_PX = 64;
/** Band width (CSS px) at which the full desktop set is drawn. */
export const WIDE_BAND_PX = 128;

/**
 * Fallback knot length as a fraction of the viewport world height, used when
 * fewer than two anchors are in view — with no row pitch to measure, "one
 * knot is about a sixth of the screen" is the honest stand-in.
 */
export const KNOT_LAMBDA_VIEWPORT_FRACTION = 0.18;
/** Floor for lambda, as a fraction of the viewport world height. A knot can
 *  never collapse to zero length (that would be a step, not a turn). */
export const KNOT_LAMBDA_MIN_FRACTION = 0.02;

/**
 * How many strands the band draws at a given width. Monotone non-decreasing
 * in width, and it never exceeds `WIDE_STRAND_LIMIT`.
 */
export function strandLimitForBandWidth(bandWidthPx: number): number {
  if (!Number.isFinite(bandWidthPx) || bandWidthPx < NARROW_BAND_PX) {
    return NARROW_STRAND_LIMIT;
  }
  if (bandWidthPx < WIDE_BAND_PX) return MID_STRAND_LIMIT;
  return WIDE_STRAND_LIMIT;
}

/**
 * Anchor screen-Y fractions (0 = top of the shared viewport) → world Y at the
 * camera's z=0 plane, in the order given. The band never re-derives where
 * things are; it only converts the heights the right pane published.
 */
export function anchorWorldYs(
  anchors: readonly FieldAnchor[],
  viewportWorldHeight: number,
): number[] {
  return anchors.map((a) => screenFractionToWorldY(a.y, viewportWorldHeight));
}

/**
 * The on-screen row pitch, in world units: the median gap between consecutive
 * anchor heights. The median (not the mean) so a single missing row — a jump
 * in the catalog, a filtered-out slice — cannot stretch the knot length for
 * every strand on screen. Returns null when fewer than two distinct heights
 * are in view (nothing to measure).
 */
export function anchorSpacingWorld(
  worldYs: readonly number[],
): number | null {
  const gaps: number[] = [];
  const sorted = [...worldYs].sort((a, b) => a - b);
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i] - sorted[i - 1];
    if (gap > 0 && Number.isFinite(gap)) gaps.push(gap);
  }
  if (gaps.length === 0) return null;
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)];
}

/**
 * The world length of one knot: half the row pitch, so a turn spans exactly
 * the content row it marks (the winding window is ±lambda). Falls back to a
 * fixed fraction of the viewport when there is no pitch to measure, and never
 * returns a non-positive length.
 */
export function knotLambda(
  worldYs: readonly number[],
  viewportWorldHeight: number,
): number {
  const minLambda = viewportWorldHeight * KNOT_LAMBDA_MIN_FRACTION;
  const spacing = anchorSpacingWorld(worldYs);
  const raw =
    spacing != null
      ? spacing / 2
      : viewportWorldHeight * KNOT_LAMBDA_VIEWPORT_FRACTION;
  if (!Number.isFinite(raw) || raw < minLambda) return minLambda;
  return raw;
}

/**
 * The world length of ONE anchor's knot — half the anchor's OWN `span` when it
 * has one, so the twist is exactly as tall as the slice it belongs to and
 * returns to 0 at that slice's boundaries.
 *
 * THAT IS WHAT MAKES THE SEAM STRAIGHT. Two slices back to back, each winding
 * across its own extent, means the spin leaves the first slice at a whole
 * number of turns and enters the second from 0 — so the region between them,
 * the seam, is the one place the bundle is reliably unwound. Sizing the knot
 * from the median pitch instead (the `knotLambda` fallback) overshoots by the
 * gap after the slice and drags the release past the seam.
 *
 * Falls back to `knotLambda` for an anchor with no span: the timeline's rows
 * have a uniform pitch, so the median IS the right answer there.
 */
export function knotLambdaForAnchor(
  span: number | undefined,
  worldYs: readonly number[],
  viewportWorldHeight: number,
): number {
  const minLambda = viewportWorldHeight * KNOT_LAMBDA_MIN_FRACTION;
  if (span != null && Number.isFinite(span) && span > 0) {
    const half = (span * viewportWorldHeight) / 2;
    return Math.max(minLambda, half);
  }
  return knotLambda(worldYs, viewportWorldHeight);
}
