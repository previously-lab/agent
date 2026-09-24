"use client";

/**
 * The shell's navigation actions — the IN-Memory form of the query-string
 * contract the single-route shell used to have. AppShell owns the state
 * (the world, the rung, the shared slice address) and provides these three
 * actions to anything below it; nothing here touches the URL.
 *
 *   focusSlice(id)   — address a slice to the CARD FIELD: the field focuses
 *                      and flashes the slice's card (landing on the slice
 *                      rung when no move is needed). The old `?slice=` in
 *                      the field world.
 *   standAtSlice(id) — address a slice to the HOTEL: the reader stands at
 *                      the slice's door (game-canvas.tsx's `focusSlice`).
 *                      The old `?slice=` in the game world.
 *   openSlice(id)    — the CONVERSATION jump: the stream pages to the slice
 *                      and scroll-lands on its seam (the M2 bus,
 *                      lib/chat/slice-jump.ts). The old `?at=`.
 */
import { createContext, useContext } from "react";

export interface ShellNav {
  focusSlice: (sliceId: string) => void;
  standAtSlice: (sliceId: string) => void;
  openSlice: (sliceId: string, start?: string) => void;
}

export const ShellNavContext = createContext<ShellNav | null>(null);

/** The shell's navigation actions — throws outside the shell (a bug:
 *  only shell descendants may navigate). */
export function useShellNav(): ShellNav {
  const nav = useContext(ShellNavContext);
  if (!nav) throw new Error("useShellNav outside AppShell");
  return nav;
}
