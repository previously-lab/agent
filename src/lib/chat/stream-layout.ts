/**
 * The DOM chat stream's layout model (v0.11 §13/§14.5) — pure, no React.
 *
 * The conversation renders as ONE native scroll container again (the R3F
 * conversation field is retired: R3F renders the closed slices, the live
 * conversation is DOM). The container still mounts only the rows crossing the
 * viewport plus an overscan margin, which takes the same three numbers the
 * camera field kept: a height per row (measured once the row has mounted, an
 * estimate until then), the running offset table derived from those heights,
 * and the visible window read off a scroll position.
 *
 * THE TWO RULES THAT KEEP THE READER'S PLACE are NOT here — they are the
 * component's, because they move a real scroll position — but they exist
 * because of what this table guarantees:
 *
 *   - A prepend only ever renumbers offsets ABOVE the reader. The component
 *     shifts `scrollTop` by the added height (the offset of the old head in
 *     the new table), and the reader's view is pixel-identical.
 *   - A row re-measuring ABOVE the viewport top moves everything below it by
 *     the delta. The component shifts `scrollTop` by that delta; a row
 *     re-measuring INSIDE or below the viewport is allowed to push content,
 *     which is what any reader expects.
 *
 * `overflow-anchor: none` on the scroller makes these the ONLY compensation
 * at work — the browser's own scroll anchoring fighting a hand-rolled one
 * was the old stack's bug, and the field's header documents the measurements.
 */

import type { ChatStreamItem } from "./stream-items";

/**
 * The height assumed for a row that has not mounted yet. Only ever applies
 * to offscreen rows, and it is replaced the moment the row measures — the
 * prepend compensation re-fires on that replacement, so an estimate that is
 * wrong is a temporary scroll-offset error above the reader, never a jump
 * under them.
 */
export function estimateHeightFor(item: ChatStreamItem): number {
  switch (item.kind) {
    case "seam":
      return 64;
    case "resume-banner":
      return 64;
    case "briefing":
      return 560;
    case "history-turn":
      return 140;
    case "live":
      return 220;
  }
}

/**
 * The running offset table: `tops[i]` is the Y of item i's top edge, and
 * `tops[items.length]` is the total height. Monotonic by construction, so a
 * row far below the viewport can never move the ones above it.
 */
export function buildStreamOffsets(
  items: readonly ChatStreamItem[],
  heightOf: (item: ChatStreamItem) => number | undefined,
): number[] {
  const tops: number[] = new Array(items.length + 1);
  let y = 0;
  for (let i = 0; i < items.length; i++) {
    tops[i] = y;
    y += heightOf(items[i]) ?? estimateHeightFor(items[i]);
  }
  tops[items.length] = y;
  return tops;
}

/**
 * The index window to MOUNT: every row whose extent crosses
 * `[scrollTop - overscan, scrollTop + viewportH + overscan]`, as `[start, end)`
 * into the items array. Binary search — the table is monotonic.
 */
export function visibleStreamRange(
  tops: readonly number[],
  itemCount: number,
  scrollTop: number,
  viewportH: number,
  overscan: number,
): { start: number; end: number } {
  if (itemCount === 0) return { start: 0, end: 0 };
  const from = scrollTop - overscan;
  const to = scrollTop + viewportH + overscan;
  // The first row whose BOTTOM is past `from` — i.e. the first row not
  // entirely above the window.
  let start = 0;
  let lo = 0;
  let hi = itemCount - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if ((tops[mid + 1] ?? 0) <= from) lo = mid + 1;
    else {
      start = mid;
      hi = mid - 1;
    }
  }
  // The first row whose TOP is at or past `to` ends the window.
  let end = itemCount;
  lo = start;
  hi = itemCount - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if ((tops[mid] ?? 0) < to) lo = mid + 1;
    else {
      end = mid;
      hi = mid - 1;
    }
  }
  return { start, end };
}

/**
 * The item at the top of the viewport: the last row whose top is at or above
 * `scrollTop`. The travel clock reads its time as the "from" end of a jump.
 */
export function topStreamIndex(
  tops: readonly number[],
  itemCount: number,
  scrollTop: number,
): number {
  let idx = 0;
  // Linear would do; the table is monotonic, so search it.
  let lo = 0;
  let hi = itemCount - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if ((tops[mid] ?? 0) <= scrollTop) {
      idx = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return idx;
}
