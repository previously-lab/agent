"use client";

/**
 * BoardBar — the middle of the app's three floating islands, and the one that
 * belongs to the WORLD rather than to the app around it.
 *
 *   LEFT    logo + status        (`app-header.tsx`, `layout/app-header.tsx`)
 *   MIDDLE  the board bar        this file
 *   RIGHT   settings             (`app-header.tsx`)
 *
 * It carries the TWO RUNGS — 现场 · 原稿 (Scene · Manuscript), the world's two
 * faces. The zoom ladder it replaced (对话 · 片 · 日 · 周) retired with the
 * conversation rung: the world is the hotel or the documents, and selecting a
 * segment asks the shell's transition machine for that world — a move, never
 * a snap.
 *
 * BOTH segments say their name. The old control lit only the word of the rung
 * you were on, because four lit words was a wide control; two fit as they are.
 *
 * It is mounted by the SHELL, not by either world, because it must exist at
 * either rung. In the hotel the world's own Exit is the way back — the game
 * keeps its viewport clear of product chrome.
 */
import { Hotel, FileText } from "lucide-react";
import { useTranslations } from "next-intl";
import type { WorldKind } from "@/components/timeline-3d/world-contract";
import { ISLAND_BAR } from "@/components/layout/island";

export interface BoardBarProps {
  /** The rung to light — the settled world, or the destination mid-move. */
  world: WorldKind;
  onSelect: (world: WorldKind) => void;
}

/** The two rungs in the bar's left-to-right order. */
const RUNGS: { key: WorldKind; Icon: typeof Hotel }[] = [
  { key: "game", Icon: Hotel },
  { key: "field", Icon: FileText },
];

export function BoardBar({ world, onSelect }: BoardBarProps) {
  const t = useTranslations("rungs");
  return (
    // z-50, the same layer as the header islands: this is chrome, and it must
    // clear anything the worlds paint beneath it.
    //
    // WHERE IT SITS, per breakpoint:
    //
    //   phone   the SECOND line, right-aligned under the header's own — the
    //           header holds the brand and the settings on its first, and this
    //           bar takes the line beneath both. `top-13` is 52 px: the
    //           header's own `p-2` + `h-9` + `gap-2`, so this bar drops exactly
    //           onto the line the header left for it
    //   sm+     the middle of three, all on one line
    <div
      data-board-bar
      className="pointer-events-none fixed top-13 right-2 z-50 flex max-w-[calc(100vw-1rem)] sm:top-3 sm:right-auto sm:left-1/2 sm:-translate-x-1/2 md:top-4"
    >
      <div className={`${ISLAND_BAR} pointer-events-auto gap-1 p-1`}>
        <div
          role="group"
          aria-label={t("label")}
          className="flex items-center gap-0.5 text-xs"
        >
          {RUNGS.map(({ key, Icon }) => {
            const active = key === world;
            const label = key === "game" ? t("scene") : t("manuscript");
            return (
              <button
                key={key}
                type="button"
                aria-pressed={active}
                aria-label={label}
                title={label}
                onClick={() => onSelect(key)}
                // One height for both segments: a rung switch must not grow
                // the BAR, or the whole top row changes height with it.
                className={`flex h-7 items-center gap-1 rounded-full transition-colors ${
                  active
                    ? "bg-background px-2.5 text-foreground shadow-sm"
                    : "px-2 text-muted-foreground hover:text-foreground"
                }`}
              >
                <Icon className="h-3 w-3 shrink-0" />
                <span className="whitespace-nowrap">{label}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
