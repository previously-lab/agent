"use client";

/**
 * The card field's paper board (v0.13 paper pass) — the old atmosphere is
 * deleted. What used to live here (three drifting aurora glows, a 72px grid,
 * an edge vignette) is replaced by ONE sheet of paper filling the pane behind
 * the transparent canvas: the sheet element's own `.paper-stock` background,
 * no overlay divs (the grain is blended into the stock, per the paper
 * contract in globals.css).
 *
 * THE SHEET IS ONE COLOUR, ALWAYS. Board and card are the same stock; the
 * layer language between them is the card's shadow, not a colour step. There
 * is deliberately no channel from the field to this element — an earlier pass
 * tinted the board with the landed card's strand colour, and the colour
 * machinery (seed write, registered-property transition) is deleted with the
 * rework, not left dormant.
 *
 * `AtmosphereBackdrop` renders in the SHELL's pane slot, inset past the band,
 * UNDER the shared canvas (§14 merge) — the shell file itself is not touched.
 */

import "./timeline-3d.css";

export function AtmosphereBackdrop() {
  return (
    <div
      aria-hidden="true"
      className="paper-stock pointer-events-none absolute inset-0 overflow-hidden"
    />
  );
}

/** Keyframes still used by the field, injected once by the shell
 *  (client-only, ssr:false). The aurora drift and NOW-ring breathe died with
 *  the atmosphere they animated; the panel dock-in and the ?at= flash remain. */
export const TIMELINE_KEYFRAMES = `
/* Card entrance (Rev 9 §R9.4): the staggered rise lives in the field's
   generation-window motion wrapper — .tl-card-in remains only as the card
   MARKER class (e2e selector), no CSS animation. Scroll-mounted rows must
   not re-play an entrance. */
/* Reading panel dock-in (§R7.3): a short slide + fade on mount. */
@keyframes tl-panel-in {
  from { opacity: 0; transform: translateY(12px); }
  to { opacity: 1; transform: translateY(0); }
}
@media (min-width: 768px) {
  @keyframes tl-panel-in {
    from { opacity: 0; transform: translateX(24px); }
    to { opacity: 1; transform: translateX(0); }
  }
}
.tl-panel-in { animation: tl-panel-in 260ms cubic-bezier(0.22, 1, 0.36, 1) both; }
/* ?at= deep-link flash (Rev 8): a brief primary ring pulse on the target row. */
@keyframes tl-flash {
  0%, 100% { box-shadow: 0 0 0 0 transparent; }
  35% { box-shadow: 0 0 0 3px color-mix(in oklch, var(--primary) 55%, transparent); }
}
.tl-flash { animation: tl-flash 1.6s ease-out 2; }
@media (prefers-reduced-motion: reduce) {
  .tl-flash { animation: none !important; }
}
`;
