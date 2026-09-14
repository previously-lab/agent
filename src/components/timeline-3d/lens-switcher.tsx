"use client";

/**
 * LensSwitcher — the segmented control for the rung ladder: 对话 · 片 · 日 · 周.
 * It is the visible half of the CardField zoom: clicking a segment requests
 * that StackLevel through the same anchored transition as the ctrl+wheel /
 * pinch gestures, and any level change (gesture included) moves the selection.
 *
 * IT SAYS THE RUNG'S NAME ONLY FOR THE RUNG YOU ARE ON. Every segment carries
 * its icon; the selected one grows a word beside it. Two reasons, and the
 * second is the real one:
 *
 *   1. Four labels is a wide control, and this one shares a bar with the
 *      strand selector.
 *   2. A ladder is read by comparing where you ARE against where you can go.
 *      Four lit words state only the destinations; one lit word states the
 *      position. The icons stay for the rest, so nothing becomes unlabelled —
 *      each still has its `aria-label` and its tooltip.
 *
 * It is INLINE (no positioning of its own). It used to float itself at the
 * right pane's bottom-right; the shell now seats it in the board bar at the
 * top of the screen, where it is mounted at every rung — inside the card field
 * it vanished on the conversation rung, which is precisely where a reader
 * needs it to get back to the cards.
 *
 * A one-shot hint bubble ("Ctrl+scroll or pinch to zoom" / pinch-first on
 * touch screens) fades in below the bar and dismisses itself the first time
 * the level changes — the user has discovered zoom either way. The dismissal
 * is remembered in localStorage so it never nags again.
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
import { ISLAND } from "@/components/layout/island";

const HINT_KEY = "previously:lens-hint-seen:v1";

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
    <div className="relative">
      <div
        role="group"
        aria-label={t("label")}
        className={`${ISLAND} flex items-center gap-0.5 p-0.5 text-xs`}
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
              // One height for every segment, active or not: the segment that
              // grows a word must not also grow the BAR, or the whole top row
              // changes height as you step along the ladder.
              className={`flex h-7 items-center gap-1 rounded-full transition-colors ${
                active
                  ? "bg-background px-2.5 text-foreground shadow-sm"
                  : "px-2 text-muted-foreground hover:text-foreground"
              }`}
            >
              <Icon className="h-3 w-3 shrink-0" />
              {/* The word appears only here, and it appears on BOTH ends of the
                  ladder — the phone gets the same statement, just narrower. */}
              {active && <span className="whitespace-nowrap">{t(key)}</span>}
            </button>
          );
        })}
      </div>

      {/* The hint hangs BELOW the bar. It used to sit beside the pill and
          stack above it under `sm`, which was right for a control anchored to
          the bottom-right corner; a control on the top edge has room beneath
          it at every width, so the two layouts collapse into one.

          EXCEPT AT PHONE WIDTH, where the room beneath the board bar is the
          SETTINGS ISLAND. The header wraps at that width, so the island's own
          row sits directly under this bar — `mt-2` put the bubble's bottom
          corner on top of it, two controls overlapping. `mt-16` drops the
          bubble clear of that whole row (`p-2` + `h-9` + `gap-2` + `h-9` +
          `p-2` = 96px of chrome, measured from the bar's own bottom edge). It
          reads as a tip under the toolbar, which is what it is; from `sm` up
          the islands share one line and the bubble hangs where it always did. */}
      <AnimatePresence>
        {hintOpen && (
          <motion.div
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={
              reducedMotion ? { duration: 0 } : { duration: 0.35, ease: "easeOut" }
            }
            className={`${ISLAND} pointer-events-none absolute top-full left-1/2 mt-16 w-max max-w-[70vw] -translate-x-1/2 px-3 py-1.5 text-center text-[11px] text-muted-foreground sm:mt-2`}
          >
            {coarse ? t("hintTouch") : t("hintDesktop")}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
