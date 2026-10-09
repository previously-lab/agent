"use client";

/**
 * The shell's navigation action — the IN-MEMORY form of the query-string
 * contract the single-route shell used to have. Since v0.13 §3.1 the CURSOR
 * half (the shared slice address) and this action are owned by the
 * layout-level `ShellProvider` (shell-provider.tsx), because the conversation
 * layer — the cursor's other reader — lives at the layout now; the
 * WORLD-MOTION half is registered by AppShell as a `WorldDriver`. Nothing
 * here touches the URL.
 *
 *   standAtSlice(id) — address a slice to the HOTEL: the reader stands at
 *                      the slice's door (game-canvas.tsx's `focusSlice`).
 *                      The world gate's one addressed move.
 *
 * There used to be three actions; the other two (the card field's focus and
 * the conversation jump's world half) retired with the conversation rung —
 * a slice jump now rises the floating panel and lands in its stream
 * (lib/chat/slice-jump.ts), and the card field no longer renders.
 */
import { createContext, useContext } from "react";

export interface ShellNav {
  standAtSlice: (sliceId: string) => void;
}

export const ShellNavContext = createContext<ShellNav | null>(null);

/** The shell's navigation action — throws outside the layout-level
 *  ShellProvider (a bug: only shell descendants may navigate). */
export function useShellNav(): ShellNav {
  const nav = useContext(ShellNavContext);
  if (!nav) throw new Error("useShellNav outside ShellProvider");
  return nav;
}
