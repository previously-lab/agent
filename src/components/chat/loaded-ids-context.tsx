"use client";

import { createContext, useContext, useRef, useCallback } from "react";

type LoadedIdsContextValue = {
  /** Push slice IDs into the shared set (idempotent — deduped internally). */
  register: (ids: string[]) => void;
  /** Snapshot of all registered IDs for the current request body. */
  snapshot: () => string[];
};

const Ctx = createContext<LoadedIdsContextValue | null>(null);

/** Returns the context value, or a no-op fallback when used outside the provider. */
export function useLoadedIds(): LoadedIdsContextValue {
  const ctx = useContext(Ctx);
  if (ctx) return ctx;
  // No-op fallback: TimelinePanel rendered without ChatPage (e.g. dev isolation)
  const noop = (() => {}) as unknown as () => void;
  return { register: noop, snapshot: () => [] };
}

export function LoadedIdsProvider({ children }: { children: React.ReactNode }) {
  const ref = useRef<Set<string>>(new Set());

  const register = useCallback((ids: string[]) => {
    for (const id of ids) ref.current.add(id);
  }, []);

  const snapshot = useCallback(() => [...ref.current], []);

  return <Ctx.Provider value={{ register, snapshot }}>{children}</Ctx.Provider>;
}
