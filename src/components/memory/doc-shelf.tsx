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
  User,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { MarkdownRenderer } from "@/components/chat/markdown";
import {
  getDocContent,
  getDocShelf,
  getDocTopicDetail,
  type DocContent,
  type DocShelf,
  type DocTopicDetail,
} from "@/lib/episodic/actions";
import type { DocKind } from "@/lib/docs";

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

type ShelfView =
  | { type: "root" }
  | { type: "topic"; name: string }
  | { type: "kind"; kind: DocKind }
  | { type: "doc"; fileName: string; kind?: DocKind };

/**
 * The document shelf (v0.15 §4.2) — the memory-docs viewer's two-level
 * browse: topic homes (their 截至块 + catalogued documents) and the plain
 * `ls` of the eight dated kind directories. Everything loads lazily in event
 * handlers (one server-action round trip per open / per level), exactly like
 * the MemoryDocs popover it extends. Header dates are displayed verbatim —
 * no staleness is computed or rendered.
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
  const [shelf, setShelf] = useState<DocShelf | null>(null);
  const [shelfFailed, setShelfFailed] = useState(false);
  const [topic, setTopic] = useState<DocTopicDetail | null>(null);
  const [doc, setDoc] = useState<DocContent | null>(null);
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
    setShelf(null);
    setShelfFailed(false);
    setTopic(null);
    setDoc(null);
    setPending(true);
    getDocShelf(persona)
      .then(setShelf)
      .catch(() => setShelfFailed(true))
      .finally(() => setPending(false));
  }, [open, persona]);

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
    setTopic(null);
    setDoc(null);
  }, []);

  const viewTitle =
    view.type === "topic"
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
            shelf={shelf}
            pending={pending}
            failed={shelfFailed}
            onOpenTopic={openTopic}
            onOpenKind={openKind}
          />
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
            shelf={shelf}
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
  shelf,
  pending,
  failed,
  onOpenTopic,
  onOpenKind,
}: {
  shelf: DocShelf | null;
  pending: boolean;
  failed: boolean;
  onOpenTopic: (name: string) => void;
  onOpenKind: (kind: DocKind) => void;
}) {
  const t = useTranslations("chat.input.shelf");
  const datedKinds = (shelf?.kinds ?? []).filter((k) => k.kind !== "topic");

  if (pending && !shelf) {
    return <p className="py-4 text-sm text-muted-foreground">{t("loading")}</p>;
  }
  if (failed || (!pending && !shelf)) {
    return (
      <p className="py-4 text-sm text-muted-foreground italic">{t("loadError")}</p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <section>
        <h3 className="px-2 pb-1 text-xs font-medium text-muted-foreground">
          {t("byTopic")}
        </h3>
        {shelf!.topics.length === 0 ? (
          <p className="px-2 py-3 text-sm text-muted-foreground italic">
            {t("topicsEmpty")}
          </p>
        ) : (
          <ul>
            {shelf!.topics.map((topic) => (
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
