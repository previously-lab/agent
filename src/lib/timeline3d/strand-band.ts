/**
 * Strand-band presentation math (v0.11, doc/design/v0.11-strand-field.md
 * §2.3/§2.4) — the two responsive quantities the left band must not hard-code.
 *
 * Kept out of `winding.ts` (the geometry contract) and `convergence.ts` (the
 * envelope contract) so those tested modules stay untouched: this is the
 * binding between "what the right pane is showing" and "what the band draws".
 *
 *  - HOW MANY strands are drawn (§2.4): N is a responsive quantity, not a
 *    constant. Ten lanes need ten distinguishable seats around the core; a
 *    phone-width strip can only resolve a handful before the bundle smears
 *    into one line.
 *  - HOW LONG one knot is (§2.3): `lambda` is the world length of a single
 *    turn, and it must equal the on-screen height of the content that turn
 *    belongs to. That is what registers the band to the right pane: the knot
 *    is exactly as tall as the row it marks, so the two sides stay in step
 *    when the viewport resizes instead of drifting apart.
 */
import type { FieldAnchor } from "./winding";
import { screenFractionToWorldY } from "./convergence";

/** Strands drawn on the wide desktop band (md:w-44 ≈ 176 px). */
export const WIDE_STRAND_LIMIT = 10;
/** Strands drawn on a band too narrow to seat ten lanes (chat / phone). */
export const NARROW_STRAND_LIMIT = 5;
/** Strands drawn while the band is between the two widths (the 500 ms width
 *  transition, and mid-size tablet bands). */
export const MID_STRAND_LIMIT = 8;

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
