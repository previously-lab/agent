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
 * THE RECORDS (v0.29): the reader's own conversations — the third section,
 * pinned between the Dossier and the category tree (self-memory leads: the
 * self-documents, then the conversations, then the case taxonomy). A row
 * carries the record idiom's own pair — the slice id's HH:MM wall clock and
 * its turn count — and opens the transcript on the desk (`records/<sliceId>`)
 * exactly like the archive field's record piles and the record switch do.
 * The rows group under the field's own time-bucket labels (the model's
 * `bucketKeyFor`, day / week-of), so the panel and the field read as one
 * archive. The data rides the records-only read (`getArchiveRecords`) in
 * the shelf's mount effect; a reader with no conversations gets an honest
 * line, not an empty heading.
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
import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
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
  getArchiveRecordIndex,
  getDossierList,
  type ArchiveRecord,
  type DossierEntry,
} from "@/lib/archive/actions";
import type { DossierDocName } from "@/lib/archive/refs";
import type { CaseCategory } from "@/lib/docs";
import { dateTimeFormat } from "@/lib/time/formatter-cache";
import {
  bucketKeyFor,
  localTodayIso,
  recordClock,
  type BucketKind,
} from "@/components/archive/archive-model";

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
  const tField = useTranslations("archiveField");
  const locale = useLocale();
  const { deskDoc, openDesk, archiveCategory, setArchiveCategory } = useShell();
  const [caseShelf, setCaseShelf] = useState<CaseShelf | null>(null);
  const [shelfFailed, setShelfFailed] = useState(false);
  const [dossier, setDossier] = useState<DossierEntry[] | null>(null);
  const [records, setRecords] = useState<ArchiveRecord[] | null>(null);
  const [activeCase, setActiveCase] = useState<{
    category: CaseCategory;
    name: string;
  } | null>(null);
  const [caseDetail, setCaseDetail] = useState<CaseDetail | null>(null);
  const [detailPending, setDetailPending] = useState(false);

  // The shelf loads ONCE at mount — the column is a permanent pane fixture,
  // not a dialog that refetches per open. Detail still rides one round trip
  // per case open, exactly like the dialog did. The Dossier's availability
  // read and the Records' records-only index ride the same mount effect
  // (parallel, independent — a missing self-document dims its row and a
  // failed records read hides its section, neither errors the shelf).
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
    getArchiveRecordIndex()
      .then((list) => {
        if (live) setRecords(list);
      })
      .catch(() => {
        if (live) setRecords(null);
      });
    return () => {
      live = false;
    };
  }, [persona]);

  // THE RECORDS' groups: the field's own time buckets (the model's
  // `bucketKeyFor` — the trailing week by day, older by ISO week), newest
  // first, each bucket's slices newest first. The label is the field row
  // label's own wording (the day, or the week's Monday) — the panel and
  // the field read as one archive. The bucket frame's NOW is the reader's
  // local day, which only the client knows (the record switch's own rule).
  const recordGroups = useMemo(() => {
    if (records === null || records.length === 0) return [];
    const today = localTodayIso();
    const byKey = new Map<
      string,
      { kind: BucketKind; date: string; slices: ArchiveRecord[] }
    >();
    for (const record of records) {
      const bucket = bucketKeyFor(record.date, today);
      const group = byKey.get(bucket.key) ?? {
        kind: bucket.kind,
        date: bucket.date,
        slices: [],
      };
      group.slices.push(record);
      byKey.set(bucket.key, group);
    }
    return [...byKey.entries()]
      .map(([key, group]) => {
        const date = dateTimeFormat(locale, {
          month: "short",
          day: "numeric",
        }).format(new Date(`${group.date}T00:00:00`));
        return {
          key,
          date: group.date,
          label: group.kind === "week" ? tField("weekOf", { date }) : date,
          slices: group.slices.sort((a, b) =>
            b.sliceId.localeCompare(a.sliceId),
          ),
        };
      })
      .sort((a, b) => b.date.localeCompare(a.date));
  }, [records, locale, tField]);

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
    <nav className="flex flex-1 flex-col overflow-y-auto">
      {/* THE DOSSIER (v0.25b §三 / v0.25 §3.4) — the two self-documents
          (previously / direction), pinned above the category tree. They are
          papers, not popovers: a row opens its document on the desk under
          `dossier/<name>`. A document missing on disk renders dimmed and
          never opens a dead paper. */}
      {dossier !== null && dossier.some((d) => d.available) && (
        <section data-dossier>
          <h3 className="chrome-label px-3.5 pb-1 pt-2">
            {t("dossier.title")}
          </h3>
          <ul>
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
                    className={`chrome-row gap-2 py-2 pl-3.5 pr-2 text-sm disabled:pointer-events-none disabled:opacity-40 ${
                      active ? "is-active" : ""
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
      {/* THE RECORDS (v0.29) — the reader's own conversations, pinned
          between the Dossier and the category tree. A row carries the
          record idiom's own pair (the slice id's HH:MM wall clock and its
          turn count — the switch's and the piles' vocabulary) and opens
          the transcript on the desk exactly like the field's record piles
          do. Hidden while the records-only read is in flight or failed
          (the Dossier's own precedent); a reader with no conversations
          gets an honest line under the heading. */}
      {records !== null && (
        <section data-records>
          <h3 className="chrome-label px-3.5 pb-1 pt-2">
            {t("records.title")}
          </h3>
          {recordGroups.length === 0 ? (
            <p className="px-3.5 pb-1 pt-0.5 text-xs text-muted-foreground italic">
              {t("records.empty")}
            </p>
          ) : (
            recordGroups.map((group) => (
              <div key={group.key} data-records-bucket={group.key}>
                <p className="chrome-label px-3.5 pb-0.5 pt-2.5">
                  {group.label}
                </p>
                <ul>
                  {group.slices.map((record) => {
                    const ref = `records/${record.sliceId}`;
                    const active = deskDoc === ref;
                    const clock = recordClock(record.sliceId);
                    return (
                      <li key={record.sliceId}>
                        <button
                          type="button"
                          data-records-row={record.sliceId}
                          aria-label={t("records.rowAria", {
                            time: clock,
                            count: record.turns,
                          })}
                          onClick={() => openDesk(ref)}
                          className={`chrome-row gap-2 py-2 pl-3.5 pr-2 text-sm ${
                            active ? "is-active" : ""
                          }`}
                        >
                          <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
                            {clock}
                          </span>
                          <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                            {t("records.turns", { count: record.turns })}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))
          )}
        </section>
      )}
      {caseShelf.categories.map(({ category, cases }) => {
        const Icon = CATEGORY_ICONS[category];
        const categoryOpen = archiveCategory === category;
        // R3 (v0.25 §3.1): an EMPTY category dims to 40% and never expands —
        // the taxonomy stays listed (it is the fiction's skeleton), but an
        // empty drawer stops shouting. The disabled styling mirrors the
        // dossier row's own unavailable-document precedent above.
        const empty = cases.length === 0;
        return (
          <section key={category}>
            <button
              type="button"
              onClick={() => selectCategory(category)}
              aria-expanded={empty ? undefined : categoryOpen}
              disabled={empty}
              className={`chrome-row gap-2 py-2 pl-3.5 pr-2 text-sm disabled:pointer-events-none disabled:opacity-40 ${
                categoryOpen ? "is-active" : ""
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
    <ul>
      {cases.map((item) => {
        const caseOpen = activeCaseName === item.name;
        // The case's index.md is the document while no piece of it is open.
        const caseDocActive = activeDocRef === `${category}/${item.name}`;
        return (
          <li key={item.name}>
            <button
              type="button"
              onClick={() => onOpenCase(item.name)}
              className={`chrome-row flex-col items-stretch gap-0.5 py-2 pl-8 pr-2 ${
                caseDocActive ? "is-active" : ""
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
                  className={`chrome-row items-baseline gap-2 py-1.5 pl-14 pr-2 text-sm ${
                    pieceActive ? "is-active" : ""
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
                    className="max-h-24 border border-border/40 object-contain"
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
                    className="block truncate px-1 py-1 font-mono text-xs text-muted-foreground transition-colors hover:text-foreground"
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
