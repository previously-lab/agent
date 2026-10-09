"use client";

/**
 * ComposerHost — WHERE the composer sits, and how much room the content
 * leaves for it.
 *
 * IT ALWAYS FLOATS. It used to be a full-width footer — a `shrink-0` child of
 * the shell's column, so it TOOK its height from the content and pushed the
 * last message up. That made the composer a piece of the page furniture
 * rather than one of the app's floating controls, and the app has no page
 * furniture: everything else is an island over an infinite canvas. So it is
 * the same thing at every tier — a floating card over the content — and the
 * CONTENT reserves the room for it, which is the one arrangement that keeps
 * the composer off the text without making it part of the layout.
 *
 * THE PANEL TIER DECIDES THE SEAT (v0.13 §4). The host reads the surrounding
 * `ConversationPanel`'s tier through `PanelTierContext`: at the pill tier the
 * composer IS the pill — centred a `PILL_BOTTOM_GAP_PX` above the panel
 * box's bottom edge (the box is chromeless there), at most
 * `--pill-max-width` (globals.css) wide, and carrying the pill's glass chrome
 * (rounded-full, translucent background, hairline ring, backdrop blur); at
 * fullscreen it floats over the body exactly as it always has. `ChatInput`
 * reads the same context to draw its pill form. One component instance
 * throughout: the tier only ever changes classes, never the mount.
 *
 * THE COMPOSER ITSELF IS NEVER UNMOUNTED. That is the whole reason this is a
 * component rather than a branch in `ChatPage`: the composer owns state that
 * is invisible and expensive to lose — the image attachments
 * (`useImageAttachments`) and whatever has been typed but not sent. So the
 * composer arrives as a plain child and the tier only ever changes the chrome
 * AROUND it: one component instance, and no state anywhere near a remount
 * boundary.
 *
 * Submitting is not handled here — `ChatPage` wraps the submit so a send from
 * the pill rises the panel first, because that is where the reply is going to
 * be written and watching it arrive is the point of sending.
 */
import { useLayoutEffect, useRef } from "react";
import { usePanelTier } from "./conversation-panel";

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
   * How much room the content must leave at its foot, in px — the composer's
   * own height plus its offset plus a gap.
   *
   * MEASURED, BECAUSE IT CANNOT BE KNOWN. The composer grows with what is
   * typed into it (a textarea that reaches 160px) and with what is attached
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
            "pointer-events-none absolute inset-x-0 bottom-4 z-10 flex justify-center px-4"
          : // One floating card. 44rem is the reading column's own order of
            // magnitude, so the composer's edges sit near the content's
            // edges without a second measurement to keep in step.
            "absolute inset-x-0 bottom-[max(0.75rem,env(safe-area-inset-bottom,0.75rem))] z-20 flex justify-center px-3"
      }
    >
      <div
        className={
          onPill
            ? // The glass pill itself — rounded-full, translucent paper over
              // the world, hairline ring, soft shadow, and a blur so the
              // world reads through it. THE interactive surface at this
              // tier: the only box on the bottom edge that takes pointer
              // events — the row around it is transparent, so the world
              // keeps every click outside the pill itself.
              "pointer-events-auto pill-box h-12 min-w-0 w-full items-center overflow-hidden rounded-full bg-background/70 shadow-[0_12px_32px_-12px_rgba(15,23,42,0.4)] ring-1 ring-foreground/10 backdrop-blur-md dark:shadow-[0_12px_32px_-12px_rgba(0,0,0,0.8)]"
            : "w-[min(44rem,100%)]"
        }
      >
        {composer}
      </div>
    </div>
  );
}
