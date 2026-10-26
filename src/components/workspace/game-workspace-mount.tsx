"use client";

import { useEffect, useReducer } from "react";
import dynamic from "next/dynamic";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { usePathname } from "@/i18n/navigation";
import { useNativeSourceScope } from "@/components/chat/native-source-scope";
import { DebugErrorBoundary } from "@/components/ui/error-boundary";
import {
  gameHostPresentation,
  initialGameHostState,
  reduceGameHostState,
} from "@/lib/workspace/game-host";

function GameRouteLoading() {
  const t = useTranslations("game");
  return (
    <div className="fixed inset-0 flex items-center justify-center bg-background">
      <p role="status" className="text-sm text-muted-foreground">{t("loading")}</p>
    </div>
  );
}

const GameRouteShell = dynamic(
  () => import("@/components/shell/game-route-shell").then((module) => module.GameRouteShell),
  { ssr: false, loading: () => <GameRouteLoading /> },
);

export function GameWorkspaceMount() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const sourceScope = useNativeSourceScope();
  const lane = JSON.stringify([sourceScope, searchParams.get("persona") ?? "user"]);
  const [state, dispatch] = useReducer(
    reduceGameHostState,
    { pathname, lane },
    ({ pathname: initialPath, lane: initialLane }) => initialGameHostState(initialPath, initialLane),
  );
  useEffect(() => {
    dispatch({ type: "route", pathname, lane });
  }, [pathname, lane]);
  const presentation = gameHostPresentation(state, pathname);
  if (!presentation.mount) return null;

  return (
    <div
      data-workspace-game-host
      data-game-active={presentation.active || undefined}
      className="workspace-game-host fixed inset-0"
      hidden={presentation.hidden}
      inert={presentation.inert}
      aria-hidden={presentation.hidden}
    >
      <DebugErrorBoundary label="game-route">
        <GameRouteShell key={state.epoch} active={presentation.active} />
      </DebugErrorBoundary>
    </div>
  );
}
