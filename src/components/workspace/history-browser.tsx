"use client";

import { useEffect, useMemo, useState, type SetStateAction } from "react";
import { useLocale, useTranslations } from "next-intl";
import { ArrowLeft, ArrowRight, ChevronLeft, ChevronRight, Folder } from "lucide-react";
import { getWorkspaceHistoryPage } from "@/lib/workspace/history-actions";
import { dateTimeFormat } from "@/lib/time/formatter-cache";
import { useShell } from "@/components/shell/shell-provider";
import {
  historyRequestKey,
  initialHistoryRequest,
  newestHistoryRequest,
  olderHistoryRequest,
  type HistoryPageRequest,
  type WorkspaceHistoryPage,
} from "@/lib/workspace/history-page";

export function HistoryBrowser({ persona, onChoose }: { persona?: string; onChoose?: () => void }) {
  const t = useTranslations("workspace.history");
  const locale = useLocale();
  const { openDesk } = useShell();
  const [request, setRequest] = useState<HistoryPageRequest>(initialHistoryRequest);
  const [page, setPage] = useState<WorkspaceHistoryPage | null>(null);
  const [status, setStatus] = useState<"loading" | "error" | "success">("loading");
  const [month, setMonth] = useState<string | null>(null);
  const requestKey = historyRequestKey(request);

  useEffect(() => {
    let live = true;
    setStatus("loading");
    setPage(null);
    getWorkspaceHistoryPage(request.beforeId, 20, persona)
      .then((result) => {
        if (!live) return;
        setPage(result);
        setStatus("success");
      })
      .catch(() => {
        if (live) setStatus("error");
      });
    return () => { live = false; };
  }, [request.beforeId, requestKey, persona]);

  const entries = useMemo(
    () => [...(page?.entries ?? [])].reverse(),
    [page],
  );
  const older = olderHistoryRequest(request, page);
  const dateFormat = useMemo(
    () => dateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }),
    [locale],
  );
  const monthFormat = useMemo(() => dateTimeFormat(locale, { year: "numeric", month: "long" }), [locale]);
  const months = useMemo(() => [...new Set(entries.map((entry) => monthFormat.format(new Date(entry.start))))], [entries, monthFormat]);
  const visible = onChoose ? entries.filter((entry) => month === monthFormat.format(new Date(entry.start))) : entries;

  function changePage(next: SetStateAction<HistoryPageRequest>) {
    setMonth(null);
    setRequest(next);
  }

  return (
    <section className="workspace-history-browser" data-compact={onChoose ? "" : undefined}
      aria-label={onChoose ? t("title") : undefined} aria-labelledby={onChoose ? undefined : "workspace-history-title"} aria-busy={status === "loading"}>
      <div className="workspace-browser-heading">
        {!onChoose && <div>
          <h2 id="workspace-history-title">{t("title")}</h2>
          <p>{t("description")}</p>
        </div>}
        {onChoose && month && <button type="button" className="manuscript-month-back" onClick={() => setMonth(null)}><ChevronLeft aria-hidden />{month}</button>}
        <div className="workspace-history-pages">
          {request.beforeId !== null && (
            <button type="button" onClick={() => changePage(newestHistoryRequest)}>
              <ArrowLeft aria-hidden className="size-3.5" />
              {t("newest")}
            </button>
          )}
          {older && (
            <button type="button" onClick={() => changePage(older)}>
              {t("older")}
              <ArrowRight aria-hidden className="size-3.5" />
            </button>
          )}
        </div>
      </div>

      {status === "loading" && <p role="status" className="workspace-browser-status">{t("loading")}</p>}
      {status === "error" && (
        <div role="alert" className="workspace-browser-status">
          <p>{t("error")}</p>
          <button type="button" onClick={() => setRequest((current) => ({ ...current, generation: current.generation + 1 }))}>
            {t("retry")}
          </button>
        </div>
      )}
      {status === "success" && entries.length === 0 && (
        <div className="workspace-browser-status">
          <p>{t("empty")}</p>
          {request.beforeId !== null && (
            <button type="button" onClick={() => setRequest(newestHistoryRequest)}>{t("newest")}</button>
          )}
        </div>
      )}
      {status === "success" && onChoose && !month && months.length > 0 && (
        <div className="manuscript-path-list">
          {months.map((label) => <button key={label} type="button" onClick={() => setMonth(label)}><Folder aria-hidden />{label}<ChevronRight aria-hidden /></button>)}
        </div>
      )}
      {status === "success" && visible.length > 0 && (
        <ol className="workspace-record-list">
          {visible.map((entry) => (
            <li key={entry.id}>
              <button type="button" onClick={() => { openDesk(`records/${entry.id}`, "manual"); onChoose?.(); }}>
                <span className="workspace-record-date">
                  {dateFormat.format(new Date(entry.start))}
                </span>
                <span className="workspace-record-focus">{entry.focus || entry.summary || entry.id}</span>
                {!onChoose && <span className="workspace-record-id">{entry.id}</span>}
              </button>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
