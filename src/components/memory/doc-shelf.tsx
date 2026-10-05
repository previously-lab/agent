"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import {
  ArrowLeft,
  BookMarked,
  Building2,
  CalendarDays,
  FileText,
  Lightbulb,
  ListChecks,
  MapPin,
  Package,
  Sparkles,
  User,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { MarkdownRenderer } from "@/components/chat/markdown";
import { buildAttachmentDisplay } from "./attachment-display";
import {
  getCaseDetail,
  getCaseDoc,
  getCaseShelf,
  type CaseDetail,
  type CaseDocContent,
  type CaseShelf,
} from "@/lib/episodic/actions";
import type { CaseCategory } from "@/lib/docs";

const CATEGORY_ICONS: Record<CaseCategory, typeof FileText> = {
  people: User,
  events: CalendarDays,
  things: Package,
  places: MapPin,
  orgs: Building2,
  research: BookMarked,
  hypotheses: Lightbulb,
  tasks: ListChecks,
  self: Sparkles,
};

type ShelfView =
  | { type: "root" }
  | { type: "category"; category: CaseCategory }
  | { type: "case"; category: CaseCategory; name: string }
  | { type: "caseDoc"; ref: string };

/**
 * The memory shelf: one dialog over the case tree. The root lists the nine
 * categories — a category lists its cases, a case opens its `index.md` plus
 * its piece list, and any piece (or case reference) opens through
 * `getCaseDoc` with dual-root tolerance (§D.1). Everything loads lazily in
 * event handlers (one server-action round trip per open / per level),
 * exactly like the MemoryDocs popover it extends. Header dates are
 * displayed verbatim — no staleness or status is computed or rendered
 * (closure is time-window derived, not a label).
 */
export function DocShelfDialog({
  open,
  onOpenChange,
  persona,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  persona?: string;
}) {
  const t = useTranslations("chat.input.shelf");
  const [view, setView] = useState<ShelfView>({ type: "root" });
  const [caseShelf, setCaseShelf] = useState<CaseShelf | null>(null);
  const [shelfFailed, setShelfFailed] = useState(false);
  const [caseDetail, setCaseDetail] = useState<CaseDetail | null>(null);
  const [caseDoc, setCaseDoc] = useState<CaseDocContent | null>(null);
  const [pending, setPending] = useState(false);

  // The dialog is fully controlled (the popover menu click flips `open`), so
  // Dialog's own onOpenChange never fires on open — the root fetch must key
  // off the `open` transition itself, not the dialog's callback.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open === wasOpen.current) return;
    wasOpen.current = open;
    if (!open) return;
    setView({ type: "root" });
    setCaseShelf(null);
    setShelfFailed(false);
    setCaseDetail(null);
    setCaseDoc(null);
    setPending(true);
    getCaseShelf(persona)
      .then(setCaseShelf)
      .catch(() => setShelfFailed(true))
      .finally(() => setPending(false));
  }, [open, persona]);

  const openCategory = useCallback((category: CaseCategory) => {
    setView({ type: "category", category });
    setCaseDetail(null);
    setCaseDoc(null);
  }, []);

  const openCase = useCallback(
    (category: CaseCategory, name: string) => {
      setView({ type: "case", category, name });
      setCaseDetail(null);
      setPending(true);
      getCaseDetail(category, name, persona)
        .then(setCaseDetail)
        .catch(() => setCaseDetail(null))
        .finally(() => setPending(false));
    },
    [persona],
  );

  const openCaseDoc = useCallback(
    (ref: string) => {
      setView({ type: "caseDoc", ref });
      setCaseDoc(null);
      setPending(true);
      getCaseDoc(ref, persona)
        .then(setCaseDoc)
        .catch(() => setCaseDoc(null))
        .finally(() => setPending(false));
    },
    [persona],
  );

  const backToRoot = useCallback(() => {
    setView({ type: "root" });
    setCaseDetail(null);
    setCaseDoc(null);
  }, []);

  const viewTitle =
    view.type === "category"
      ? t(`category.${view.category}`)
      : view.type === "case"
        ? view.name
        : view.type === "caseDoc"
          ? (view.ref.split("/").pop() ?? view.ref).replace(/\.md$/, "")
          : t("title");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm">
            {view.type !== "root" && (
              <button
                type="button"
                onClick={backToRoot}
                aria-label={t("back")}
                className="h-6 w-6 rounded-full text-muted-foreground hover:text-foreground hover:bg-muted transition-colors flex items-center justify-center"
              >
                <ArrowLeft className="h-3.5 w-3.5" />
              </button>
            )}
            <span className="truncate">{viewTitle}</span>
          </DialogTitle>
        </DialogHeader>

        {view.type === "root" && (
          <ShelfRoot
            caseShelf={caseShelf}
            pending={pending}
            failed={shelfFailed}
            onOpenCategory={openCategory}
          />
        )}
        {view.type === "category" && (
          <ShelfCategory
            caseShelf={caseShelf}
            category={view.category}
            onOpenCase={(name) => openCase(view.category, name)}
          />
        )}
        {view.type === "case" && (
          <ShelfCase
            detail={caseDetail}
            pending={pending}
            onOpenPiece={(pieceFileName) =>
              openCaseDoc(`${view.category}/${view.name}/${pieceFileName}`)
            }
          />
        )}
        {view.type === "caseDoc" && (
          <ShelfCaseDoc doc={caseDoc} pending={pending} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function ShelfRoot({
  caseShelf,
  pending,
  failed,
  onOpenCategory,
}: {
  caseShelf: CaseShelf | null;
  pending: boolean;
  failed: boolean;
  onOpenCategory: (category: CaseCategory) => void;
}) {
  const t = useTranslations("chat.input.shelf");

  if (pending && !caseShelf) {
    return <p className="py-4 text-sm text-muted-foreground">{t("loading")}</p>;
  }
  if (failed || !caseShelf) {
    return (
      <p className="py-4 text-sm text-muted-foreground italic">{t("loadError")}</p>
    );
  }

  return (
    <section>
      <h3 className="px-2 pb-1 text-xs font-medium text-muted-foreground">
        {t("byCategory")}
      </h3>
      <ul>
        {caseShelf.categories.map(({ category, cases }) => {
          const Icon = CATEGORY_ICONS[category];
          return (
            <li key={category}>
              <button
                type="button"
                onClick={() => onOpenCategory(category)}
                className="w-full flex items-center gap-2 rounded px-2 py-2 text-sm hover:bg-muted transition-colors text-left"
              >
                <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate">{t(`category.${category}`)}</span>
                <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                  {cases.length}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function ShelfCategory({
  caseShelf,
  category,
  onOpenCase,
}: {
  caseShelf: CaseShelf | null;
  category: CaseCategory;
  onOpenCase: (name: string) => void;
}) {
  const t = useTranslations("chat.input.shelf");
  const cases =
    caseShelf?.categories.find((c) => c.category === category)?.cases ?? [];

  if (cases.length === 0) {
    return (
      <p className="py-4 text-sm text-muted-foreground italic">{t("casesEmpty")}</p>
    );
  }

  return (
    <ul>
      {cases.map((item) => (
        <li key={item.name}>
          <button
            type="button"
            onClick={() => onOpenCase(item.name)}
            className="w-full rounded px-2 py-2 text-left hover:bg-muted transition-colors"
          >
            <span className="flex items-center gap-2 text-sm">
              <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate">{item.name}</span>
            </span>
            {item.preview && (
              <span className="mt-0.5 block truncate pl-6 text-xs text-muted-foreground">
                {item.preview}
              </span>
            )}
          </button>
        </li>
      ))}
    </ul>
  );
}

function ShelfCase({
  detail,
  pending,
  onOpenPiece,
}: {
  detail: CaseDetail | null;
  pending: boolean;
  onOpenPiece: (pieceFileName: string) => void;
}) {
  const t = useTranslations("chat.input.shelf");

  if (pending && !detail) {
    return <p className="py-4 text-sm text-muted-foreground">{t("loading")}</p>;
  }
  if (!detail) {
    return (
      <p className="py-4 text-sm text-muted-foreground italic">{t("loadError")}</p>
    );
  }

  // Attachments (§C.1): images render inline from /api/attachments (the
  // browser pulls bytes — never base64 into the client), files link open.
  const attachmentDisplay = buildAttachmentDisplay(detail);

  return (
    <div className="flex flex-col gap-3">
      {detail.opened && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-2 text-xs text-muted-foreground">
          <span>{t("openedAt", { date: detail.opened })}</span>
        </div>
      )}
      {detail.markdown && (
        <div className="px-2 font-serif text-sm font-light leading-relaxed">
          <MarkdownRenderer content={detail.markdown} />
        </div>
      )}
      {attachmentDisplay && (
        <div className="flex flex-col gap-2 px-2">
          <p className="text-xs font-semibold text-foreground/80">{t("attachments")}</p>
          {attachmentDisplay.images.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {attachmentDisplay.images.map((img) => (
                <a
                  key={img.name}
                  href={img.url}
                  target="_blank"
                  rel="noreferrer"
                  title={img.name}
                >
                  {/* Memory bytes are served raw from /api/attachments — the
                      next/image optimizer cannot reach them; plain <img>
                      matches the repo's existing attachment precedent. */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={img.url}
                    alt={img.name}
                    className="max-h-40 rounded-md border border-border/40 object-contain"
                  />
                </a>
              ))}
            </div>
          )}
          {attachmentDisplay.files.length > 0 && (
            <ul>
              {attachmentDisplay.files.map((file) => (
                <li key={file.name}>
                  <a
                    href={file.url}
                    target="_blank"
                    rel="noreferrer"
                    className="block truncate rounded px-1 py-1 font-mono text-xs text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
                  >
                    {file.name}
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {detail.pieces.length > 0 && (
        <ul>
          {detail.pieces.map((piece) => (
            <li key={piece.fileName}>
              <button
                type="button"
                onClick={() => onOpenPiece(piece.fileName)}
                className="w-full flex items-baseline gap-2 rounded px-2 py-2 text-sm hover:bg-muted transition-colors text-left"
              >
                {piece.date && (
                  <span className="shrink-0 font-mono text-xs text-muted-foreground">
                    {piece.date}
                  </span>
                )}
                <span className="truncate">
                  {piece.title ?? piece.fileName.replace(/\.md$/, "")}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ShelfCaseDoc({
  doc,
  pending,
}: {
  doc: CaseDocContent | null;
  pending: boolean;
}) {
  const t = useTranslations("chat.input.shelf");

  if (pending && !doc) {
    return <p className="py-4 text-sm text-muted-foreground">{t("loading")}</p>;
  }
  if (!doc) {
    return (
      <p className="py-4 text-sm text-muted-foreground italic">{t("loadError")}</p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {doc.opened && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-2 text-xs text-muted-foreground">
          <span>{t("openedAt", { date: doc.opened })}</span>
        </div>
      )}
      {doc.markdown ? (
        <div className="px-2 font-serif text-sm font-light leading-relaxed">
          <MarkdownRenderer content={doc.markdown} />
        </div>
      ) : (
        <p className="px-2 text-sm text-muted-foreground italic">
          {t("docsEmpty")}
        </p>
      )}
    </div>
  );
}
