"use client";

/**
 * LensSwitcher (v0.12) — the timeline's floating zoom-lens control: a
 * segmented pill 「片 · 日 · 周」 parked at the right pane's bottom-right,
 * in the same frosted-island language as the header pills. It is the visible
 * half of the CardField zoom: clicking a segment requests that StackLevel
 * through the same anchored transition as the ctrl+wheel / pinch gestures,
 * and any level change (gesture included) moves the active segment.
 *
 * A one-shot hint bubble ("Ctrl+scroll or pinch to zoom" / pinch-first on
 * touch screens) fades in beside the pill and dismisses itself the first
 * time the level changes — the user has discovered zoom either way. The
 * dismissal is remembered in localStorage so it never nags again.
 */
import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useTranslations } from "next-intl";
import {
  CalendarDays,
  CalendarRange,
  Clapperboard,
  MessagesSquare,
} from "lucide-react";
import { RUNG_ORDER, type FieldRung } from "@/lib/timeline3d/units";

const HINT_KEY = "previously:lens-hint-seen:v1";

/** Shared frosted-pill shell — keep in sync with the header islands. */
const ISLAND =
  "rounded-full bg-background/75 ring-1 ring-border/60 backdrop-blur-md shadow-md";

/** Finest first, the order `RUNG_ORDER` states — the segments are that list
 *  wearing icons, so the control cannot drift out of step with the ladder it
 *  offers. */
const SEGMENTS: Record<FieldRung, { key: FieldRung; Icon: typeof Clapperboard }> = {
  conversation: { key: "conversation", Icon: MessagesSquare },
  slice: { key: "slice", Icon: Clapperboard },
  day: { key: "day", Icon: CalendarDays },
  week: { key: "week", Icon: CalendarRange },
};

export function LensSwitcher({
  rung,
  onSelect,
  reducedMotion,
}: {
  rung: FieldRung;
  onSelect: (rung: FieldRung) => void;
  reducedMotion: boolean;
}) {
  const t = useTranslations("timeline3d.lens");
  const [hintOpen, setHintOpen] = useState(false);
  const [coarse, setCoarse] = useState(false);

  // Client-only facts (localStorage, pointer type) — read after mount so the
  // first paint matches the server and no hint flashes for returning users.
  useEffect(() => {
    setHintOpen(localStorage.getItem(HINT_KEY) !== "1");
    setCoarse(window.matchMedia("(pointer: coarse)").matches);
  }, []);

  // The first rung change — a switcher click, a gesture, or a unit click —
  // means the user found zoom; dismiss the hint and remember it.
  const prevRungRef = useRef(rung);
  useEffect(() => {
    if (prevRungRef.current === rung) return;
    prevRungRef.current = rung;
    setHintOpen((open) => {
      if (open) localStorage.setItem(HINT_KEY, "1");
      return false;
    });
  }, [rung]);

  return (
    // z-40: the card faces are drei Html overlays pinned at z-index 21–30
    // (row-group/leaving-card zIndexRange) — the pill must stack above every
    // card, yet still below the floating header islands (z-50).
    <div className="pointer-events-none absolute right-3 bottom-16 z-40 flex items-center gap-2 sm:right-5 sm:bottom-20">
      <AnimatePresence>
        {hintOpen && (
          <motion.div
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={
              reducedMotion ? { duration: 0 } : { duration: 0.35, ease: "easeOut" }
            }
            className={`${ISLAND} px-3 py-1.5 text-[11px] whitespace-nowrap text-muted-foreground`}
          >
            {coarse ? t("hintTouch") : t("hintDesktop")}
          </motion.div>
        )}
      </AnimatePresence>

      <div
        role="group"
        aria-label={t("label")}
        className={`${ISLAND} pointer-events-auto flex items-center gap-0.5 p-0.5 text-xs`}
      >
        {RUNG_ORDER.map((segRung) => {
          const { key, Icon } = SEGMENTS[segRung];
          const active = segRung === rung;
          return (
            <button
              key={key}
              type="button"
              aria-pressed={active}
              aria-label={t(key)}
              title={t(key)}
              onClick={() => onSelect(segRung)}
              className={`flex min-h-9 items-center gap-1 rounded-full px-3 transition-colors sm:min-h-7 sm:px-2.5 ${
                active
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <Icon className="h-3 w-3 shrink-0" />
              <span className="hidden sm:inline">{t(key)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
