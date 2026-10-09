"use client";

/**
 * The document library tree (v0.23; panel content since v0.24) — the
 * three-level filter: category → case → piece. The browsing tree moved OUT
 * of the retired modal (DocShelfDialog) into the reader's left column, and
 * the column moved into the floating LibraryControl's panel — the row
 * components are the dialog's own, moved with their data contracts intact
 * (getCaseShelf / getCaseDetail, one server-action round trip per open, the
 * shelf's own rhythm).
 *
 * THE DOSSIER (v0.25b §三): the two self-documents (previously / direction)
 * pin ABOVE the tree as their own section — the archive is memory's only
 * door now that the composer's memory-docs popover is retired. A dossier
 * row opens its document on the desk (`dossier/<name>`) exactly like a case
 * row opens `index.md`; reading lives on the paper here too.
 *
 * THE TERMINAL ACTION NEVER READS INSIDE THE TREE. A case opens its own
 * `index.md` on the desk — a case with NO pieces is finally readable, the
 * v0.22 gap where only pieces could reach the tabletop. A piece opens that
 * piece, cited by its stem (no `.md` — the ref names a document by
 * identity, case-refs.ts tolerates the suffix anyway). Reading lives on
 * the paper; the tree only filters.
 *
 * The ACTIVE DOCUMENT is whatever `deskDoc` currently names — the tree
 * holds no selection copy, so Escape (put the document back) clears every
 * highlight by itself. The expanded case is local browsing state and stays
 * put when the paper closes.
 *
 * THE CATEGORY SELECTION IS ALSO THE ARCHIVE FIELD'S FILTER (v0.25a §四):
 * the selected category lives in the shell provider (`archiveCategory`),
 * and the field renders only that column while it is set. Re-click the open
 * category to clear. The case-level browsing (`activeCase`) stays local.
 */
import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import {
  BookMarked,
  Building2,
  CalendarDays,
  Compass,
  FileText,
  History,
  Lightbulb,
  ListChecks,
  MapPin,
  Package,
  Sparkles,
  User,
} from "lucide-react";
import { useShell } from "@/components/shell/shell-provider";
import { buildAttachmentDisplay } from "@/components/memory/attachment-display";
import {
  getCaseDetail,
  getCaseShelf,
  type CaseDetail,
  type CaseShelf,
} from "@/lib/episodic/actions";
import {
  getDossierList,
  type DossierEntry,
} from "@/lib/archive/actions";
import type { DossierDocName } from "@/lib/archive/refs";
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

/** The Dossier rows' icons — the retired memory-docs popover's own pair. */
const DOSSIER_ICONS: Record<DossierDocName, typeof History> = {
  previously: History,
  direction: Compass,
};

/** A case row hands its pieces here as the STEM (no `.md`) — the reference
 *  names the document by identity; the parser appends the suffix. */
function pieceRef(category: CaseCategory, caseName: string, stem: string): string {
  return `${category}/${caseName}/${stem}`;
}

export function DocLibrary({ persona }: { persona?: string }) {
  const t = useTranslations("library");
  const { deskDoc, openDesk, archiveCategory, setArchiveCategory } = useShell();
  const [caseShelf, setCaseShelf] = useState<CaseShelf | null>(null);
  const [shelfFailed, setShelfFailed] = useState(false);
  const [dossier, setDossier] = useState<DossierEntry[] | null>(null);
  const [activeCase, setActiveCase] = useState<{
    category: CaseCategory;
    name: string;
  } | null>(null);
  const [caseDetail, setCaseDetail] = useState<CaseDetail | null>(null);
  const [detailPending, setDetailPending] = useState(false);

  // The shelf loads ONCE at mount — the column is a permanent pane fixture,
  // not a dialog that refetches per open. Detail still rides one round trip
  // per case open, exactly like the dialog did. The Dossier's availability
  // read rides the same mount effect (parallel, independent — a missing
  // self-document dims its row, never errors the shelf).
  useEffect(() => {
    let live = true;
    getCaseShelf(persona)
      .then((shelf) => {
        if (live) setCaseShelf(shelf);
      })
      .catch(() => {
        if (live) setShelfFailed(true);
      });
    getDossierList(persona)
      .then((list) => {
        if (live) setDossier(list);
      })
      .catch(() => {
        if (live) setDossier(null);
      });
    return () => {
      live = false;
    };
  }, [persona]);

  // One category open at a time; re-clicking the open one collapses it.
  // The selection IS the archive field's filter (see the module header), so
  // it writes the provider, not a local copy. Collapsing or leaving a
  // category collapses its case with it — the desk keeps whatever document
  // it holds, the column just stops browsing it.
  const selectCategory = useCallback(
    (category: CaseCategory) => {
      setArchiveCategory(archiveCategory === category ? null : category);
      setActiveCase(null);
      setCaseDetail(null);
    },
    [archiveCategory, setArchiveCategory],
  );

  // A case IS its `index.md`: opening it puts the index on the desk AND
  // expands the piece list beneath the row.
  const selectCase = useCallback(
    (category: CaseCategory, name: string) => {
      setActiveCase({ category, name });
      setCaseDetail(null);
      setDetailPending(true);
      openDesk(`${category}/${name}`);
      getCaseDetail(category, name, persona)
        .then((detail) => setCaseDetail(detail))
        .catch(() => setCaseDetail(null))
        .finally(() => setDetailPending(false));
    },
    [openDesk, persona],
  );

  const openPiece = useCallback(
    (stem: string) => {
      if (!activeCase) return;
      openDesk(pieceRef(activeCase.category, activeCase.name, stem));
    },
    [openDesk, activeCase],
  );

  if (shelfFailed) {
    return (
      <p className="px-3 py-4 text-sm text-muted-foreground italic">
        {t("loadError")}
      </p>
    );
  }
  if (!caseShelf) {
    return <p className="px-3 py-4 text-sm text-muted-foreground">{t("loading")}</p>;
  }

  return (
    <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto p-2">
      <h2 className="px-2 pb-1 pt-1 text-xs font-medium text-muted-foreground">
        {t("title")}
      </h2>
      {/* THE DOSSIER (v0.25b §三 / v0.25 §3.4) — the two self-documents
          (previously / direction), pinned above the category tree. They are
          papers, not popovers: a row opens its document on the desk under
          `dossier/<name>`. A document missing on disk renders dimmed and
          never opens a dead paper. */}
      {dossier !== null && dossier.some((d) => d.available) && (
        <section data-dossier>
          <h3 className="px-2 pb-0.5 pt-1 text-xs font-medium text-muted-foreground/70">
            {t("dossier.title")}
          </h3>
          <ul className="pb-1">
            {dossier.map((entry) => {
              const Icon = DOSSIER_ICONS[entry.name];
              const active = deskDoc === entry.ref;
              return (
                <li key={entry.name}>
                  <button
                    type="button"
                    data-dossier-doc={entry.name}
                    disabled={!entry.available}
                    onClick={() => openDesk(entry.ref)}
                    className={`w-full flex items-center gap-2 rounded px-2 py-2 text-sm transition-colors text-left hover:bg-muted disabled:pointer-events-none disabled:opacity-40 ${
                      active ? "bg-muted" : ""
                    }`}
                  >
                    <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <span className="truncate">{t(`dossier.${entry.name}`)}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      )}
      {caseShelf.categories.map(({ category, cases }) => {
        const Icon = CATEGORY_ICONS[category];
        const categoryOpen = archiveCategory === category;
        return (
          <section key={category}>
            <button
              type="button"
              onClick={() => selectCategory(category)}
              aria-expanded={categoryOpen}
              className={`w-full flex items-center gap-2 rounded px-2 py-2 text-sm transition-colors text-left hover:bg-muted ${
                categoryOpen ? "text-foreground" : "text-foreground/80"
              }`}
            >
              <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate">{t(`category.${category}`)}</span>
              <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                {cases.length}
              </span>
            </button>
            {categoryOpen && (
              <CaseRows
                category={category}
                cases={cases}
                activeCaseName={activeCase?.name ?? null}
                activeDocRef={deskDoc}
                detail={activeCase?.category === category ? caseDetail : null}
                detailPending={detailPending}
                onOpenCase={(name) => selectCase(category, name)}
                onOpenPiece={openPiece}
              />
            )}
          </section>
        );
      })}
    </nav>
  );
}

/** The expanded category's case list — one indent under the category row.
 *  The selected case's detail (opened stamp / attachments / pieces) renders
 *  one indent further in, beneath its own row. */
function CaseRows({
  category,
  cases,
  activeCaseName,
  activeDocRef,
  detail,
  detailPending,
  onOpenCase,
  onOpenPiece,
}: {
  category: CaseCategory;
  cases: CaseShelf["categories"][number]["cases"];
  activeCaseName: string | null;
  activeDocRef: string | null;
  detail: CaseDetail | null;
  detailPending: boolean;
  onOpenCase: (name: string) => void;
  onOpenPiece: (stem: string) => void;
}) {
  const t = useTranslations("library");

  if (cases.length === 0) {
    return (
      <p className="py-2 pl-9 pr-2 text-xs text-muted-foreground italic">
        {t("casesEmpty")}
      </p>
    );
  }

  return (
    <ul className="pb-1">
      {cases.map((item) => {
        const caseOpen = activeCaseName === item.name;
        // The case's index.md is the document while no piece of it is open.
        const caseDocActive = activeDocRef === `${category}/${item.name}`;
        return (
          <li key={item.name}>
            <button
              type="button"
              onClick={() => onOpenCase(item.name)}
              className={`w-full rounded py-2 pl-8 pr-2 text-left transition-colors hover:bg-muted ${
                caseDocActive ? "bg-muted" : ""
              }`}
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
            {caseOpen && (
              <CaseDetailRows
                detail={detail}
                pending={detailPending}
                activeDocRef={activeDocRef}
                onOpenPiece={onOpenPiece}
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** The selected case's second level: the opened stamp, the piece list, the
 *  attachments (moved as-is from the retired dialog — images render inline
 *  from /api/attachments, files link open). The `index.md` body itself is
 *  NOT here — it is on the paper, where reading lives. */
function CaseDetailRows({
  detail,
  pending,
  activeDocRef,
  onOpenPiece,
}: {
  detail: CaseDetail | null;
  pending: boolean;
  activeDocRef: string | null;
  onOpenPiece: (stem: string) => void;
}) {
  const t = useTranslations("library");

  if (pending && !detail) {
    return (
      <p className="py-2 pl-14 pr-2 text-xs text-muted-foreground">
        {t("loading")}
      </p>
    );
  }
  if (!detail) {
    return (
      <p className="py-2 pl-14 pr-2 text-xs text-muted-foreground italic">
        {t("loadError")}
      </p>
    );
  }

  const attachmentDisplay = buildAttachmentDisplay(detail);

  return (
    <div className="pb-1">
      {detail.opened && (
        <p className="py-1 pl-14 pr-2 text-xs text-muted-foreground">
          {t("openedAt", { date: detail.opened })}
        </p>
      )}
      {detail.pieces.length === 0 ? (
        <p className="py-1 pl-14 pr-2 text-xs text-muted-foreground italic">
          {t("piecesEmpty")}
        </p>
      ) : (
        <ul>
          {detail.pieces.map((piece) => {
            const stem = piece.fileName.replace(/\.md$/, "");
            const pieceActive =
              activeDocRef ===
              pieceRef(detail.category, detail.name, stem);
            return (
              <li key={piece.fileName}>
                <button
                  type="button"
                  onClick={() => onOpenPiece(stem)}
                  className={`w-full flex items-baseline gap-2 rounded py-1.5 pl-14 pr-2 text-sm transition-colors hover:bg-muted ${
                    pieceActive ? "bg-muted" : ""
                  }`}
                >
                  {piece.date && (
                    <span className="shrink-0 font-mono text-xs text-muted-foreground">
                      {piece.date}
                    </span>
                  )}
                  <span className="truncate">
                    {piece.title ?? stem}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {attachmentDisplay && (
        <div className="flex flex-col gap-1.5 py-1 pl-14 pr-2">
          <p className="text-xs font-semibold text-foreground/80">
            {t("attachments")}
          </p>
          {attachmentDisplay.images.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
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
                    className="max-h-24 rounded-md border border-border/40 object-contain"
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
    </div>
  );
}
