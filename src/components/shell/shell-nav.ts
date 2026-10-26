"use client";

/**
 * Addressed room navigation shared by the app and reader. ShellProvider owns
 * the cursor and route change; the lazy game host receives focusSlice when
 * `/game` becomes visible. standAtSlice therefore works both with an already
 * mounted world and before the first game visit, without a second game host.
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
