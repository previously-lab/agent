"use client";

/**
 * ComposerHost — WHERE the composer sits, which changes with the rung.
 *
 * IT ALWAYS FLOATS. It used to be a full-width footer at the conversation rung
 * — a `shrink-0` child of the shell's column, so it TOOK its height from the
 * content and pushed the last message up. That made the composer a piece of
 * the page furniture rather than one of the app's floating controls, and the
 * app has no page furniture: everything else is an island over an infinite
 * canvas. So at every rung it is now the same thing — a floating card over the
 * content — and the CONTENT reserves the room for it, which is the one
 * arrangement that keeps the composer off the text without making it part of
 * the layout.
 *
 * THE ROOM COMES OFF THE CONTENT'S EXTENT, NOT OFF THE COLUMN. The column used
 * to carry this number as a padding, which looked like the same thing and was
 * not: the column is `overflow-hidden`, so a padding on it CROPS the content at
 * that edge. The number goes up to the shell instead and comes back down to
 * both fields as an inset on their camera range — see `minOffsetFor`.
 *
 * The compact form is the card rung's default and never the conversation's.
 *
 * THE COMPOSER ITSELF IS NEVER UNMOUNTED. That is the whole reason this is a
 * component rather than two branches in `ChatPage`: the composer owns state
 * that is invisible and expensive to lose — the image attachments
 * (`useImageAttachments`) and whatever has been typed but not sent. A reader
 * who starts a sentence at the `week` rung and then taps a segment to look at
 * something would lose it. So the composer is handed in as a RENDER PROP and
 * called with the state it should draw itself in: one component instance, one
 * early return, and no state anywhere near the remount boundary.
 *
 * This host owns the one bit of state that decides which form that is (`open`)
 * because it is also the piece that decides where the container goes, and
 * splitting those two across the boundary is how the pill ends up positioned
 * as a card.
 *
 * Submitting is not handled here — `ChatPage` wraps the submit so a send from a
 * card rung returns to the conversation first, because that is where the reply
 * is going to be written and watching it arrive is the point of sending.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { FieldRung } from "@/lib/timeline3d/units";

/** What the composer is told about the form it is being asked to draw. */
export interface ComposerForm {
  /** Draw the compact one-row form. No textarea, no attach, no model picker. */
  collapsed: boolean;
  /** Restore the full form. Wired to the pill's arrow. */
  expand: () => void;
}

/** The gap between the bottom edge the composer hangs from and the bottom of
 *  the viewport, at each size — the same numbers the container's `bottom-*`
 *  carries. Named once so the clearance reported upward cannot drift from the
 *  position actually used. */
const COMPOSER_OFFSET_PX = 12;
/** Breathing room between the composer's top edge and the content it floats
 *  over. Small: the composer is chrome, and a large gap reads as a footer. */
const COMPOSER_GAP_PX = 16;

export interface ComposerHostProps {
  rung: FieldRung;
  /** The live composer, as a function of the form it should take. */
  composer: (form: ComposerForm) => React.ReactNode;
  /**
   * How much room the content must leave at its foot, in px — the composer's
   * own height plus its offset plus a gap.
   *
   * MEASURED, BECAUSE IT CANNOT BE KNOWN. The full form grows with what is
   * typed into it (a textarea that reaches 160px) and with what is attached to
   * it (a preview row), so the only honest source for "how much room does this
   * need" is the thing itself. It was a constant, and the constant was wrong:
   * the reserve said 144px while the composer could reach 300, so a long draft
   * put the composer over the newest message — the one thing the reserve exists
   * to keep visible.
   */
  onClearanceChange?: (px: number) => void;
}

export function ComposerHost({
  rung,
  composer,
  onClearanceChange,
}: ComposerHostProps) {
  const [open, setOpen] = useState(false);
  const hostRef = useRef<HTMLDivElement>(null);

  const onConversation = rung === "conversation";

  // ARRIVING at the conversation rung puts the composer back in its pocket, so
  // a reader who opened the full form at a card rung and then returned does not
  // find the floating card still hanging over the conversation.
  useEffect(() => {
    if (onConversation) setOpen(false);
  }, [onConversation]);

  /** The compact form is the DEFAULT at a card rung and never at the
   *  conversation one — see the module header. */
  const collapsed = !onConversation && !open;

  // Report the clearance whenever the composer changes size — a draft growing
  // the textarea, an attachment arriving, the two forms swapping.
  //
  // A LAYOUT EFFECT, because it is the whole reason the first frame is right.
  // There used to be a `pb-36` seed on the column to cover the gap between
  // mount and measurement; with the number feeding a camera range instead,
  // there is nothing for a CSS seed to hold in place, and a passive effect
  // would let the live edge paint once underneath the composer before moving.
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
        collapsed
          ? // `w-auto` so the pill is exactly as wide as its own controls. A
            // fixed width here is how the old round button ended up 44rem wide
            // with a 48px face centred in it.
            "absolute bottom-[max(1.25rem,env(safe-area-inset-bottom,1.25rem))] left-1/2 z-50 w-auto -translate-x-1/2"
          : // One floating card, at BOTH rungs. 44rem is the reading column's
            // own order of magnitude, so the composer's edges sit near the
            // content's edges without a second measurement to keep in step.
            "absolute inset-x-0 bottom-[max(0.75rem,env(safe-area-inset-bottom,0.75rem))] z-20 flex justify-center px-3"
      }
    >
      <div className={collapsed ? "" : "w-[min(44rem,100%)]"}>
        {composer({ collapsed, expand: () => setOpen(true) })}
      </div>
    </div>
  );
}
