/**
 * The reader's camera (v0.25a §一, v0.27 handoff rule 18) — zoom and pan are
 * the CAMERA's business, never the sheet's. The paper is a fixed 210×297mm
 * object in the world; this module is the pure state machine behind the desk's
 * gestures: a target/current zoom pair clamped to 0.7×–2× and damped toward
 * the target (the repo's `MathUtils.damp` idiom, λ=12), `+`/`−` stepping, `0`
 * resetting to the whole page, and a pan offset with clamped bounds so the
 * sheet can never be dragged out of the viewport.
 *
 * THE DEFAULT IS B = 1.45× (the owner's 2026-10-12 ruling, lab recipe 12):
 * this is a document reader — reading is the primary act, so it opens
 * readable. A = the whole page (1.0×) is what `0` returns to.
 *
 * WHAT ZOOM MEANS GEOMETRICALLY. The shared camera (`camera.ts`) derives its
 * distance from the viewport height so 1 world unit = 1 CSS px at the focal
 * plane; the reader's camera sits at `camZFor(viewH) / zoom`, so a sheet
 * `sheetH` world units tall renders `sheetH · zoom` px on screen and the
 * visible window at the focal plane is `viewH / zoom` world units. Pan is a
 * parallel camera shift in world units, exactly like the card field's band
 * bias — the camera moves to (x, y) and looks at (x, y, 0).
 *
 * PURE, ON PURPOSE. No three, no React, no DOM — the vitest environment
 * renders no components. The damping formula mirrors THREE.MathUtils.damp
 * exactly (`lerp(x, y, 1 − e^(−λ·dt))`) so the wiring can advance the state
 * per frame without importing three into the model.
 */

export const DESK_ZOOM_MIN = 0.7;
export const DESK_ZOOM_MAX = 2;
/** The opening state (candidate B): taller than the viewport, read by
 *  panning, legible without a first zoom-in. */
export const DESK_ZOOM_DEFAULT = 1.45;
/** The reset state (candidate A): the whole page fits the viewport. */
export const DESK_ZOOM_RESET = 1;
/** The `+`/`−` step (lab recipe 12's). */
export const DESK_ZOOM_STEP = 0.15;

/** The damping constant — the desk's existing idiom (the give-way pan
 *  settles inside the pane's own 300 ms beat at λ=12). */
export const DESK_CAMERA_DAMP_LAMBDA = 12;

export interface DeskCameraState {
  /** The damped value the camera is rendered at this frame. */
  zoom: number;
  /** Where the damping is headed — every gesture writes ONLY the targets. */
  zoomTarget: number;
  /** The camera's parallel shift off the sheet's centre, world units —
   *  ADDED to the give-way pan by the wiring. */
  pan: { x: number; y: number };
  panTarget: { x: number; y: number };
}

/** The opening state: candidate B, centred on the sheet. */
export function createDeskCamera(): DeskCameraState {
  return {
    zoom: DESK_ZOOM_DEFAULT,
    zoomTarget: DESK_ZOOM_DEFAULT,
    pan: { x: 0, y: 0 },
    panTarget: { x: 0, y: 0 },
  };
}

export function clampZoom(zoom: number): number {
  return Math.min(DESK_ZOOM_MAX, Math.max(DESK_ZOOM_MIN, zoom));
}

/** A `+`/`−` keypress: one fixed step from the TARGET (repeated presses
 *  during a damp still accumulate), clamped at both ends of the range. */
export function stepZoom(
  state: DeskCameraState,
  dir: 1 | -1,
): DeskCameraState {
  return { ...state, zoomTarget: clampZoom(state.zoomTarget + dir * DESK_ZOOM_STEP) };
}

/** A pinch / ctrl-wheel tick: multiplicative, so trackpad pinches (small,
 *  frequent deltas) and mouse ctrl-notches (±100) both feel right. */
export function zoomBy(
  state: DeskCameraState,
  factor: number,
): DeskCameraState {
  return { ...state, zoomTarget: clampZoom(state.zoomTarget * factor) };
}

/** `0` — back to the whole page, centred. */
export function resetDeskCamera(state: DeskCameraState): DeskCameraState {
  return {
    ...state,
    zoomTarget: DESK_ZOOM_RESET,
    panTarget: { x: 0, y: 0 },
  };
}

/** How far the view's centre may move off the sheet's centre, world units,
 *  at a given zoom. The sheet must always COVER the viewport: when the
 *  zoomed sheet is larger than the visible window the centre may roam the
 *  excess half-extent; when it is smaller (zoomed out) the sheet stays
 *  centred and the bound is 0. */
export function panBoundsFor(
  sheetW: number,
  sheetH: number,
  viewW: number,
  viewH: number,
  zoom: number,
): { x: number; y: number } {
  return {
    x: Math.max(0, (sheetW - viewW / zoom) / 2),
    y: Math.max(0, (sheetH - viewH / zoom) / 2),
  };
}

/** Clamps a view centre (give-way pan + user pan, in world units) into the
 *  bounds — the sheet can never be dragged out of the viewport. */
export function clampViewCentre(
  centre: { x: number; y: number },
  bounds: { x: number; y: number },
): { x: number; y: number } {
  return {
    x: Math.min(bounds.x, Math.max(-bounds.x, centre.x)),
    y: Math.min(bounds.y, Math.max(-bounds.y, centre.y)),
  };
}

/** A drag, in screen px: grab-the-paper feel. Dragging right moves the
 *  paper right, which is the view centre moving LEFT (the camera looks at
 *  what it sits over); screen y is down, world y is up. The px delta is
 *  worth fewer world units the closer the camera sits, so it divides by
 *  the zoom — the sheet tracks the pointer at every distance. The wiring
 *  re-clamps the centre every frame, so this writes the raw target. */
export function dragPanBy(
  state: DeskCameraState,
  dxPx: number,
  dyPx: number,
): DeskCameraState {
  const z = state.zoomTarget;
  return {
    ...state,
    panTarget: {
      x: state.panTarget.x - dxPx / z,
      y: state.panTarget.y + dyPx / z,
    },
  };
}

/** One frame of damping toward the targets — `MathUtils.damp` with the
 *  desk's λ and its snap-epsilons (0.5 world units of pan, a thousandth of
 *  a zoom step), so a settled camera stops drifting instead of creeping.
 *  `dt` is seconds, already clamped by the caller; `snap` is the reduced-
 *  motion path (no motion, the target IS the value). */
export function advanceDeskCamera(
  state: DeskCameraState,
  dt: number,
  snap = false,
): DeskCameraState {
  const damp = (current: number, target: number): number =>
    current + (target - current) * (1 - Math.exp(-DESK_CAMERA_DAMP_LAMBDA * dt));
  let { zoom, pan } = state;
  const { zoomTarget, panTarget } = state;
  if (snap) {
    zoom = zoomTarget;
    pan = { ...panTarget };
  } else {
    zoom = damp(zoom, zoomTarget);
    if (Math.abs(zoom - zoomTarget) < 0.001) zoom = zoomTarget;
    pan = {
      x: damp(pan.x, panTarget.x),
      y: damp(pan.y, panTarget.y),
    };
    if (Math.abs(pan.x - panTarget.x) < 0.5) pan.x = panTarget.x;
    if (Math.abs(pan.y - panTarget.y) < 0.5) pan.y = panTarget.y;
  }
  return { zoom, zoomTarget, pan, panTarget };
}
