"use client";

/** On-demand manuscript index. Selecting a document returns the space to reading. */
import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useTranslations } from "next-intl";
import { BookMarked, X } from "lucide-react";
import { ISLAND, ISLAND_CONTROL } from "@/components/layout/island";
import { useShell } from "@/components/shell/shell-provider";
import { DocLibrary } from "./doc-library";

export function LibraryControl({
  persona,
  reducedMotion,
}: {
  persona?: string;
  reducedMotion: boolean;
}) {
  const t = useTranslations("library");
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const { deskDoc } = useShell();
  const lastDeskDocRef = useRef(deskDoc);
  useEffect(() => {
    if (deskDoc === lastDeskDocRef.current) return;
    lastDeskDocRef.current = deskDoc;
    if (
      deskDoc !== null &&
      open
    ) {
      setOpen(false);
    }
  }, [deskDoc, open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // Claim the key: the desk's backstop must not put the document back
        // underneath the still-open panel.
        e.preventDefault();
        setOpen(false);
      }
    };
    // Claim Escape before the already-mounted reader's window listener.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const root = rootRef.current;
      if (root && e.target instanceof Node && !root.contains(e.target)) {
        setOpen(false);
      }
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  return (
    <div
      ref={rootRef}
      data-library-control
      className="pointer-events-none fixed left-4 top-1/2 z-40 -translate-y-1/2 md:left-8"
    >
      <button
        type="button"
        data-library-toggle
        aria-expanded={open}
        aria-label={t("toggle")}
        onClick={() => setOpen((v) => !v)}
        className={`${ISLAND} pointer-events-auto flex size-10 items-center justify-center text-muted-foreground transition-colors hover:text-foreground`}
      >
        <BookMarked className="size-4" />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            data-library-panel
            role="dialog"
            aria-label={t("title")}
            initial={reducedMotion ? { opacity: 1 } : { opacity: 0, x: -6 }}
            animate={{ opacity: 1, x: 0 }}
            exit={reducedMotion ? { opacity: 0 } : { opacity: 0, x: -6 }}
            transition={
              reducedMotion ? { duration: 0 } : { duration: 0.2, ease: "easeOut" }
            }
            className="chrome-panel pointer-events-auto absolute left-full top-1/2 ml-3 w-[min(23rem,calc(100vw-2rem))] max-md:w-[min(23rem,calc(100vw-84px))] -translate-y-1/2"
          >
            {/* The panel's own header (P6 ②, roadmap #9): a phone has no
                Escape and the toggle is easy to miss, so the way out lives
                here, beside the title. The panel is chrome, not paper — the
                ISLAND_CONTROL vocabulary applies. The header stays OUTSIDE
                the scroll area so the close is visible at any scroll depth. */}
            <div className="chrome-panel-head">
              <h2 className="chrome-engraved">{t("title")}</h2>
              <button
                type="button"
                data-library-close
                onClick={() => setOpen(false)}
                aria-label={t("close")}
                title={t("close")}
                className={`${ISLAND_CONTROL} size-6 shrink-0`}
              >
                <X className="size-3.5" />
              </button>
            </div>
            <div className="max-h-[min(30rem,70dvh)] overflow-y-auto">
              <DocLibrary persona={persona} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
