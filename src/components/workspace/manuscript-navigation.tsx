"use client";

import { useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ChevronDown, ChevronRight, FileText, Folder, History, MessageSquare } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ISLAND } from "@/components/layout/island";
import { DocLibrary } from "@/components/shelf/doc-library";
import { useShell } from "@/components/shell/shell-provider";
import { useShellNav } from "@/components/shell/shell-nav";
import { parseRecordRef } from "@/lib/archive/refs";
import { workspaceSurface } from "@/lib/workspace/navigation";
import { HistoryBrowser } from "./history-browser";

type FolderId = "documents" | "records";

export function ManuscriptNavigation() {
  const t = useTranslations("workspace.nav");
  const locale = useLocale();
  const search = useSearchParams();
  const surface = workspaceSurface("/app", search.toString());
  const persona = search.get("persona") ?? undefined;
  const relatedSlice = parseRecordRef(search.get("doc") ?? "")?.sliceId;
  const { openConversation, openLibrary, openGame } = useShell();
  const nav = useShellNav();
  const [open, setOpen] = useState(false);
  const [folder, setFolder] = useState<FolderId | null>(null);
  const breadcrumb = useRef<HTMLButtonElement>(null);
  const close = () => setOpen(false);

  function chooseFolder(value: FolderId | null) {
    setFolder(value);
    breadcrumb.current?.focus({ preventScroll: true });
  }

  return (
    <nav className="manuscript-nav" data-locale={locale} aria-label={t("label")}>
      <button type="button" className={`${ISLAND} manuscript-nav-conversation`} aria-current={surface === "conversation" ? "page" : undefined}
        onClick={openConversation}><MessageSquare aria-hidden /><span>{t("conversation")}</span></button>
      <Popover open={open} onOpenChange={(next) => { setOpen(next); if (next) setFolder(null); }}>
        <PopoverTrigger className={`${ISLAND} manuscript-nav-trigger`} aria-current={surface === "conversation" ? undefined : "page"}>
          <FileText className="manuscript-nav-file" aria-hidden />
          <span>{t("library")}</span><ChevronDown aria-hidden />
        </PopoverTrigger>
        <PopoverContent className="manuscript-path-menu" sideOffset={8} aria-label={t("library")}>
          <div className="manuscript-path-crumbs">
            <button ref={breadcrumb} type="button" aria-current={!folder ? "location" : undefined}
              onClick={() => chooseFolder(null)}>{t("library")}</button>
            {folder && <><span aria-hidden>/</span><span aria-current="location">{t(folder)}</span></>}
          </div>
          {folder === "documents" ? (
            <DocLibrary persona={persona} onChoose={close} />
          ) : folder === "records" ? (
            <HistoryBrowser persona={persona} onChoose={close} />
          ) : (
            <div className="manuscript-path-list">
              <button type="button" onClick={() => chooseFolder("records")}><History aria-hidden />{t("records")}<ChevronRight aria-hidden /></button>
              <button type="button" onClick={() => chooseFolder("documents")}><Folder aria-hidden />{t("documents")}<ChevronRight aria-hidden /></button>
              <button type="button" onClick={() => { close(); openLibrary(); }}>{t("allManuscripts")}</button>
              <button type="button" className="manuscript-menu-room" onClick={() => { close(); openGame(); }}>{t("game")}</button>
              {relatedSlice && <button type="button" onClick={() => { close(); nav.standAtSlice(relatedSlice); }}>{t("relatedRoom")}</button>}
            </div>
          )}
        </PopoverContent>
      </Popover>
    </nav>
  );
}
