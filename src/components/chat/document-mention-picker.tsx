"use client";

import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { useTranslations } from "next-intl";
import { AtSign, FileText, LoaderCircle, X } from "lucide-react";
import { searchDocumentCatalog, type DocumentCatalogItem } from "@/lib/chat/document-catalog-actions";
import {
  createDocumentCatalogController,
  type DocumentCatalogView,
} from "@/lib/chat/document-catalog-controller";
import type { DocumentContextSnapshot } from "@/lib/chat/document-context";

export type DocumentCatalogState = DocumentCatalogView & {
  setActiveIndex: (index: number) => void;
  loadMore: () => void;
  retry: () => void;
};

export function useDocumentMentionCatalog(
  open: boolean,
  query: string,
  persona: string,
): DocumentCatalogState {
  const controllerRef = useRef<ReturnType<typeof createDocumentCatalogController> | null>(null);
  if (!controllerRef.current) controllerRef.current = createDocumentCatalogController(searchDocumentCatalog);
  const controller = controllerRef.current;
  useEffect(() => {
    controller.setSearch(open, query, persona);
  }, [controller, open, query, persona]);
  useEffect(() => () => controller.dispose(), [controller]);
  const subscribe = useCallback((listener: () => void) => controller.subscribe(listener), [controller]);
  const getSnapshot = useCallback(() => controller.getSnapshot(open, query, persona), [controller, open, query, persona]);
  const view = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const setActiveIndex = useCallback((index: number) => controller.setActiveIndex(index), [controller]);
  const loadMore = useCallback(() => controller.loadMore(open, query, persona), [controller, open, query, persona]);
  const retry = useCallback(() => controller.retry(open, query, persona), [controller, open, query, persona]);
  return { ...view, setActiveIndex, loadMore, retry };
}

export function DocumentReferenceChips({
  references,
  onRemove,
  floating = false,
}: {
  references: DocumentContextSnapshot;
  onRemove: (ref: string) => void;
  floating?: boolean;
}): React.JSX.Element | null {
  const t = useTranslations("chat.input.references");
  if (references.length === 0) return null;
  return (
    <ul
      aria-label={t("selected")}
      className={`document-reference-chips${floating ? " document-reference-chips--floating" : ""}`}
    >
      {references.map((reference) => {
        const title = reference.title ?? reference.ref.split("/").at(-1) ?? reference.ref;
        return (
          <li key={`${reference.ref}:${reference.edition ?? ""}:${reference.turnId ?? ""}:${reference.role ?? ""}`} className="document-reference-chip">
            <AtSign aria-hidden className="size-3 shrink-0 text-primary" />
            <span title={reference.quote ? t("excerpt", { title }) : title}>{title}</span>
            {reference.quote && <span className="shrink-0 text-muted-foreground">{t("excerptBadge")}</span>}
            <button type="button" onClick={() => onRemove(reference.ref)} aria-label={t("remove", { title })}>
              <X aria-hidden className="size-3" />
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export function DocumentMentionPicker({
  id,
  query,
  catalog,
  manual,
  floating,
  onQueryChange,
  onSelect,
  onClose,
  onKeyDown,
}: {
  id: string;
  query: string;
  catalog: DocumentCatalogState;
  manual: boolean;
  floating: boolean;
  onQueryChange: (query: string) => void;
  onSelect: (item: DocumentCatalogItem) => void;
  onClose: () => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => void;
}): React.JSX.Element {
  const t = useTranslations("chat.input.references");
  const { items, status, activeIndex, setActiveIndex } = catalog;
  return (
    <section
      aria-label={t("title")}
      className={`document-mention-panel${floating ? " document-mention-panel--floating" : ""}`}
    >
      <div className="flex items-end gap-2 border-b border-border px-3 py-2">
        <div className="min-w-0 flex-1">
          <label htmlFor={`${id}-search`} className="sr-only">{t("searchLabel")}</label>
          <input
            id={`${id}-search`}
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            onKeyDown={onKeyDown}
            role="combobox"
            aria-autocomplete="list"
            aria-expanded="true"
            aria-controls={`${id}-listbox`}
            aria-activedescendant={activeIndex >= 0 && items[activeIndex] ? `${id}-option-${activeIndex}` : undefined}
            autoFocus={manual}
            maxLength={120}
            placeholder={t("searchPlaceholder")}
            className="w-full bg-transparent py-1 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>
        <button type="button" onClick={onClose} aria-label={t("close")} className="document-mention-icon-button">
          <X aria-hidden className="size-4" />
        </button>
      </div>
      <div className="px-3 py-1.5 text-xs text-muted-foreground">{t("hint")}</div>
      {status === "loading" && items.length === 0 ? (
        <div className="flex items-center gap-2 px-3 py-4 text-sm text-muted-foreground" role="status">
          <LoaderCircle aria-hidden className="size-4 animate-spin motion-reduce:animate-none" />
          {t("loading")}
        </div>
      ) : status === "error" && items.length === 0 ? (
        <div className="flex items-center justify-between gap-3 px-3 py-4 text-sm">
          <span role="alert">{t("error")}</span>
          <button type="button" onClick={catalog.retry} className="shrink-0 rounded-md px-2 py-1 text-primary hover:bg-accent">{t("retry")}</button>
        </div>
      ) : status === "success" && items.length === 0 ? (
        <p className="px-3 py-4 text-sm text-muted-foreground">{t("empty")}</p>
      ) : items.length > 0 ? (
        <>
          <ul id={`${id}-listbox`} role="listbox" aria-label={t("results")} className="document-mention-options">
            {items.map((item, index) => (
              <li
                id={`${id}-option-${index}`}
                key={item.ref}
                role="option"
                aria-selected={activeIndex === index}
                className="document-mention-option"
                onPointerMove={() => setActiveIndex(index)}
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => onSelect(item)}
              >
                <FileText aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{item.title}</span>
                  <span className="block truncate text-xs text-muted-foreground">{t(`kind.${item.kind}`)}</span>
                </span>
              </li>
            ))}
          </ul>
          {status === "error" && (
            <div className="flex items-center justify-between gap-2 border-t border-border px-3 py-2 text-xs" role="alert">
              <span>{t("error")}</span>
              <button type="button" onClick={catalog.retry} className="rounded-md px-2 py-1 text-primary">{t("retry")}</button>
            </div>
          )}
          {catalog.nextCursor && (
            <button
              type="button"
              onClick={catalog.loadMore}
              disabled={catalog.loadingMore}
              className="min-h-9 w-full border-t border-border px-3 py-2 text-sm text-primary hover:bg-accent disabled:opacity-50"
            >
              {catalog.loadingMore ? t("loadingMore") : t("loadMore")}
            </button>
          )}
        </>
      ) : null}
    </section>
  );
}
