/**
 * The band's line widths, and the one conversion that turns them into
 * something three.js can draw.
 *
 * THE LINES ARE REAL CYLINDERS (`three`'s `CylinderGeometry`, one instance per
 * segment — see `tube-line.tsx`). That matters for one reason beyond looking
 * right: a cylinder is a closed surface with a depth, so two strands crossing
 * each other now occlude instead of piling their ink up. Before, they were
 * screen-space quads, and a crossing was simply twice the ink in the same
 * pixels.
 *
 * WIDTH IS STATED IN CSS PIXELS, and nothing here knows or cares about the
 * display's pixel ratio. 1 CSS px is 1 CSS px on every screen; how many device
 * pixels that lands on is the browser's business, and it is exactly the same
 * number the rest of the product already draws with — every `1px` border in the
 * app is this measurement. Converting it to a world radius is the ONLY thing
 * the geometry cannot do for itself: a cylinder's radius is a world length, and
 * how wide that looks depends on the camera, so it has to be recomputed when
 * the camera moves. That is the whole job of `tubeRadiusWorld`.
 */

/**
 * How many flat facets make up one cylinder's cross-section.
 *
 * Six is what `three`'s `CylinderGeometry` defaults to for a low-poly tube and
 * it is already more than a two-pixel mark can show. It is not a quality knob.
 */
export const RADIAL_SEGMENTS = 6;

/** The strand tubes' diameter, in CSS pixels — a hairline, the same weight the
 *  band's lines have always had. */
export const STRAND_TUBE_DIAMETER_CSS_PX = 1;

/** The core line's, a touch heavier: it is the spine everything on the strip is
 *  read against, and the one line carrying full chroma (`ink.ts`). */
export const CORE_TUBE_DIAMETER_CSS_PX = 1.5;

/** The companion hairline beside the core — deliberately the lightest mark. */
export const COMPANION_TUBE_DIAMETER_CSS_PX = 1;

/**
 * The world radius that draws a cylinder `diameterCssPx` CSS pixels across.
 *
 * The band's camera is perspective and pulls back at the coarse zoom levels, so
 * the conversion has to be made against the height visible at the CURRENT
 * camera distance (`visibleWorldHeight`) rather than a baked one. Done that
 * way, the tube keeps its on-screen thickness at every zoom level instead of
 * visibly thinning out as the reader zooms away from the present — which is the
 * same rule the anchors, the knots and the cable's own radius already follow.
 *
 * Returns 0 for any degenerate input rather than NaN: a zero radius draws
 * nothing, which is the right failure for a decorative mark.
 */
export function tubeRadiusWorld(
  diameterCssPx: number,
  visibleWorldHeight: number,
  cssHeight: number,
): number {
  if (!(diameterCssPx > 0) || !(visibleWorldHeight > 0) || !(cssHeight > 0)) {
    return 0;
  }
  return (diameterCssPx * visibleWorldHeight) / cssHeight / 2;
}
