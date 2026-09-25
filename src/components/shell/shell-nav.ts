"use client";

/**
 * The shell's navigation actions — the IN-Memory form of the query-string
 * contract the single-route shell used to have. Since v0.13 §3.1 the CURSOR
 * half (the shared slice address) and these actions are owned by the
 * layout-level `ShellProvider` (shell-provider.tsx), because the conversation
 * layer — the cursor's other reader — lives at the layout now; the
 * WORLD-MOTION halves are registered by AppShell as a `WorldDriver`. Nothing
 * here touches the URL.
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

/** The shell's navigation actions — throws outside the layout-level
 *  ShellProvider (a bug: only shell descendants may navigate). */
export function useShellNav(): ShellNav {
  const nav = useContext(ShellNavContext);
  if (!nav) throw new Error("useShellNav outside ShellProvider");
  return nav;
}
