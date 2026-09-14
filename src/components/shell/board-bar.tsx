"use client";

/**
 * BoardBar — the middle of the app's three floating islands, and the one that
 * belongs to the FIELD rather than to the app around it.
 *
 *   LEFT    logo + status        (`app-header.tsx`, `layout/app-header.tsx`)
 *   MIDDLE  the board bar        this file
 *   RIGHT   settings             (`app-header.tsx`)
 *
 * It carries the two controls that change what the field is SHOWING:
 *
 *   - the zoom lens (对话 · 片 · 日 · 周), which is the ladder itself, and
 *   - the strand selector, which is what subset of it is drawn.
 *
 * THE STRAND SELECTOR USED TO LIVE ON THE TIME RAIL, and that was a mistake
 * worth naming: the rail is a 24-32 px strip whose whole job is to say WHERE
 * IN TIME the reader is, and it was also carrying a popover trigger, a
 * selection caption and a crossing dot. A control that opens a 256 px list
 * cannot live in a 32 px column — it hung its own label over the content — and
 * every one of those things was competing with the scale it sat on. The rail
 * says where time is. This bar is where you act on it, exactly as the right
 * edge is where the jump controls act on it.
 *
 * It is mounted by the SHELL, not by the card field, because it must exist at
 * every rung — inside the field it would vanish on the conversation rung, which
 * is precisely where a reader needs it to get back to the cards.
 */
import type { StrandListItem } from "@/lib/episodic/actions";
import type { FieldRung } from "@/lib/timeline3d/units";
import { LensSwitcher } from "@/components/timeline-3d/lens-switcher";
import { StrandFilter } from "@/components/timeline-3d/strand-filter";
import { ISLAND } from "@/components/layout/island";

export interface BoardBarProps {
  rung: FieldRung;
  onRungChange: (rung: FieldRung) => void;
  reducedMotion: boolean;
  /** The current strand picks, in order. Empty = 核心时间线. */
  strands: readonly string[];
  strandList: StrandListItem[];
  onToggleStrand: (strand: string) => void;
  onClearStrands: () => void;
}

export function BoardBar({
  rung,
  onRungChange,
  reducedMotion,
  strands,
  strandList,
  onToggleStrand,
  onClearStrands,
}: BoardBarProps) {
  return (
    // z-50, the same layer as the header islands: this is chrome, and the card
    // faces pin their own portals at z-index 21-30 (see `row-group`'s
    // `zIndexRange`), so the bar must clear every card as they scroll past it.
    //
    // `top-14` under `sm` and `top-3`/`top-4` above it: at phone width the
    // header's two islands cannot share a row with this one (three islands and
    // four lens segments do not fit in 390 px), so the bar drops to a second
    // line and the header's own islands keep the first. From `sm` up there is
    // room for all three on one line, and the bar joins them.
    <div
      data-board-bar
      // Four segments at the phone's `min-h-8` plus a 28 px strand trigger, so
      // a strand pick shortens the LENS's labels rather than pushing the bar
      // off the glass — the ladder is the thing that must stay reachable.
      className="pointer-events-none fixed top-14 left-1/2 z-50 flex max-w-[calc(100vw-1rem)] -translate-x-1/2 sm:top-3 md:top-4"
    >
      <div className={`${ISLAND} pointer-events-auto flex items-center gap-1 p-0.5`}>
        <LensSwitcher rung={rung} onSelect={onRungChange} reducedMotion={reducedMotion} />
        <span aria-hidden className="h-4 w-px shrink-0 bg-border" />
        <StrandFilter
          strands={strandList}
          selected={strands}
          onToggle={onToggleStrand}
          onClear={onClearStrands}
        />
      </div>
    </div>
  );
}
