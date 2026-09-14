/**
 * Convergence envelope (Rev 13) — pure math for the threadline's
 * "gather at a node" layer: where a new slice/day/week row begins in the
 * card field, the helical strands pinch toward the core with a Gaussian
 * radius envelope, then relax back to full radius. The core axis and the
 * companion line never converge — only the helices do.
 *
 * All functions are pure; the R3F scene calls radiusEnvelopeAt per point
 * per frame and multiplies the strand radius by the result.
 */

export interface ConvergenceOpts {
  /** Pinch depth in (0, 1]: radius at the anchor center is 1 - depth. */
  depth: number;
  /** Gaussian sigma, in the SAME world units as worldY/anchorsWorldY
   *  (the caller scales it from the shared viewport height). */
  sigma: number;
}

/**
 * Multiplicative radius coefficient at `worldY` given a set of anchor
 * world-Y positions (each anchor = one row-start line in the card field).
 * Every anchor contributes `1 - depth * exp(-d² / (2σ²))`; anchors combine
 * by taking the strongest pinch (the minimum), so the result always lies in
 * [1 - depth, 1]. Empty anchors → 1 (no convergence). Degenerate sigma ≤ 0
 * is treated as "no width" — the coefficient is 1 - depth exactly at an
 * anchor and 1 elsewhere.
 */
export function radiusEnvelopeAt(
  worldY: number,
  anchorsWorldY: readonly number[],
  opts: ConvergenceOpts,
): number {
  if (anchorsWorldY.length === 0) return 1;
  const depth = Math.min(1, Math.max(0, opts.depth));
  const sigma = opts.sigma;
  let env = 1;
  for (const a of anchorsWorldY) {
    const d = worldY - a;
    const pinch =
      sigma > 0
        ? depth * Math.exp(-(d * d) / (2 * sigma * sigma))
        : d === 0
          ? depth
          : 0;
    const e = 1 - pinch;
    if (e < env) env = e;
    if (env <= 1 - depth) break; // can't pinch deeper than the strongest
  }
  return env;
}

/**
 * Convert a screen-Y fraction (0 = top of the shared viewport, 1 = bottom)
 * to world units at the camera's z=0 plane, positive-up. The threadline's
 * own canvas may differ in size from the card field; the fractions are
 * relative to the shared viewport height so both sides agree.
 */
export function screenFractionToWorldY(
  fraction: number,
  viewportWorldHeight: number,
): number {
  return (0.5 - fraction) * viewportWorldHeight;
}
