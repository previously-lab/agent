/**
 * The layout tiers — the ONE place a viewport-dependent number is decided.
 *
 * WHY THIS EXISTS. The field had no responsive concept at all. The reading
 * column was a hard `680` (`CONVERSATION_COLUMN_PX`) and the camera is derived
 * from viewport HEIGHT (`camera.ts:camZFor`), so one world unit is one CSS pixel
 * in both axes and the column was 680px wide on a 390px phone. The field wrapper
 * is `overflow-hidden` and owns its own virtual scroll, so the overflow was not
 * scrollable — it was silently CROPPED. Measured before this module existed:
 * 14 of 16 text nodes clipped at 390×844, 14 of 15 at 320×568, none at 768.
 *
 * THE RULE. The world does NOT scale. One world unit stays one CSS pixel, and
 * the things authored in pixels get a value from the tier instead. Scaling the
 * world is the tempting fix and the wrong one: it shrinks the card's `em` with
 * it (see `frame-card.tsx`), and 12px of card type is already marginal — a
 * uniform 0.46× on a phone puts body text at 4px.
 *
 * TIERS, NOT A FORMULA. Four presets, each stating a complete set of numbers,
 * because a preset is something a designer can look at and argue with, and a
 * continuous formula is not. The column still CLAMPS rather than switching, so
 * crossing a boundary does not jump the reading measure — see `columnFor`.
 *
 * WHEN A TIER MAY GROW ITS CHROME. The rail and the inset may only get bigger
 * at a boundary where the column has ALREADY reached its cap — the laptop and
 * wide tiers, where the column is pinned at 680 and the extra chrome is taken
 * out of slack nobody was reading. Growing either one earlier narrows the
 * reading column as the window WIDENS, which is a column that moves backwards
 * under a reader who is resizing: measured, a 10px tablet inset cost the
 * 640px boundary 3px of column. So `phone` and `tablet` share a rail and an
 * inset, and differ in type scale instead. `tiers.test.ts` asserts the
 * monotonicity this rule buys.
 *
 * Pure module: no React, no DOM. The client hook is `@/hooks/use-tier`, so this
 * table stays plain data and unit-testable.
 */

/** The four presets, finest viewport first. */
export type LayoutTier = "phone" | "tablet" | "laptop" | "wide";

export interface TierSpec {
  id: LayoutTier;
  /** Inclusive lower bound of the tier, in CSS px of WINDOW width. */
  minWidth: number;
  /** Left margin of the time rail, px. */
  railMargin: number;
  /** Width of the time rail, px. */
  railW: number;
  /** Padding between the pane's edge and the reading column, px. */
  inset: number;
  /** The column's cap, px — the measure a slice's turns are read at. */
  columnMax: number;
  /** Multiplier for the field's fixed type (the gate and the window head). */
  typeScale: number;
}

/**
 * The tiers. Rail and inset shrink on the small end (the rail is 7.5% of a
 * 320px screen at 24px and 10% at 32px), and the column cap grows once, at the
 * wide tier, where there is room to spend.
 */
export const TIERS = [
  {
    id: "phone",
    minWidth: 0,
    railMargin: 8,
    railW: 24,
    inset: 8,
    columnMax: 680,
    typeScale: 0.875,
  },
  {
    id: "tablet",
    minWidth: 640,
    // SAME RAIL AND INSET AS THE PHONE, deliberately — see "when a tier may
    // grow its chrome" in the header. A tablet differs from a phone in its TYPE
    // SCALE, which is a real and visible difference (the gate and the window
    // head), not in its margins.
    railMargin: 8,
    railW: 24,
    inset: 8,
    columnMax: 680,
    typeScale: 1,
  },
  {
    id: "laptop",
    minWidth: 1024,
    railMargin: 16,
    railW: 32,
    inset: 16,
    columnMax: 680,
    typeScale: 1,
  },
  {
    id: "wide",
    minWidth: 1600,
    railMargin: 24,
    railW: 32,
    inset: 24,
    columnMax: 760,
    typeScale: 1.125,
  },
] as const satisfies readonly TierSpec[];

/** The tier a desktop viewport gets — also the SSR default, so a server render
 *  and the first client paint agree (mirrors `hooks/use-is-mobile.ts`). */
export const DEFAULT_TIER: LayoutTier = "laptop";

/** Below this a reading column stops being a measure and becomes a column of
 *  single words. Only reachable on a viewport narrower than anything the tiers
 *  describe, and a floor is cheaper than trusting that. */
export const MIN_COLUMN_PX = 240;

/** The spec for a tier id. */
export function specFor(id: LayoutTier): TierSpec {
  const spec = TIERS.find((t) => t.id === id);
  // Total over the union — unreachable, and cheaper than a non-null assertion.
  return spec ?? TIERS[TIERS.length - 1];
}

/** The tier a window width falls in. Descending scan: the LAST tier whose
 *  `minWidth` the window meets is the one it belongs to. */
export function tierFor(windowW: number): LayoutTier {
  let id: LayoutTier = TIERS[0].id;
  for (const tier of TIERS) {
    if (windowW >= tier.minWidth) id = tier.id;
  }
  return id;
}

/** How much horizontal room the rail takes off the window, margin included. */
export function railFootprintFor(windowW: number): number {
  const spec = specFor(tierFor(windowW));
  return spec.railMargin + spec.railW;
}

/** The right pane's width — what the field actually draws in. */
export function paneWidthFor(windowW: number): number {
  return Math.max(0, windowW - railFootprintFor(windowW));
}

/**
 * The reading column, in px — THE number a slice's turns are laid out at, at
 * every rung that draws them.
 *
 * It CLAMPS instead of switching, which is the whole reason the column is a
 * function and not a field on `TierSpec`. A hard per-tier width steps the
 * moment the window crosses a boundary — and at the laptop boundary it would
 * step 680 → 680 with hundreds of pixels of slack between them, which is a
 * reflow the reader would watch happen for no reason. Clamping reaches the cap
 * inside each tier, so the boundaries that matter (tablet → laptop, → wide)
 * change the column by nothing at all. The only steps left are the few px the
 * inset itself moves by, and `TIERS` keeps those small on purpose: the rail
 * and the inset grow at the LAPTOP boundary, where both tiers are pinned to
 * the cap, and never at a boundary where the column is still filling the pane.
 *
 * Both consumers (`conversation-field.tsx` and `conversation-unit.tsx`) must
 * call THIS, with the window width — never derive it themselves. `field-blocks`
 * states the invariant: if the two disagree, the same slice reflows when the
 * reader changes rung.
 */
export function columnFor(windowW: number): number {
  const spec = specFor(tierFor(windowW));
  const room = paneWidthFor(windowW) - 2 * spec.inset;
  return Math.max(MIN_COLUMN_PX, Math.min(room, spec.columnMax));
}


/** Type multiplier for the field's fixed-size type, by window width. */
export function typeScaleFor(windowW: number): number {
  return specFor(tierFor(windowW)).typeScale;
}
