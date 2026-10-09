"use server";

/**
 * The archive field's aggregation read (v0.25a §四) — ONE round trip that
 * turns the case tree into the grid's data. `getCaseShelf` (the library's
 * own read) cannot answer the field's two questions — a pile's THICKNESS
 * needs the piece count, and its TIME BUCKET needs the last write, not just
 * the birth — and `src/lib/episodic/**` is not this surface's to extend, so
 * the field's pipeline lives here, built from the same read-only primitives
 * (`fsListFiles` / `fsReadFile` / the case parsers) the shelf uses.
 *
 * WHAT A PILE IS. One pile = one case: its `index.md` plus its pieces. The
 * volume (`pages`) is the document count — the index plus its pieces — the
 * count of sheets the pile would hold. The last write (`updated`) is the
 * newest date the case carries: its `opened` stamp or the newest piece's
 * filename date, whichever is later. Both are DISK facts; nothing here
 * estimates content length.
 */
import {
  CASE_CATEGORIES,
  caseDirPath,
  caseIndexPath,
  isValidCaseName,
  isValidPieceFileName,
  parseCaseDoc,
  parsePieceFileName,
  type CaseCategory,
} from "@/lib/docs";
import { fsListFiles, fsReadFile } from "@/lib/episodic/io-helpers";
import { enumerateSliceIds } from "@/lib/episodic/timeline/enumerate";
import { sliceEntryFromDisk } from "@/lib/episodic/timeline/store";
import {
  getSliceContent,
  type CaseDocContent,
} from "@/lib/episodic/actions";
import {
  parseDossierRef,
  parseRecordRef,
  type DossierDocName,
  type RecordSpeakerLabels,
} from "./refs";
import { setDemoPersona } from "@/lib/demo/demo-fs";

/** One pile in the archive field — one case. */
export interface ArchivePile {
  /** The case pile — the record pile (ArchiveRecord) is the other kind. */
  kind: "case";
  category: CaseCategory;
  name: string;
  /** The open target: the case's two-segment ref names its `index.md`, the
   *  pile's first document (the reader's A4 deck opens it unchanged). */
  ref: string;
  /** Birth date from the index header ("" tolerated, as the shelf's is). */
  opened: string;
  /** The case's last write: max(opened, newest piece date). Drives the
   *  time-bucket row. "" when the case carries no date at all. */
  updated: string;
  /** The pile's volume in sheets: the index plus its pieces. */
  pages: number;
}

export interface ArchiveFieldData {
  piles: ArchivePile[];
  /** The field's record rows' source: one entry per slice on disk (v0.25b
   *  §三 — past conversations are papers too). The model buckets these into
   *  one record pile per time bucket. */
  records: ArchiveRecord[];
}

/** Same shape as the shelf's own limiter (episodic/actions.ts keeps its
 *  copy private): point reads fan out, but never all at once. */
const ARCHIVE_READ_CONCURRENCY = 12;

async function mapLimited<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next;
        next += 1;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

/** One case directory → one pile, or null when the case has no readable
 *  `index.md` (the shelf's own rule: a case without an index is not one). */
async function readPile(
  category: CaseCategory,
  name: string,
): Promise<ArchivePile | null> {
  const raw = await fsReadFile(caseIndexPath(category, name)).catch(() => null);
  if (raw === null) return null;
  const doc = parseCaseDoc(raw, { category, caseName: name, fileName: "index.md" });

  const dirEntries = await fsListFiles(caseDirPath(category, name)).catch(
    () => [],
  );
  const pieceDates = dirEntries
    .filter(
      (e) =>
        e.type === "file" &&
        e.name !== "index.md" &&
        e.name.endsWith(".md") &&
        isValidPieceFileName(e.name),
    )
    .map((e) => parsePieceFileName(e.name)?.date ?? null)
    .filter((d): d is string => d !== null);

  const updated = [doc.opened, ...pieceDates].reduce((a, b) =>
    b > a ? b : a,
  );
  return {
    kind: "case",
    category,
    name,
    ref: `${category}/${name}`,
    opened: doc.opened,
    updated,
    pages: 1 + pieceDates.length,
  };
}

/**
 * The field's whole read: every category's case directories, each point-read
 * for its header and piece list, plus the records aggregation (the slice
 * enumeration + one header read per slice, for the record piles' turn
 * counts). Missing category directories list as empty (pre-migration is a
 * normal state — the shelf's own rule).
 */
export async function getArchiveField(
  persona?: string,
): Promise<ArchiveFieldData> {
  if (persona) setDemoPersona(persona);

  const [perCategory, records] = await Promise.all([
    Promise.all(
      CASE_CATEGORIES.map(async (category): Promise<ArchivePile[]> => {
        let entries: Awaited<ReturnType<typeof fsListFiles>>;
        try {
          entries = await fsListFiles(`memory/${category}`);
        } catch {
          return [];
        }
        const names = entries
          .filter((e) => e.type === "dir" && isValidCaseName(e.name))
          .map((e) => e.name);
        const piles = await mapLimited(names, ARCHIVE_READ_CONCURRENCY, (name) =>
          readPile(category, name),
        );
        return piles.filter((p): p is ArchivePile => p !== null);
      }),
    ),
    readArchiveRecords(),
  ]);

  return { piles: perCategory.flat(), records };
}

// ─── Records (v0.25b §三) — past conversations are papers too ─────────────
// A slice IS a document: its transcript, 原文级 — no summary, no paraphrase.
// The field carries ONE RECORD PILE per time bucket (its thickness is the
// bucket's turn volume; opening it reads the bucket's newest slice), and the
// reader renders the transcript on the same A4 paged paper as a case, under
// the `records/<sliceId>` reference kind — NOT one of the nine case
// categories, so `parseCaseRef`'s grammar never touches it (the desk routes
// on the first segment before the case parse runs).

/** One slice's field fact: its id (the open target), its calendar date (the
 *  id's own UTC date — the timeline's frame), and its turn volume. */
export interface ArchiveRecord {
  sliceId: string;
  date: string;
  turns: number;
}

/** The slice header read, shaped for the field. A slice whose header does
 *  not parse is skipped (the shelf's own tolerance). */
async function readArchiveRecord(rel: string): Promise<ArchiveRecord | null> {
  const entry = await sliceEntryFromDisk(rel).catch(() => null);
  if (!entry) return null;
  return { sliceId: entry.id, date: entry.date, turns: entry.turn_count ?? 0 };
}

/** Every slice on disk, oldest → newest — one enumeration, then bounded
 *  header point reads (the same rhythm as the pile reads above). */
async function readArchiveRecords(): Promise<ArchiveRecord[]> {
  const rels = await enumerateSliceIds().catch(() => [] as string[]);
  const records = await mapLimited(rels, ARCHIVE_READ_CONCURRENCY, readArchiveRecord);
  return records
    .filter((r): r is ArchiveRecord => r !== null)
    .sort((a, b) => a.sliceId.localeCompare(b.sliceId));
}

/** The `records/<sliceId>` grammar lives in `./refs` (pure — this module is
 *  `"use server"` and may export only async functions). */

export interface RecordDocContent extends CaseDocContent {
  sliceId: string;
  turnCount: number;
}

/**
 * Open a record: the slice's own transcript as a printable document. The
 * body is the turns AS THEY WERE SAID — a bold speaker label over each
 * turn's verbatim content — paginated by the desk's existing machinery. A
 * slice that does not resolve is a dead link: null, and the desk prints its
 * not-found paper.
 */
export async function getRecordDoc(
  refText: string,
  labels: RecordSpeakerLabels,
  persona?: string,
): Promise<RecordDocContent | null> {
  if (persona) setDemoPersona(persona);
  const parsed = parseRecordRef(refText);
  if (!parsed) return null;
  const slice = await getSliceContent(parsed.sliceId, persona, { full: true });
  if (!slice) return null;

  const markdown = slice.turns
    .map(
      (turn) =>
        `**${turn.role === "user" ? labels.user : labels.agent}**\n\n${turn.content}`,
    )
    .join("\n\n");

  return {
    ref: refText,
    opened: parsed.sliceId.slice(0, 10),
    closed: null,
    markdown,
    warnings: [],
    sliceId: parsed.sliceId,
    turnCount: slice.totalTurns,
  };
}

// ─── The Dossier (v0.25b §三 / v0.25 §3.4) ────────────────────────────────
// The two self-documents — the current previously card and the evolution
// direction — are papers too. They pin to the top of the library panel as
// the Dossier section and open on the desk under the `dossier/<name>`
// reference kind (also outside the case grammar). READS ONLY, verbatim —
// these files are the evolution loop's to write, never this surface's.
// The ref grammar (`dossier/<name>`, DossierDocName) lives in ./refs.

const DOSSIER_PATHS: Record<DossierDocName, string> = {
  previously: "memory/episodic/current-previously.md",
  direction: "memory/evolution/direction.md",
};

/** One Dossier row in the library: the open ref and whether the document
 *  exists on disk (a missing one renders dimmed and never opens a dead
 *  paper). */
export interface DossierEntry {
  name: DossierDocName;
  ref: string;
  available: boolean;
}

/** The Dossier section's read: both documents' availability, one round
 *  trip's worth of parallel point reads. */
export async function getDossierList(persona?: string): Promise<DossierEntry[]> {
  if (persona) setDemoPersona(persona);
  const names: DossierDocName[] = ["previously", "direction"];
  return Promise.all(
    names.map(async (name) => {
      const raw = await fsReadFile(DOSSIER_PATHS[name]).catch(() => null);
      return {
        name,
        ref: `dossier/${name}`,
        available: raw !== null && raw.trim().length > 0,
      };
    }),
  );
}

/**
 * Open a Dossier document: the file's content, verbatim (no frontmatter
 * strip — these two files carry none). A missing document is null, the
 * desk's not-found paper.
 */
export async function getDossierDoc(
  refText: string,
  persona?: string,
): Promise<CaseDocContent | null> {
  if (persona) setDemoPersona(persona);
  const parsed = parseDossierRef(refText);
  if (!parsed) return null;
  const raw = await fsReadFile(DOSSIER_PATHS[parsed.name]).catch(() => null);
  if (raw === null || raw.trim().length === 0) return null;
  return {
    ref: refText,
    opened: "",
    closed: null,
    markdown: raw.trim(),
    warnings: [],
  };
}
