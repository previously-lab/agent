"use client";

/**
 * ComposerHost — the composer's CHROME, which changes with the rung.
 *
 * At the conversation rung the composer is a full-width bar at the foot of the
 * page, which is what a reader typing a conversation expects. At any card rung
 * it would be an enormous empty box sitting on top of the field the reader is
 * actually looking at, so it gets out of the way: a round button at the bottom
 * of the screen, which grows into a bar with a prompt when the pointer reaches
 * it, and opens into a floating card to type into.
 *
 * THE COMPOSER ITSELF IS NEVER UNMOUNTED. That is the whole reason this is a
 * component rather than two branches in `ChatPage`: the composer owns state
 * that is invisible and expensive to lose — the image attachments
 * (`useImageAttachments`) and whatever has been typed but not sent. A reader
 * who starts a sentence at the `week` rung and then taps a segment to look at
 * something would lose it. So one tree is rendered and only the CONTAINER's
 * classes change; the chrome around it is what appears and disappears.
 *
 * Submitting is not handled here — `ChatPage` wraps the submit so a send from a
 * card rung returns to the conversation first, because that is where the reply
 * is going to be written and watching it arrive is the point of sending.
 */
import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { MessageSquarePlus } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import type { FieldRung } from "@/lib/timeline3d/units";

export interface ComposerHostProps {
  rung: FieldRung;
  /** The live composer. Always mounted — see the header. */
  composer: React.ReactNode;
}

/** Shared frosted-pill shell — keep in sync with the header islands and the
 *  lens switcher. */
const ISLAND =
  "rounded-full bg-background/75 ring-1 ring-border/60 backdrop-blur-md shadow-md";

export function ComposerHost({ rung, composer }: ComposerHostProps) {
  const t = useTranslations("composer");
  const reducedMotion = useReducedMotion() ?? false;
  const [hovered, setHovered] = useState(false);
  const [open, setOpen] = useState(false);

  const onConversation = rung === "conversation";

  // Leaving the conversation rung puts the composer back in its pocket, so a
  // reader who types, submits and lands on the conversation does not find a
  // floating card still hanging over it.
  useEffect(() => {
    if (onConversation) setOpen(false);
  }, [onConversation]);

  const showingComposer = onConversation || open;
  const fade = reducedMotion ? { duration: 0 } : { duration: 0.22, ease: "easeOut" as const };

  return (
    <>
      {/* ── The composer's container. ONE tree; only these classes change. ── */}
      <div
        className={
          onConversation
            ? "relative z-20 w-full shrink-0 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom,0.5rem))]"
            : `fixed bottom-[max(0.75rem,env(safe-area-inset-bottom,0.75rem))] left-1/2 z-50 w-[min(44rem,calc(100vw-2rem))] -translate-x-1/2 transition-opacity duration-200 ${
                showingComposer
                  ? "opacity-100"
                  : "pointer-events-none opacity-0"
              }`
        }
        // Hidden-but-mounted must not be reachable by keyboard or by a screen
        // reader: `inert` removes the whole subtree from the focus order and the
        // accessibility tree without unmounting it, which is exactly the state
        // this needs.
        inert={!showingComposer || undefined}
      >
        <div
          className={
            onConversation
              ? "mx-auto w-full max-w-5xl xl:max-w-7xl px-3 sm:px-6 lg:px-8"
              : "rounded-2xl bg-background/85 p-2 ring-1 ring-border/60 shadow-xl backdrop-blur-md"
          }
        >
          {composer}
        </div>
      </div>

      {/* ── The collapsed control. Never on the conversation rung. ── */}
      {!showingComposer && (
        <div
          className="fixed bottom-[max(1.25rem,env(safe-area-inset-bottom,1.25rem))] left-1/2 z-20 -translate-x-1/2"
          onPointerEnter={() => setHovered(true)}
          onPointerLeave={() => setHovered(false)}
          onFocus={() => setHovered(true)}
          onBlur={() => setHovered(false)}
        >
          <motion.button
            type="button"
            data-composer-collapsed
            aria-label={t("open")}
            onClick={() => setOpen(true)}
            initial={false}
            animate={{ width: hovered ? "auto" : 48 }}
            transition={fade}
            className={`${ISLAND} pointer-events-auto flex h-12 items-center justify-center gap-2 overflow-hidden px-3.5 text-sm text-muted-foreground hover:text-foreground`}
          >
            <MessageSquarePlus className="size-5 shrink-0" />
            <motion.span
              initial={false}
              animate={{ opacity: hovered ? 1 : 0, width: hovered ? "auto" : 0 }}
              transition={fade}
              className="overflow-hidden whitespace-nowrap"
            >
              {t("hint")}
            </motion.span>
          </motion.button>
        </div>
      )}
    </>
  );
}
