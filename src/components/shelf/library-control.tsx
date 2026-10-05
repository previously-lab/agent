"use client";

/**
 * The floating library control (v0.24) — the reader's three-level filter
 * (category → case → piece) as one of the app's floating islands, the
 * board-bar / lens-switcher idiom: a `pointer-events-none` wrapper at a fixed
 * seat, the control itself `pointer-events-auto`. The v0.23 reader rendered
 * the same tree as a permanent left column; the user retired the column (the
 * canvas keeps the full pane, the paper centres), so the tree moved into this
 * panel, browsing state and contracts intact (`DocLibrary` is unchanged).
 *
 * THE SEAT. Mid-left edge, vertically centred — the top is the header's and
 * the board bar's, the right edge is the pod's and the jump controls', the
 * bottom-centre is the composer's, the bottom-left is the page control's.
 * Same seat at every width: below `md` the column used to vanish entirely;
 * the floating control is the only door now, so it never hides.
 *
 * BEHAVIOUR. The panel stays open on a selection — browsing the shelf while
 * the paper reads is the v0.23 column's own rhythm. Escape closes the PANEL
 * alone: the handler preventDefaults, and the desk's window backstop defers
 * to a claimed key, so the document stays on the desk (a second Escape puts
 * it back). An outside pointerdown closes too; the button toggles.
 */
import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useTranslations } from "next-intl";
import { BookMarked } from "lucide-react";
import { ISLAND } from "@/components/layout/island";
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
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
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
      className="pointer-events-none fixed left-4 top-1/2 z-40 -translate-y-1/2 sm:left-6"
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
            className="pointer-events-auto absolute left-full top-1/2 ml-3 w-[min(23rem,calc(100vw-2rem))] -translate-y-1/2 rounded-2xl bg-background/90 shadow-md ring-1 ring-border/60 backdrop-blur-md"
          >
            <div className="max-h-[min(30rem,70dvh)] overflow-y-auto">
              <DocLibrary persona={persona} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
