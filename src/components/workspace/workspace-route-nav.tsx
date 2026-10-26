"use client";

import { useTranslations } from "next-intl";
import { useShell } from "@/components/shell/shell-provider";
import { useShellNav } from "@/components/shell/shell-nav";

export function WorkspaceRouteNav({
  current,
  relatedSlice = null,
}: {
  current: "conversation" | "library" | "reader" | "game";
  relatedSlice?: string | null;
}) {
  const t = useTranslations("workspace.nav");
  const { openConversation, openLibrary, openGame } = useShell();
  const nav = useShellNav();
  return (
    <nav aria-label={t("label")} className="workspace-route-nav">
      {current !== "conversation" && (
        <button type="button" onClick={openConversation}>{t("conversation")}</button>
      )}
      {current !== "library" && (
        <button type="button" onClick={() => openLibrary(false)}>{t("library")}</button>
      )}
      {current !== "game" && (
        <button type="button" onClick={openGame}>{t("game")}</button>
      )}
      {current === "reader" && relatedSlice && (
        <button type="button" onClick={() => nav.standAtSlice(relatedSlice)}>
          {t("relatedRoom")}
        </button>
      )}
    </nav>
  );
}
