"use client";

import { useLayoutEffect, useRef } from "react";
import dynamic from "next/dynamic";
import { useSearchParams } from "next/navigation";
import { usePathname } from "@/i18n/navigation";
import type { UserConfig } from "@/lib/config/types";
import { useShell } from "@/components/shell/shell-provider";
import {
  originPanelModeFromHistory,
  panelModeForSurface,
  workspaceSurface,
} from "@/lib/workspace/navigation";

const ConversationOverlay = dynamic(
  () => import("./conversation-overlay").then((module) => module.ConversationOverlay),
  { ssr: false, loading: () => null },
);

export function ConversationOverlayMount({
  initialConfig,
}: {
  initialConfig?: UserConfig;
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const surface = workspaceSurface(pathname, searchParams.toString());
  const { setPanelMode } = useShell();
  const gated = pathname === "/" || pathname.startsWith("/playground");
  const previousPathRef = useRef<string | null>(null);

  useLayoutEffect(() => {
    const routeChanged = previousPathRef.current !== pathname;
    previousPathRef.current = pathname;
    if (gated || !routeChanged) return;
    const originMode = originPanelModeFromHistory(window.history.state);
    setPanelMode(originMode ?? panelModeForSurface(surface));
  }, [gated, pathname, setPanelMode, surface]);

  if (gated) return null;
  return <ConversationOverlay initialConfig={initialConfig} />;
}
