"use client";

import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { DocLibrary } from "@/components/shelf/doc-library";
import { useShell } from "@/components/shell/shell-provider";
import { HistoryBrowser } from "@/components/workspace/history-browser";
import { WorkspaceRouteNav } from "@/components/workspace/workspace-route-nav";

export function WorkspaceBrowser({ persona }: { persona?: string }) {
  const t = useTranslations("workspace.browser");
  const searchParams = useSearchParams();
  const history = searchParams.get("history") === "1";
  const { openLibrary } = useShell();

  return (
    <main className="workspace-browser">
      <div className="workspace-browser-top">
        <WorkspaceRouteNav current="library" />
      </div>
      <div className="workspace-browser-inner">
        <header className="workspace-browser-title">
          <div>
            <p className="workspace-browser-eyebrow">{t("eyebrow")}</p>
            <h1>{t("title")}</h1>
          </div>
          <div aria-label={t("views")} className="workspace-browser-tabs">
            <button
              type="button"
              aria-pressed={!history}
              onClick={() => openLibrary(false)}
            >
              {t("documents")}
            </button>
            <button
              type="button"
              aria-pressed={history}
              onClick={() => openLibrary(true)}
            >
              {t("records")}
            </button>
          </div>
        </header>
        <div className="workspace-browser-panel">
          {history ? <HistoryBrowser persona={persona} /> : <DocLibrary persona={persona} />}
        </div>
      </div>
    </main>
  );
}
