"use client";

/**
 * Timeline atmosphere — the 2.5D scene's environment lives OUTSIDE the WebGL
 * canvas as CSS overlays (doc/design/v0.10.0-memory-viz.md §5.3: 氛围层是场景
 * 外的 CSS 覆盖层，不做 3D 几何). Mirrors previously-site's stage-atmosphere:
 * a whisper-quiet 72px grid, three slow-drifting aurora glows, and an edge
 * vignette — all pointer-transparent, transform/opacity animation only.
 *
 * `AtmosphereBackdrop` renders BEHIND the transparent canvas; `Vignette`
 * renders above it (it must not eat pointer events — the scene's gestures
 * pass through).
 */

import "./timeline-3d.css";

export function AtmosphereBackdrop() {
  return (
    <div
      aria-hidden="true"
      className="tl-backdrop pointer-events-none absolute inset-0 overflow-hidden bg-background"
    >
      {/* Dominant brand aurora — upper stage */}
      <div
        className="tl-aurora tl-aurora-brand absolute -top-[20%] left-1/2 h-[55vh] w-[80vw] -translate-x-1/2 rounded-full blur-2xl sm:blur-3xl"
      />
      {/* Two fainter echoes of the SAME brand hue, not two other hues — the
          atmosphere is one colour drifting, not a light show. These were an
          amber and an emerald, the last two literal survivors of the retired
          five-entry strand palette, which left the backdrop carrying two hues
          that no longer meant anything anywhere in the product.
          (Desktop only: big blur layers are a mobile scroll-jank source.) */}
      <div
        className="tl-aurora-slow tl-aurora-echo-w absolute bottom-[5%] -left-[10%] hidden h-[40vh] w-[45vw] rounded-full blur-3xl sm:block"
      />
      <div
        className="tl-aurora tl-aurora-echo-e absolute top-[35%] -right-[12%] hidden h-[40vh] w-[40vw] rounded-full blur-3xl sm:block"
      />
      {/* 72px grid, radially masked so it dissolves at the edges */}
      <div className="tl-grid-overlay absolute inset-0" />
    </div>
  );
}

export function AtmosphereVignette() {
  return (
    <div
      aria-hidden="true"
      className="tl-vignette pointer-events-none absolute inset-0"
    />
  );
}

/** Keyframes shared by the atmosphere + the NOW convergence point. Injected
 *  once by the scene (client-only, ssr:false). */
export const TIMELINE_KEYFRAMES = `
@keyframes tl-aurora-drift {
  from { transform: translate3d(-2%, 1%, 0) scale(1); }
  to { transform: translate3d(2%, -3%, 0) scale(1.07); }
}
.tl-aurora { animation: tl-aurora-drift 26s ease-in-out infinite alternate; will-change: transform; }
.tl-aurora-slow { animation: tl-aurora-drift 38s ease-in-out infinite alternate-reverse; will-change: transform; }
@keyframes tl-now-breathe {
  0%, 100% { opacity: 0.15; transform: scale(1); }
  50% { opacity: 0.4; transform: scale(1.3); }
}
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
  .tl-aurora, .tl-aurora-slow, .tl-now-ring, .tl-flash { animation: none !important; }
}
`;
