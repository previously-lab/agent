/** Fixed print geometry; only the viewing transform responds to the screen. */
export const PAPER_MM = 96 / 25.4;
export const PAPER_WIDTH = 210 * PAPER_MM;
export const PAPER_HEIGHT = 297 * PAPER_MM;
export const PAPER_ZOOM_MAX = 2.4;
const PAPER_ZOOM_STOPS = [0.2, 0.33, 0.5, 0.65, 0.8, 1, 1.15, 1.45, 1.7, 2, PAPER_ZOOM_MAX];

/** Leave space for the stack's paper edges. Chrome is outside this viewport. */
export function fitPaperZoom(width: number, height: number): number {
  if (width <= 0 || height <= 0) return 1;
  return Math.max(0.1, Math.min(1.08, (width - 40) / PAPER_WIDTH, (height - 40) / PAPER_HEIGHT));
}

/** The exact fit is a stop too, so a phone can always return to the whole sheet. */
export function paperZoomStops(fit: number): number[] {
  return [...new Set([...PAPER_ZOOM_STOPS, fit])].sort((a, b) => a - b);
}

export function stepPaperZoom(current: number, direction: 1 | -1, fit: number): number {
  const stops = paperZoomStops(fit);
  return direction > 0
    ? (stops.find((stop) => stop > current + 0.001) ?? stops[stops.length - 1])
    : ([...stops].reverse().find((stop) => stop < current - 0.001) ?? stops[0]);
}

export function paperZoomAtMin(current: number, fit: number): boolean {
  return current <= paperZoomStops(fit)[0] + 0.001;
}

/** A full-page block must be allowed to fragment, including long quotations. */
export function paperPageCount(contentWidth: number, pageWidth: number): number {
  if (!Number.isFinite(contentWidth) || !Number.isFinite(pageWidth) || pageWidth <= 0) return 1;
  // Layout widths are integer-rounded by the DOM; a subpixel tail is not a new page.
  return Math.max(1, Math.round(contentWidth / pageWidth));
}
