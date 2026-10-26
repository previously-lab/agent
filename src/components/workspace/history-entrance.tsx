"use client";

import { History } from "lucide-react";
import { useTranslations } from "next-intl";
import { useShell } from "@/components/shell/shell-provider";

export function HistoryEntrance() {
  const t = useTranslations("workspace.history");
  const { openLibrary } = useShell();
  return (
    <div className="workspace-history-entrance">
      <button type="button" onClick={() => openLibrary(true)}>
        <History aria-hidden className="size-3.5" />
        <span>
          <span className="workspace-history-title">{t("entrance")}</span>
          <span className="workspace-history-hint">{t("entranceHint")}</span>
        </span>
      </button>
    </div>
  );
}
