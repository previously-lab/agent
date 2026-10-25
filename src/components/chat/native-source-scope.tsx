"use client";

import { createContext, useContext, type ReactNode } from "react";

const NativeSourceScopeContext = createContext("unscoped");

export function NativeSourceScopeProvider({
  value,
  children,
}: {
  value: string;
  children: ReactNode;
}): React.JSX.Element {
  return <NativeSourceScopeContext.Provider value={value}>{children}</NativeSourceScopeContext.Provider>;
}

export function useNativeSourceScope(): string {
  return useContext(NativeSourceScopeContext);
}

const NativePersonaContext = createContext<string | null>(null);

export function NativePersonaProvider({
  value,
  children,
}: {
  value: string;
  children: ReactNode;
}): React.JSX.Element {
  return <NativePersonaContext.Provider value={value}>{children}</NativePersonaContext.Provider>;
}

export function useNativePersona(): string | null {
  return useContext(NativePersonaContext);
}
