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
 * content — and the CONTENT reserves the room for it (`chat-page.tsx` pads the
 * column top and bottom by the measured chrome height), which is the one
 * arrangement that keeps the composer off the text without making it part of
 * the layout.
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
import { useEffect, useState } from "react";
import type { FieldRung } from "@/lib/timeline3d/units";

/** What the composer is told about the form it is being asked to draw. */
export interface ComposerForm {
  /** Draw the compact one-row form. No textarea, no attach, no model picker. */
  collapsed: boolean;
  /** Restore the full form. Wired to the pill's arrow. */
  expand: () => void;
}

export interface ComposerHostProps {
  rung: FieldRung;
  /** The live composer, as a function of the form it should take. */
  composer: (form: ComposerForm) => React.ReactNode;
}

export function ComposerHost({ rung, composer }: ComposerHostProps) {
  const [open, setOpen] = useState(false);

  const onConversation = rung === "conversation";

  // Leaving the conversation rung puts the composer back in its pocket, so a
  // reader who types, submits and lands on the conversation does not find a
  // floating card still hanging over it.
  useEffect(() => {
    if (onConversation) setOpen(false);
  }, [onConversation]);

  /** The compact form is the DEFAULT at a card rung and never at the
   *  conversation one — see the module header. */
  const collapsed = !onConversation && !open;

  return (
    <div
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
