"use client";

import { createContext, useEffect, useId, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Maximize2, Minus, Plus, X } from "lucide-react";
import { useTranslations } from "next-intl";
import "./rich-content-view.css";

const HISTORY_KEY = "previouslyRichView";
export const RichViewEnabled = createContext(false);

function useRichDialog() {
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onBack = () => { if (dialog.current?.open && history.state?.[HISTORY_KEY] !== id) dialog.current.close(); };
    window.addEventListener("popstate", onBack);
    return () => window.removeEventListener("popstate", onBack);
  }, [id, open]);

  function show() {
    const element = dialog.current;
    if (!element || element.open) return;
    element.showModal();
    setOpen(true);
    history.pushState({ ...history.state, [HISTORY_KEY]: id }, "");
  }
  function didClose() {
    setOpen(false);
    if (history.state?.[HISTORY_KEY] === id) history.back();
    trigger.current?.focus({ preventScroll: true });
  }
  return { id, dialog, trigger, open, show, didClose };
}

export function RichContentFrame({ kind, children }: { kind: "table" | "html"; children: ReactNode }) {
  const t = useTranslations("chat.richView");
  const view = useRichDialog();
  const [copied, setCopied] = useState(false);
  const rows = () => Array.from(view.dialog.current?.querySelectorAll("table tr") ?? [], row =>
    Array.from(row.querySelectorAll("th,td"), cell => (cell.textContent ?? "").trim()));

  async function copyTable() {
    try {
      await navigator.clipboard.writeText(rows().map(row => row.join("\t")).join("\n"));
      setCopied(true);
    } catch { setCopied(false); }
  }
  function downloadTable() {
    const csv = rows().map(row => row.map(cell => `"${cell.replaceAll('"', '""')}"`).join(",")).join("\r\n");
    const url = URL.createObjectURL(new Blob(["\ufeff", csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "table.csv";
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
  }

  return (
    <div className="rich-block-frame">
      <button type="button" ref={view.trigger} className="rich-view-action" onClick={() => { setCopied(false); view.show(); }}>
        <Maximize2 aria-hidden />{t(kind === "table" ? "openTable" : "openHtml")}
      </button>
      {/* Keep the artifact (especially the live iframe) in exactly the same DOM seat. */}
      <dialog ref={view.dialog} className="rich-view rich-view--inline" data-rich-view={kind}
        role={view.open ? undefined : "presentation"} aria-label={view.open ? t(kind) : undefined}
        onClose={view.didClose} onKeyDown={(event) => { if (event.key === "Escape") event.stopPropagation(); }}>
        <div className="rich-view-heading">
          <span>{t(kind)}</span>
          {kind === "table" && <div className="rich-view-tools">
            <button type="button" onClick={() => void copyTable()}>{copied ? t("copied") : t("copyTable")}</button>
            <button type="button" onClick={downloadTable}>{t("downloadCsv")}</button>
          </div>}
          <button className="rich-view-close" type="button" onClick={() => view.dialog.current?.close()} aria-label={t("close")} autoFocus><X aria-hidden /></button>
        </div>
        {children}
      </dialog>
    </div>
  );
}

export function RichConversationImage({ alt, ...props }: ComponentProps<"img">) {
  const t = useTranslations("chat.richView");
  const view = useRichDialog();
  const [zoom, setZoom] = useState(100);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return <>
    <button type="button" ref={view.trigger} className="rich-image-trigger" aria-label={alt ? t("openNamedImage", { name: alt }) : t("openImage")}
      onClick={() => { setZoom(100); view.show(); }}>
      <img {...props} alt={alt ?? ""} className="conversation-rich-image" data-rich-block="image" />
    </button>
    {mounted && createPortal(
      <dialog ref={view.dialog} className="rich-view" data-rich-view="image" aria-label={alt || t("image")}
        onClose={view.didClose} onKeyDown={(event) => { if (event.key === "Escape") event.stopPropagation(); }}>
        <div className="rich-view-heading">
          <span>{alt || t("image")}</span>
          <div className="rich-view-tools">
            <button type="button" aria-label={t("zoomOut")} disabled={zoom <= 100} onClick={() => setZoom(value => value - 25)}><Minus aria-hidden /></button>
            <button type="button" aria-label={t("fitImage")} onClick={() => setZoom(100)}>{zoom}%</button>
            <button type="button" aria-label={t("zoomIn")} disabled={zoom >= 225} onClick={() => setZoom(value => value + 25)}><Plus aria-hidden /></button>
          </div>
          <button type="button" className="rich-view-close" onClick={() => view.dialog.current?.close()} aria-label={t("close")} autoFocus><X aria-hidden /></button>
        </div>
        {view.open && <div className="rich-image-stage" tabIndex={0} aria-label={t("image")}>
          <img src={props.src} alt={alt ?? ""} style={{ width: `${zoom}%` }} />
        </div>}
      </dialog>, document.body,
    )}
  </>;
}
