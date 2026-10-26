"use client";

import { useMemo, type ReactNode } from "react";
import {
  DocumentNavigationProvider,
  type DocumentNavigationValue,
} from "@/components/documents/document-navigation";
import { useShell } from "@/components/shell/shell-provider";

export function DocumentNavigationAdapter({ children }: { children: ReactNode }) {
  const { openDesk } = useShell();
  const value = useMemo<DocumentNavigationValue>(() => ({
    onOpen: (ref, location = {}) => openDesk(ref, "manual", location),
  }), [openDesk]);
  return <DocumentNavigationProvider value={value}>{children}</DocumentNavigationProvider>;
}
