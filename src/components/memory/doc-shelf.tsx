"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import {
  ArrowLeft,
  BookMarked,
  Building2,
  CalendarDays,
  FileText,
  Home,
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
  getDocContent,
  getDocShelf,
  getDocTopicDetail,
  type CaseDetail,
  type CaseDocContent,
  type CaseShelf,
  type DocContent,
  type DocShelf,
  type DocTopicDetail,
} from "@/lib/episodic/actions";
import type { CaseCategory, DocKind } from "@/lib/docs";

const KIND_ICONS: Record<DocKind, typeof FileText> = {
  event: CalendarDays,
  person: User,
  object: Package,
  place: MapPin,
  org: Building2,
  research: BookMarked,
  hypothesis: Lightbulb,
  task: ListChecks,
  topic: Home,
};

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
  | { type: "caseDoc"; ref: string }
  | { type: "topic"; name: string }
  | { type: "kind"; kind: DocKind }
  | { type: "doc"; fileName: string; kind?: DocKind };

/**
 * The memory shelf (v0.19 R3b): two halves in one dialog. The case half
 * (§B.1/§B.2) browses the nine categories — a category lists its cases, a
 * case opens its `index.md` plus its piece list, and any piece (or case
 * reference) opens through `getCaseDoc` with dual-root tolerance (§D.1).
 * The legacy half (v0.15 §4.2: topic homes + the eight dated kind
 * directories) stays below it until the存量 migration (另案). Everything
 * loads lazily in event handlers (one server-action round trip per open /
 * per level), exactly like the MemoryDocs popover it extends. Header dates
 * are displayed verbatim — no staleness is computed or rendered.
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
  const [legacyShelf, setLegacyShelf] = useState<DocShelf | null>(null);
  const [shelfFailed, setShelfFailed] = useState(false);
  const [caseDetail, setCaseDetail] = useState<CaseDetail | null>(null);
  const [caseDoc, setCaseDoc] = useState<CaseDocContent | null>(null);
  const [topic, setTopic] = useState<DocTopicDetail | null>(null);
  const [doc, setDoc] = useState<DocContent | null>(null);
  const [pending, setPending] = useState(false);

  // The dialog is fully controlled (the popover menu click flips `open`), so
  // Dialog's own onOpenChange never fires on open — the root fetch must key
  // off the `open` transition itself, not the dialog's callback. The two
  // halves settle independently: a missing legacy root must not blank the
  // case section (and vice versa).
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open === wasOpen.current) return;
    wasOpen.current = open;
    if (!open) return;
    setView({ type: "root" });
    setCaseShelf(null);
    setLegacyShelf(null);
    setShelfFailed(false);
    setCaseDetail(null);
    setCaseDoc(null);
    setTopic(null);
    setDoc(null);
    setPending(true);
    Promise.allSettled([getCaseShelf(persona), getDocShelf(persona)])
      .then(([cases, legacy]) => {
        if (cases.status === "fulfilled") setCaseShelf(cases.value);
        if (legacy.status === "fulfilled") setLegacyShelf(legacy.value);
        if (cases.status === "rejected" && legacy.status === "rejected") {
          setShelfFailed(true);
        }
      })
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

  const openTopic = useCallback(
    (name: string) => {
      setView({ type: "topic", name });
      setTopic(null);
      setDoc(null);
      setPending(true);
      getDocTopicDetail(name, persona)
        .then(setTopic)
        .catch(() => setTopic(null))
        .finally(() => setPending(false));
    },
    [persona],
  );

  const openKind = useCallback((kind: DocKind) => {
    setView({ type: "kind", kind });
    setTopic(null);
    setDoc(null);
  }, []);

  const openDoc = useCallback(
    (fileName: string, kind?: DocKind) => {
      setView({ type: "doc", fileName, kind });
      setDoc(null);
      setPending(true);
      getDocContent(fileName, kind, persona)
        .then(setDoc)
        .catch(() => setDoc(null))
        .finally(() => setPending(false));
    },
    [persona],
  );

  const backToRoot = useCallback(() => {
    setView({ type: "root" });
    setCaseDetail(null);
    setCaseDoc(null);
    setTopic(null);
    setDoc(null);
  }, []);

  const viewTitle =
    view.type === "category"
      ? t(`category.${view.category}`)
      : view.type === "case"
        ? view.name
        : view.type === "caseDoc"
          ? (view.ref.split("/").pop() ?? view.ref).replace(/\.md$/, "")
          : view.type === "topic"
            ? view.name
            : view.type === "kind"
              ? t(`kind.${view.kind}`)
              : view.type === "doc"
                ? view.fileName.replace(/\.md$/, "")
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
            legacyShelf={legacyShelf}
            pending={pending}
            failed={shelfFailed}
            onOpenCategory={openCategory}
            onOpenTopic={openTopic}
            onOpenKind={openKind}
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
        {view.type === "topic" && (
          <ShelfTopic
            topic={topic}
            pending={pending}
            onOpenDoc={(fileName) => openDoc(fileName)}
          />
        )}
        {view.type === "kind" && (
          <ShelfKind
            shelf={legacyShelf}
            kind={view.kind}
            onOpenDoc={(fileName) => openDoc(fileName, view.kind)}
          />
        )}
        {view.type === "doc" && (
          <ShelfDoc doc={doc} pending={pending} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function ShelfRoot({
  caseShelf,
  legacyShelf,
  pending,
  failed,
  onOpenCategory,
  onOpenTopic,
  onOpenKind,
}: {
  caseShelf: CaseShelf | null;
  legacyShelf: DocShelf | null;
  pending: boolean;
  failed: boolean;
  onOpenCategory: (category: CaseCategory) => void;
  onOpenTopic: (name: string) => void;
  onOpenKind: (kind: DocKind) => void;
}) {
  const t = useTranslations("chat.input.shelf");
  const datedKinds = (legacyShelf?.kinds ?? []).filter((k) => k.kind !== "topic");

  if (pending && !caseShelf && !legacyShelf) {
    return <p className="py-4 text-sm text-muted-foreground">{t("loading")}</p>;
  }
  if (failed || (!pending && !caseShelf && !legacyShelf)) {
    return (
      <p className="py-4 text-sm text-muted-foreground italic">{t("loadError")}</p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {caseShelf && (
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
      )}

      {legacyShelf && (
        <section>
          <h3 className="px-2 pb-1 text-xs font-medium text-muted-foreground">
            {t("byTopic")}
          </h3>
          {legacyShelf.topics.length === 0 ? (
            <p className="px-2 py-3 text-sm text-muted-foreground italic">
              {t("topicsEmpty")}
            </p>
          ) : (
            <ul>
              {legacyShelf.topics.map((topic) => (
                <li key={topic.name}>
                  <button
                    type="button"
                    onClick={() => onOpenTopic(topic.name)}
                    className="w-full rounded px-2 py-2 text-left hover:bg-muted transition-colors"
                  >
                    <span className="flex items-center gap-2 text-sm">
                      <Home className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <span className="truncate">{topic.name}</span>
                      <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                        {topic.updated
                          ? t("updatedAt", { date: topic.updated })
                          : t(`status.${topic.status}`)}
                      </span>
                    </span>
                    {topic.asOf && (
                      <span className="mt-0.5 block truncate pl-6 text-xs text-muted-foreground">
                        {topic.asOf}
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {legacyShelf && (
        <section>
          <h3 className="px-2 pb-1 text-xs font-medium text-muted-foreground">
            {t("byKind")}
          </h3>
          <ul>
            {datedKinds.map(({ kind, docs }) => {
              const Icon = KIND_ICONS[kind];
              return (
                <li key={kind}>
                  <button
                    type="button"
                    onClick={() => onOpenKind(kind)}
                    className="w-full flex items-center gap-2 rounded px-2 py-2 text-sm hover:bg-muted transition-colors text-left"
                  >
                    <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <span className="truncate">{t(`kind.${kind}`)}</span>
                    <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                      {docs.length}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
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
              <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                {item.closed ? t("closedAt", { date: item.closed }) : t("writing")}
              </span>
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
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-2 text-xs text-muted-foreground">
        {detail.opened && <span>{t("openedAt", { date: detail.opened })}</span>}
        <span>
          {detail.closed ? t("closedAt", { date: detail.closed }) : t("writing")}
        </span>
      </div>
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
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-2 text-xs text-muted-foreground">
        {doc.opened && <span>{t("openedAt", { date: doc.opened })}</span>}
        <span>{doc.closed ? t("closedAt", { date: doc.closed }) : t("writing")}</span>
      </div>
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

function ShelfTopic({
  topic,
  pending,
  onOpenDoc,
}: {
  topic: DocTopicDetail | null;
  pending: boolean;
  onOpenDoc: (fileName: string) => void;
}) {
  const t = useTranslations("chat.input.shelf");

  if (pending && !topic) {
    return <p className="py-4 text-sm text-muted-foreground">{t("loading")}</p>;
  }
  if (!topic) {
    return (
      <p className="py-4 text-sm text-muted-foreground italic">{t("loadError")}</p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-2 text-xs text-muted-foreground">
        <span>{t(`status.${topic.status}`)}</span>
        {topic.opened && <span>{t("openedAt", { date: topic.opened })}</span>}
        {topic.updated && <span>{t("updatedAt", { date: topic.updated })}</span>}
      </div>
      {topic.asOf && (
        <blockquote className="rounded-md bg-muted/50 px-3 py-2 text-sm font-light leading-relaxed">
          {topic.asOf}
        </blockquote>
      )}
      {topic.catalog.length === 0 ? (
        <p className="px-2 py-2 text-sm text-muted-foreground italic">
          {t("catalogEmpty")}
        </p>
      ) : (
        <ul className="flex flex-col gap-1">
          {topic.catalog.map((item, i) => (
            <li key={`${item.date}-${i}`} className="rounded px-2 py-2 hover:bg-muted transition-colors">
              <div className="flex items-baseline gap-2 text-sm">
                <span className="shrink-0 font-mono text-xs text-muted-foreground">
                  {item.date}
                </span>
                <span className="truncate">{item.title}</span>
              </div>
              {item.snippet && (
                <p className="mt-0.5 pl-14 text-xs text-muted-foreground">
                  {item.snippet}
                </p>
              )}
              <div className="mt-1 flex flex-wrap gap-1 pl-14">
                {item.refs.map((ref) => (
                  <button
                    key={ref}
                    type="button"
                    onClick={() => onOpenDoc(ref)}
                    className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground hover:bg-brand/10 transition-colors"
                  >
                    {ref.replace(/\.md$/, "")}
                  </button>
                ))}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ShelfKind({
  shelf,
  kind,
  onOpenDoc,
}: {
  shelf: DocShelf | null;
  kind: DocKind;
  onOpenDoc: (fileName: string) => void;
}) {
  const t = useTranslations("chat.input.shelf");
  const docs = shelf?.kinds.find((k) => k.kind === kind)?.docs ?? [];

  if (docs.length === 0) {
    return (
      <p className="py-4 text-sm text-muted-foreground italic">{t("docsEmpty")}</p>
    );
  }

  return (
    <ul>
      {docs.map((doc) => (
        <li key={doc.fileName}>
          <button
            type="button"
            onClick={() => onOpenDoc(doc.fileName)}
            className="w-full flex items-baseline gap-2 rounded px-2 py-2 text-sm hover:bg-muted transition-colors text-left"
          >
            {doc.date && (
              <span className="shrink-0 font-mono text-xs text-muted-foreground">
                {doc.date}
              </span>
            )}
            <span className="truncate">{doc.title ?? doc.fileName}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function ShelfDoc({ doc, pending }: { doc: DocContent | null; pending: boolean }) {
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
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-2 text-xs text-muted-foreground">
        <span>{t(`kind.${doc.kind}`)}</span>
        <span>{t(`status.${doc.status}`)}</span>
        {doc.opened && <span>{t("openedAt", { date: doc.opened })}</span>}
        {doc.updated && <span>{t("updatedAt", { date: doc.updated })}</span>}
      </div>
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
