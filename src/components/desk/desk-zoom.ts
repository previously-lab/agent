/**
 * The zoom island's pure helpers (v0.28 zoom chrome): the readout's formatting
 * and the range-end predicates behind the `−`/`+` buttons' disabled states.
 *
 * Kept out of desk-field.tsx so the vitest environment can exercise them
 * without mounting the desk (the field module pulls three/drei). The island
 * itself — placement, buttons, the per-frame mirror — lives in desk-field.tsx;
 * this module is only the strings and the clamps' truth.
 *
 * THE DISPLAY STRING is the state unit the field mirrors per frame: two
 * decimals plus the fixed `×` sign (the document's furniture convention — the
 * folio, the shelf line — is fixed-form, so the readout never goes through
 * Intl number formatting). The field compares the STRING, not the float: the
 * camera damps at λ=12, so between gestures the text is stable and a re-render
 * fires only while a zoom is visibly easing.
 */
import { DESK_ZOOM_MAX, DESK_ZOOM_MIN } from "@/lib/timeline3d/desk-camera";

/** The readout's text at a damped zoom — `1.45×`, `1.00×`. */
export function formatDeskZoom(zoom: number): string {
  return `${zoom.toFixed(2)}×`;
}

/** `+` is inert at the top of the range (2×). Target, not the damped value:
 *  a button must reflect where the camera is HEADED, so a press mid-ease
 *  toward 2× is already honestly disabled. Every camera write passes through
 *  `clampZoom`, which lands exactly on the bound, so a small epsilon covers
 *  the float noise without ever lying about the clamp. */
export function deskZoomAtMax(zoomTarget: number): boolean {
  return zoomTarget >= DESK_ZOOM_MAX - 1e-9;
}

/** `−` is inert at the bottom of the range (0.7×) — see deskZoomAtMax. */
export function deskZoomAtMin(zoomTarget: number): boolean {
  return zoomTarget <= DESK_ZOOM_MIN + 1e-9;
}
