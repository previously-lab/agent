"use client";

/**
 * One persistent seat for the manuscript composer. Fullscreen places the
 * writer after the last turn in the stream; the pill positions the same tree
 * against the panel. Only classes change at a tier boundary, so drafts,
 * attachments, focus and IME state retain one mount identity.
 *
 * The measured height still travels upward. The list uses it as a live-edge
 * signal while the in-flow writer supplies its own scroll extent.
 */
import { useLayoutEffect, useRef } from "react";
import { usePanelTier } from "./conversation-panel";
import "./writing.css";

/** The gap between the bottom edge the composer hangs from and the bottom of
 *  the viewport — the same number the container's `bottom-*` carries. Named
 *  once so the clearance reported upward cannot drift from the position
 *  actually used. */
const COMPOSER_OFFSET_PX = 12;
/** Breathing room between the composer's top edge and the content it floats
 *  over. Small: the composer is chrome, and a large gap reads as a footer. */
const COMPOSER_GAP_PX = 16;

export interface ComposerHostProps {
  /** The live composer. A plain node: the host dictates no form (the card
   *  rungs' collapsed form retired with the ladder) — the tier only changes
   *  the chrome around it. */
  composer: React.ReactNode;
  /**
   * The composer's measured height plus its standard offset and gap. In the
   * manuscript this signals growth to the live-edge pin; pill layouts also
   * use it as their reserved clearance.
   *
   * MEASURED, BECAUSE IT CANNOT BE KNOWN. The composer grows with what is
   * typed into it (a naturally growing manuscript) and with what is attached
   * to it (a preview row), so the only honest source for "how much room does
   * this need" is the thing itself. It was a constant, and the constant was
   * wrong: the reserve said 144px while the composer could reach 300, so a
   * long draft put the composer over the newest message — the one thing the
   * reserve exists to keep visible.
   */
  onClearanceChange?: (px: number) => void;
}

export function ComposerHost({ composer, onClearanceChange }: ComposerHostProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const tier = usePanelTier();

  /** The pill is the panel's collapsed tier — see the module header. */
  const onPill = tier?.mode === "pill";

  // Report the clearance whenever the composer changes size — a draft growing
  // the textarea, an attachment arriving.
  //
  // A LAYOUT EFFECT, because it is the whole reason the first frame is right.
  // There used to be a `pb-36` seed on the column to cover the gap between
  // mount and measurement; a passive effect would let the live edge paint
  // once underneath the composer before moving.
  // `useEffect` → `useLayoutEffect` is exactly that one frame.
  useLayoutEffect(() => {
    const el = hostRef.current;
    if (!el || !onClearanceChange) return;
    const report = (): void => {
      const h = el.getBoundingClientRect().height;
      if (h > 0) {
        onClearanceChange(Math.ceil(h) + COMPOSER_OFFSET_PX + COMPOSER_GAP_PX);
      }
    };
    report();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(report);
    ro.observe(el);
    return () => ro.disconnect();
  }, [onClearanceChange]);

  return (
    <div
      ref={hostRef}
      data-composer
      className={
        onPill
          ? // The pill's seat: centred over the panel box (which spans the
            // viewport) with side margins, bottom-4 (= PILL_BOTTOM_GAP_PX)
            // above the box's bottom edge. The row itself stays
            // POINTER-TRANSPARENT: it spans the full viewport width, and
            // letting it eat clicks would wall off the whole bottom edge
            // from the world — only the pill's own glass box (the inner
            // wrapper) opts back in.
            "pointer-events-none absolute inset-x-0 bottom-4 z-10 flex justify-center px-2 md:px-4"
          : // At the manuscript tier the composer is the next paragraph in
            // the stream, not a card floating over the last reply. Its own
            // layout height supplies the stream extent; the measurement is
            // still reported so the live-edge pin follows a growing draft.
            "relative w-full shrink-0"
      }
    >
      <div
        className={
          onPill
            ? // Only the floating glass pill takes pointer events; the
              // surrounding row lets the reader interact with the world.
              "pointer-events-auto pill-box flex h-12 min-w-0 w-full items-center"
            : "w-full"
        }
      >
        {composer}
      </div>
    </div>
  );
}
