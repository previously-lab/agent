"use client";

import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { createNativeExecutionRegistry } from "./native-execution";

interface ReadingLayout {
  heights: ReadonlyMap<string, number>;
  measure: (key: string, height: number) => void;
  pageHeight?: number;
  printing: boolean;
}

const LayoutContext = createContext<ReadingLayout | null>(null);
const ActiveCopyContext = createContext({ active: true, priority: 1 });
const execution = createNativeExecutionRegistry();

export function useNativeExecutionLease(scope: string, enabled: boolean, priority: number, migrateFromScope?: string) {
  const id = useId();
  const subscribe = useCallback((listener: () => void) => execution.subscribe(scope, listener), [scope]);
  const owns = useCallback(() => enabled && (execution.owns(scope, id) || Boolean(
    migrateFromScope && !execution.hasOwner(scope) && execution.owns(migrateFromScope, id),
  )), [scope, id, enabled, migrateFromScope]);
  const active = useSyncExternalStore(subscribe, owns, () => false);
  useLayoutEffect(() => enabled ? execution.claim(scope, id, priority) : undefined, [scope, id, enabled, priority]);
  return { active, owns };
}

/** Each paper shell contains the same document. Share intrinsic figure sizes
 * so its static copies paginate exactly like the one executing reading copy. */
export function NativeReadingLayoutProvider({ identity, pageHeight, children }: {
  identity: string;
  pageHeight?: number;
  children: ReactNode;
}) {
  const [sizes, setSizes] = useState<{ identity: string; heights: ReadonlyMap<string, number> }>(() => ({ identity, heights: new Map() }));
  const [printing, setPrinting] = useState(false);
  const heights = useMemo(() => sizes.identity === identity ? sizes.heights : new Map<string, number>(), [sizes, identity]);
  const measure = useCallback((key: string, height: number) => {
    setSizes((previous) => {
      const current = previous.identity === identity ? previous.heights : new Map<string, number>();
      if (current.get(key) === height) return previous;
      return { identity, heights: new Map(current).set(key, height) };
    });
  }, [identity]);
  useEffect(() => {
    const before = () => setPrinting(true);
    const after = () => setPrinting(false);
    window.addEventListener("beforeprint", before);
    window.addEventListener("afterprint", after);
    return () => {
      window.removeEventListener("beforeprint", before);
      window.removeEventListener("afterprint", after);
    };
  }, []);
  const value = useMemo(() => ({ heights, measure, pageHeight, printing }), [heights, measure, pageHeight, printing]);
  return <LayoutContext.Provider value={value}>{children}</LayoutContext.Provider>;
}

export function NativeReadingCopyProvider({ active, priority = 2, children }: { active: boolean; priority?: number; children: ReactNode }) {
  const value = useMemo(() => ({ active, priority }), [active, priority]);
  return <ActiveCopyContext.Provider value={value}>{children}</ActiveCopyContext.Provider>;
}

export function useNativeReadingCopy() {
  const layout = useContext(LayoutContext);
  const copy = useContext(ActiveCopyContext);
  return { layout, active: copy.active && !layout?.printing, priority: copy.priority };
}
