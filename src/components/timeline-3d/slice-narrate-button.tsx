"use client";

/**
 * SliceNarrateButton — the 「讲讲这片」 corner action on a slice card face.
 *
 * It renders as a SIBLING of the card's role="button" face (a child would be
 * a nested interactive element, and the card's Enter/Space handler would
 * swallow its keystrokes), absolutely positioned inside the face's own rect,
 * so hovering it never fires the card's pointer-leave. It scales with the
 * card: `em` is the face's root em (`cardEmFor`), the same unit every row
 * inside the card resolves against.
 *
 * Visibility: hidden until the card is hovered or focused (keyboard), always
 * faintly present on coarse pointers (no hover there). The whole card owns
 * the click-to-drill gesture; this corner never competes with it.
 */
import { AudioLines } from "lucide-react";

export interface SliceNarration {
  /** Localized aria/title label (「让 Previously 讲讲这片」). */
  label: string;
  onSelect: (sliceId: string, timeLabel?: string) => void;
}

export function SliceNarrateButton({
  label,
  em,
  onSelect,
}: {
  label: string;
  /** The face's root em (px) — the button scales with the card. */
  em: number;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={(e) => {
        // The drill gesture never sees the click even if this button is ever
        // moved inside the card wrapper.
        e.stopPropagation();
        onSelect();
      }}
      className="absolute right-[0.9em] top-[0.7em] z-10 flex size-[1.9em] items-center justify-center rounded-full text-muted-foreground/80 opacity-0 ring-1 ring-foreground/10 transition-[opacity,background-color,color] duration-200 hover:bg-muted/60 hover:text-foreground focus-visible:opacity-100 motion-reduce:transition-none group-hover/card:opacity-100 pointer-coarse:opacity-70"
      style={{ fontSize: em, backgroundColor: "color-mix(in oklch, var(--card) 72%, transparent)" }}
    >
      <AudioLines className="size-[1em]" />
    </button>
  );
}
