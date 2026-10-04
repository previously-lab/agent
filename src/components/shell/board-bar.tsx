"use client";

/**
 * BoardBar — the middle of the app's three floating islands, and the one that
 * belongs to the FIELD rather than to the app around it.
 *
 *   LEFT    logo + status        (`app-header.tsx`, `layout/app-header.tsx`)
 *   MIDDLE  the board bar        this file
 *   RIGHT   settings             (`app-header.tsx`)
 *
 * It carries the zoom lens (对话 · 片 · 日 · 周), which is the ladder itself.
 * It used to also carry the strand selector — retired with the strand layer
 * (§A.2.4): there is no strand list to offer any more.
 *
 * It is mounted by the SHELL, not by the card field, because it must exist at
 * every rung — inside the field it would vanish on the conversation rung, which
 * is precisely where a reader needs it to get back to the cards.
 */
import type { FieldRung } from "@/lib/timeline3d/units";
import { LensSwitcher } from "@/components/timeline-3d/lens-switcher";
import { ISLAND_BAR } from "@/components/layout/island";

export interface BoardBarProps {
  rung: FieldRung;
  onRungChange: (rung: FieldRung) => void;
  reducedMotion: boolean;
}

export function BoardBar({
  rung,
  onRungChange,
  reducedMotion,
}: BoardBarProps) {
  return (
    // z-50, the same layer as the header islands: this is chrome, and the card
    // faces pin their own portals at z-index 21-30 (see `row-group`'s
    // `zIndexRange`), so the bar must clear every card as they scroll past it.
    //
    // WHERE IT SITS, per breakpoint, and it is the READER's arrangement:
    //
    //   phone   the SECOND line, right-aligned under the header's own — the
    //           header holds the brand and the settings on its first, and this
    //           bar takes the line beneath both. It used to share the first
    //           line with the brand, which stopped fitting when the brand
    //           became an intertitle (~197 px against the wordmark's 84, beside
    //           a 244 px bar on a 390 px line). `top-13` is 52 px: the header's
    //           own `p-2` + `h-9` + `gap-2`, so this bar drops exactly onto
    //           the line the header left for it
    //   sm+     the middle of three, all on one line
    <div
      data-board-bar
      className="pointer-events-none fixed top-13 right-2 z-50 flex max-w-[calc(100vw-1rem)] sm:top-3 sm:right-auto sm:left-1/2 sm:-translate-x-1/2 md:top-4"
    >
      <div className={`${ISLAND_BAR} pointer-events-auto gap-1 p-1`}>
        <LensSwitcher rung={rung} onSelect={onRungChange} reducedMotion={reducedMotion} />
      </div>
    </div>
  );
}
