/**
 * Ruler math — the pure strip math behind the axis band's year ruler, shared
 * by two renderers:
 * - `ambient-scene.tsx` draws the tick marks + NOW dot on a 2D canvas;
 * - `axis-band.tsx` positions the year labels as a DOM overlay rendered with
 *   the shared RollingField rolling-digits component.
 *
 * Extracted from ambient-scene.tsx (Rev 14 → 15: the engraved month/day
 * ladder is gone; only year-boundary ticks + labels and the NOW dot remain)
 * so the scroll-linked marker positions are unit-testable without a canvas.
 *
 * Strip model: markers are spaced a fixed `TARGET_YEAR_PX` apart on a virtual
 * strip that is taller than the viewport (so scrolling always has room to
 * move) and extends past the data window when the range is short. `progress`
 * (0 = oldest/top, 1 = now/bottom) shifts the strip upward under the
 * viewport, exactly like the card field it mirrors.
 */

/** Visible date range: `oldest` is the earliest loaded slice's date,
 *  `now` is the current calendar date. Both "YYYY-MM-DD". */
export interface RulerRange {
  oldest: string;
  now: string;
}

/** One year-boundary marker in canvas/viewport coordinates (px, y=0 top). */
export interface YearMarker {
  year: number;
  y: number;
}

/** Vertical pitch between consecutive year markers on the strip. */
export const TARGET_YEAR_PX = 100;
/** Minimum vertical distance between two labelled markers; closer labels
 *  collide, in which case the OLDER (higher) one is hidden. */
export const MIN_LABEL_GAP_PX = 40;
/** Length of a year tick, drawn leftward from the right-edge axis. */
export const YEAR_TICK_WIDTH = 24;
/** Clearance between the axis and the band's right edge. */
export const RULER_AXIS_MARGIN_PX = 10;
/** Horizontal gap between the tick's end and the year label. */
export const RULER_LABEL_GAP_PX = 5;
/** Right offset at which the DOM label overlay right-aligns its labels —
 *  mirrors axis margin + tick width + label gap. */
export const RULER_LABEL_RIGHT_PX =
  RULER_AXIS_MARGIN_PX + YEAR_TICK_WIDTH + RULER_LABEL_GAP_PX;
/** Band narrower than this shows ticks only, no labels (matches the
 *  collapsed `w-14` chat width). */
export const RULER_LABEL_MIN_WIDTH_PX = 140;

/** Viewport padding: markers this far outside the viewport are culled so
 *  ticks slide in smoothly instead of popping. */
export const RULER_VIEWPORT_PAD_PX = 18;

/** Parse a "YYYY-MM-DD" date into a local midnight Date (null if invalid). */
export function parseRulerDate(date: string): Date | null {
  const m = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  const d = Number(m[3]);
  const out = new Date(y, mo, d);
  if (
    Number.isNaN(out.getTime()) ||
    out.getFullYear() !== y ||
    out.getMonth() !== mo ||
    out.getDate() !== d
  ) {
    return null;
  }
  return out;
}

/**
 * All year-boundary markers whose ticks intersect the viewport for the given
 * range, viewport height, and scroll progress. Returns null when the range
 * is invalid (callers then draw only the NOW dot). The strip may extend past
 * the data window so short ranges still read as a ruler.
 */
export function computeYearMarkers(
  range: RulerRange,
  height: number,
  progress: number,
): YearMarker[] | null {
  const oldest = parseRulerDate(range.oldest);
  const now = parseRulerDate(range.now);
  if (!oldest || !now || now.getTime() <= oldest.getTime()) return null;
  if (height <= 0) return [];

  const endYear = now.getFullYear();
  const dataYears = Math.max(1, endYear - oldest.getFullYear() + 1);
  // Extend past the data window when it is short so the strip always covers
  // the viewport with headroom (2× height, as in the Rev 14 ruler).
  const requiredYears = Math.ceil((height * 2) / TARGET_YEAR_PX);
  const unitCount = Math.max(dataYears - 1, requiredYears);
  const stripHeight = unitCount * TARGET_YEAR_PX;
  const offsetY = progress * Math.max(0, stripHeight - height);

  const markers: YearMarker[] = [];
  for (let i = 0; i <= unitCount; i++) {
    const y = stripHeight - i * TARGET_YEAR_PX - offsetY;
    if (y < -RULER_VIEWPORT_PAD_PX || y > height + RULER_VIEWPORT_PAD_PX) {
      continue;
    }
    markers.push({ year: endYear - i, y });
  }
  return markers;
}

/**
 * The markers that get a label, oldest-on-top. Only viewport-intersecting
 * markers are considered; walking from the newest (bottom) marker upward, a
 * marker keeps its label only if it sits at least `minGap` px above the last
 * kept one — otherwise the older of the colliding pair is hidden.
 */
export function resolveLabelledMarkers(
  markers: YearMarker[],
  height: number,
  minGap: number = MIN_LABEL_GAP_PX,
): YearMarker[] {
  const visible = markers.filter((m) => m.y >= 0 && m.y <= height);
  // Newest = largest y; process from the bottom up so the newer label wins.
  const byYDesc = [...visible].sort((a, b) => b.y - a.y);
  const kept: YearMarker[] = [];
  for (const m of byYDesc) {
    const last = kept[kept.length - 1];
    if (last && last.y - m.y < minGap) continue; // older collider hides
    kept.push(m);
  }
  return kept.sort((a, b) => a.y - b.y);
}
