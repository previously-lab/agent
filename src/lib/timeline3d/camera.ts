/**
 * The card field's camera — the one place its projection is defined.
 *
 * ONE WORLD UNIT IS ONE CSS PIXEL, and that is a DERIVATION, not a convention.
 * The camera distance comes from the viewport height:
 *
 *     camZ(H) = H / (2·tan(fov/2))
 *
 * The height the camera sees at z=0 is `2·camZ·tan(fov/2)` world units, so
 * feeding it `camZ(H)` makes that height exactly `H`: the field's px literals
 * (card geometry, row pitch, cascade offsets) ARE world coordinates, and
 * `worldPerPxFor` — the factor the call sites used to thread around as `wpp` —
 * is 1 at every viewport. That is what lets the card field and the conversation
 * field (orthographic, `zoom: 1`) share one coordinate system: a screen-y px is
 * a world-y unit on both sides, so `(viewH/2 - centerPy)·wpp` and
 * `viewH/2 + offset` are the same equation.
 *
 * The FOV stays FIXED and the distance moves instead, which is what keeps the
 * depth cue viewport-independent: a sheet `d` behind the face renders
 * `camZ/(camZ + d)` times its size, and with camZ proportional to H that ratio
 * depends only on `d/camZ`.
 *
 * `camZFor(H)` is also, identically, three's focal length in px
 * (`projectionMatrix.elements[5] · H/2`) — the number drei's `<Html transform>`
 * writes into CSS `perspective` — which is why `distanceFactor={400}` is
 * exactly 1:1 on the three `<Html>` layers (see `worldScaleFor` for the other
 * half of that).
 */

/** Vertical field of view, degrees — fixed at every viewport height. The camera
 *  moves instead (`camZFor`), so the perspective is the same everywhere and
 *  only the distance changes. */
export const FIELD_FOV = 30;

const FOV_HALF_TAN = Math.tan((FIELD_FOV * Math.PI) / 360);

/** Camera distance for a field `viewH` px tall — the distance at which the z=0
 *  plane is 1 world unit per CSS px. */
export function camZFor(viewH: number): number {
  return viewH / (2 * FOV_HALF_TAN);
}

/** World units per CSS px at the focal plane. 1 by construction — `camZFor`
 *  exists to make it so — kept as a function so every call site states the
 *  contract instead of assuming it. */
export function worldPerPxFor(viewH: number): number {
  return (2 * camZFor(viewH) * FOV_HALF_TAN) / viewH;
}

/** The fixed camera distance the field's authored world literals were written
 *  against: the pre-unification `CAM_Z = 9`, same fov. */
export const LEGACY_CAM_Z = 9;

/**
 * Converts a world value AUTHORED against the old fixed camera — the scroll
 * drift, the deal's z arc, `SHEET_GAP_WORLD`, the hover lift — into the derived
 * camera, preserving its on-screen size at every viewport height.
 *
 * WHY A RATIO AND NOT A PX CONSTANT. The drift is a fixed YAW ANGLE:
 * `atan(0.42/9)` = 2.67°, unchanged because the lateral offset and the camera
 * distance scale together. What an angle is worth on screen is proportional to
 * the viewport, though — that 2.67° sweeps ≈0.001·viewH px of parallax across
 * the first backing sheet (0.1 old-units deep), so ~0.8 px at 800 tall and
 * ~1.6 px at 1600. Baking in the px that happen to fall out at one viewport
 * would flatten the drift and the pile on small screens and over-swing them on
 * large ones. The depth literals follow the same rule for the same reason:
 * `SHEET_GAP_WORLD = 0.1` costs a sheet a fixed `0.1/9` of its size, and only a
 * depth that scales with camZ keeps that fraction constant.
 *
 * Values already EXPRESSED in px (`SHEET_GAP_PX`, `sheetPose` offsets, row
 * pitch, card geometry) need no conversion at all — they were multiplied by
 * `wpp` before and are simply world units now.
 */
export function worldScaleFor(viewH: number): number {
  return camZFor(viewH) / LEGACY_CAM_Z;
}

/**
 * Clip planes for the derived camera. BOTH scale with the viewport because the
 * distance does: R3F's default `far = 1000` sits in FRONT of a camera whose
 * distance is `1.87·viewH`, so any field taller than ~536 px has its whole
 * field outside the frustum. Bracketing the distance this way also holds at
 * every size, because the deepest thing the field draws (the deal's z arc, the
 * leaving-card stack) is a fraction of camZ rather than a constant.
 */
export function clipPlanesFor(viewH: number): { near: number; far: number } {
  const camZ = camZFor(viewH);
  return { near: camZ / 2, far: camZ * 2 };
}
