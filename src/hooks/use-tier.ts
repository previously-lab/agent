"use client";

import { useLayoutEffect, useState } from "react";
import {
  columnFor,
  DEFAULT_TIER,
  paneWidthFor,
  specFor,
  tierFor,
  type LayoutTier,
  type TierSpec,
} from "@/lib/layout/tiers";

export interface TierState {
  tier: LayoutTier;
  /** The resolved reading column, px — feed this to the field, not the tier. */
  column: number;
  /** The right pane's width, px. */
  paneW: number;
  spec: TierSpec;
}

function read(): TierState {
  const windowW = window.innerWidth;
  const tier = tierFor(windowW);
  return {
    tier,
    column: columnFor(windowW),
    paneW: paneWidthFor(windowW),
    spec: specFor(tier),
  };
}

/** Only the fields that actually change are carried, so React can bail out. */
function same(a: TierState, b: TierState): boolean {
  return (
    a.tier === b.tier && a.column === b.column && a.paneW === b.paneW
  );
}

/**
 * How often a resize may recompute the tier, in ms.
 *
 * A DRAG USED TO RECOMPUTE ON EVERY EVENT. `resize` fires once per frame while
 * a window edge is being dragged, and every one of those ran `columnFor` and
 * re-rendered the whole field — up to three R3F canvases — for a number that
 * only changes meaningfully a handful of times across the entire range. The
 * `same()` guard does not help: below the column's cap the column genuinely
 * tracks the pane, so `column` differs on essentially every event.
 *
 * SO THE LAYOUT IS ALLOWED TO LAG. Nobody can read while they are dragging a
 * window edge, and settling a frame or two late is invisible; sixty
 * re-renders a second is not. This is a TRAILING throttle rather than a plain
 * debounce: a long drag still updates about six times a second instead of
 * freezing until the mouse is released, and because every event with no update
 * already pending schedules one, the LAST event always lands.
 */
const RESIZE_THROTTLE_MS = 150;

/**
 * The current layout tier, live.
 *
 * Consulted in a layout effect so a phone renders its tier BEFORE the first
 * paint, while the SSR first render stays on `DEFAULT_TIER` so hydration
 * matches — the same gear decision as `use-is-mobile.ts`, for the same reason.
 *
 * IT DOES NOT RE-RENDER ON EVERY RESIZE PIXEL, and that is the point of the
 * `same()` guard. Above the column's cap a resize changes nothing the field
 * draws, and re-rendering three R3F canvases to draw the identical frame is
 * pure waste; below the cap the column genuinely moves, so the re-render is
 * real work rather than noise. Either way the tier table stays the only place
 * the numbers come from.
 */
export function useTier(): TierState {
  const [state, setState] = useState<TierState>(() => ({
    tier: DEFAULT_TIER,
    column: columnFor(1440),
    paneW: paneWidthFor(1440),
    spec: specFor(DEFAULT_TIER),
  }));

  useLayoutEffect(() => {
    const update = () => {
      const next = read();
      setState((prev) => (same(prev, next) ? prev : next));
    };
    update();

    // See RESIZE_THROTTLE_MS. One timer, so an event arriving while an update
    // is already scheduled is dropped rather than queued — a burst of sixty
    // collapses to one, which is the whole point.
    let pending: ReturnType<typeof setTimeout> | null = null;
    let lastAt = 0;
    const onResize = () => {
      if (pending) return;
      pending = setTimeout(
        () => {
          pending = null;
          lastAt = performance.now();
          update();
        },
        Math.max(0, RESIZE_THROTTLE_MS - (performance.now() - lastAt)),
      );
    };

    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      if (pending) clearTimeout(pending);
    };
  }, []);

  return state;
}
