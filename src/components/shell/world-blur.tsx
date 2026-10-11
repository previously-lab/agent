"use client";

/**
 * The document pause's blur layer (v0.28 step 1 — the Control model). While
 * the document tier sits over the hotel, this DOM veil rises between the
 * world canvas (z-0) and the pane's document DOM (z-10): a real
 * `backdrop-blur` over the canvas's pixels — the world is still THERE,
 * frozen and defocused, exactly the "paused underneath" read — plus a faint
 * page-coloured tint so the paper's contact shadow keeps something to sit
 * against in both themes.
 *
 * WHY DOM AND NOT GL. Compositing DOM over the canvas is free (z-index);
 * blurring INSIDE the GL would need another render-target pass on a world
 * this step deliberately does not draw. The veil is pointer-transparent:
 * the pane above it already is (the paper re-enables events on its own
 * layer), and the frozen world's input is gated in the game loop, so there
 * is nothing here to hit.
 *
 * The fade is opacity-only (`data-active`), timed to the pause move's beat
 * (WORLD_TRANSITION_PAUSE_MS); reduced motion skips the transition.
 */
import type { ReactNode } from "react";

export function WorldBlur({ active }: { active: boolean }): ReactNode {
  return (
    <div
      aria-hidden
      data-world-blur
      data-active={active || undefined}
      className="pointer-events-none absolute inset-0 opacity-0 backdrop-blur-xl bg-background/25 transition-opacity duration-300 motion-reduce:transition-none data-[active]:opacity-100"
    />
  );
}
