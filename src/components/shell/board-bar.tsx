"use client";

/**
 * BoardBar — the middle of the app's top row, and the one that belongs to
 * the WORLD rather than to the app around it.
 *
 *   LEFT    brand inscription       (`layout/app-header.tsx`)
 *   MIDDLE  the board bar           this file — the rung dateline
 *   RIGHT   search + overflow       (`layout/app-header.tsx`)
 *
 * It carries the TWO RUNGS — 现场 · 原稿 (Scene · Manuscript), the world's
 * two faces. The zoom ladder it replaced (对话 · 片 · 日 · 周) retired with the
 * conversation rung: the world is the hotel or the documents, and selecting a
 * rung asks the shell's transition machine for that world — a move, never
 * a snap.
 *
 * ONE INSTRUMENT BAR (v0.29 §4.2, amended by the owner on first look): the
 * segmented pill is still gone — no per-rung backgrounds, no active chrome
 * pill — but the two words sit INSIDE a single `chrome-bar`. The de-contained
 * version was designed against a paper bed; `/app`'s bed is the frozen,
 * blurred world, and bare mono over a picture loses the contrast a control
 * needs. So: the words stay, the `·` stays, the current one still stands at
 * 700 with its 2px ink underline, and the bar around them is the same matte
 * instrument as every other control. The brand inscription stays bare — it is
 * not something the reader has to find, so it does not need a container.
 *
 * THE TRANSITION RULE: while a move is live, the underline LEAVES the old
 * word and grows toward the new one — the shell's transition clock read as
 * print, a progress bar disguised as typography. The clock is the shared
 * singleton `WORLD_TRANSITION` (world-transition.ts): the shell's rAF
 * writes `progress` 0→1 every frame; this bar polls the singleton at a
 * slow interval to learn a move has started (React state — which word is
 * old, which is new), then paints `--p` on the growing rule every frame
 * until the move settles. The growth is eased here (the clock's raw
 * progress is linear) so the line travels like ink, not like a loader.
 *
 * It is mounted by the SHELL, not by either world, because it must exist at
 * either rung. In the hotel the world's own Exit is the way back — the game
 * keeps its viewport clear of product chrome.
 */
import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import type { WorldKind } from "@/components/timeline-3d/world-contract";
import {
  smooth01,
  WORLD_TRANSITION,
} from "@/lib/timeline3d/world-transition";

export interface BoardBarProps {
  /** The rung to light — the settled world, or the destination mid-move. */
  world: WorldKind;
  onSelect: (world: WorldKind) => void;
}

/** The two rungs in the strip's left-to-right order. */
const RUNGS: WorldKind[] = ["game", "field"];

/** How often the strip checks whether a move has started/stopped. The
 *  paint itself is rAF-driven; this only flips the React-visible move
 *  state (which word is old/new), so a coarse clock is fine. */
const MOVE_SYNC_MS = 120;

export function BoardBar({ world, onSelect }: BoardBarProps) {
  const t = useTranslations("rungs");
  /** The growing rule's track — `--p` is painted imperatively, no re-render. */
  const lineRef = useRef<HTMLSpanElement>(null);
  /** The live move, once one is running — drives the old/new word styling. */
  const [move, setMove] = useState<{ from: WorldKind; to: WorldKind } | null>(
    null,
  );

  useEffect(() => {
    let raf = 0;
    const paint = (): void => {
      lineRef.current?.style.setProperty(
        "--p",
        WORLD_TRANSITION.active ? String(smooth01(WORLD_TRANSITION.progress)) : "0",
      );
    };
    const tick = (): void => {
      if (!WORLD_TRANSITION.active) {
        raf = 0;
        paint();
        return;
      }
      paint();
      raf = requestAnimationFrame(tick);
    };
    const sync = (): void => {
      const wt = WORLD_TRANSITION;
      if (wt.active) {
        setMove((m) =>
          m && m.from === wt.from && m.to === wt.to ? m : { from: wt.from, to: wt.to },
        );
        if (!raf) raf = requestAnimationFrame(tick);
      } else {
        if (raf) {
          cancelAnimationFrame(raf);
          raf = 0;
        }
        setMove((m) => (m === null ? m : null));
        paint();
      }
    };
    const id = setInterval(sync, MOVE_SYNC_MS);
    return () => {
      clearInterval(id);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  // The word at 700: the settled rung, or — mid-move — the word the reader
  // is leaving. The destination lights only when the move settles (the
  // shell flips `world` then), which is exactly the lab's beat stills.
  const current = move ? move.from : world;
  /** The rule grows from the old word's side: 现场 is left, 原稿 is right. */
  const fromLeft = (move ? move.from : world) === "game";

  return (
    // z-50, the same layer as the header: this is chrome, and it must
    // clear anything the worlds paint beneath it.
    //
    // WHERE IT SITS, per breakpoint:
    //
    //   phone   the SECOND line, right-aligned under the header's own — the
    //           header holds the brand and the right pair on its first, and
    //           this bar takes the line beneath both. `top-13` is 52 px:
    //           the header's own `p-2` + `h-9` + `gap-2`, so this bar drops
    //           exactly onto the line the header left for it
    //   md+     the middle of three, all on one line
    <div
      data-board-bar
      className="pointer-events-none fixed top-13 right-2 z-50 flex max-w-[calc(100vw-1rem)] md:top-4 md:right-auto md:left-1/2 md:-translate-x-1/2"
    >
      <div
        role="group"
        aria-label={t("label")}
        className="chrome-bar chrome-rungs pointer-events-auto px-2 pt-1.5 pb-1"
      >
        {RUNGS.map((key, i) => {
          const label = key === "game" ? t("scene") : t("manuscript");
          return (
            <span key={key} className="inline-flex items-baseline">
              {i > 0 && (
                <span className="chrome-rung-sep" aria-hidden="true">
                  ·
                </span>
              )}
              <button
                type="button"
                aria-pressed={key === world}
                aria-label={label}
                title={label}
                onClick={() => onSelect(key)}
                className={`chrome-rung ${key === current ? "is-current" : ""}`}
              >
                {label}
              </button>
            </span>
          );
        })}
        {move && (
          <span
            ref={lineRef}
            aria-hidden="true"
            className={`chrome-rung-line ${fromLeft ? "" : "chrome-rung-line--from-right"}`}
          >
            <i />
          </span>
        )}
      </div>
    </div>
  );
}
