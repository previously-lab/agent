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
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  return state;
}
