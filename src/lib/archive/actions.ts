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
  parseCaseRef,
  parsePieceFileName,
  resolveCaseRefPaths,
  type CaseCategory,
} from "@/lib/docs";
import { fsListFiles, fsReadFile, fsFileModifiedDate } from "@/lib/episodic/io-helpers";
import { enumerateSliceIds, enumerateTreePaths } from "@/lib/episodic/timeline/enumerate";
import { sliceEntryFromDisk } from "@/lib/episodic/timeline/store";
import {
  getSliceContent,
  type CaseDocContent,
} from "@/lib/episodic/actions";
import {
  parseDossierRef,
  parseRecordRef,
  ROOM_PAPER_LIMIT,
  type DossierDocName,
  type RecordSpeakerLabels,
} from "./refs";
import { stampSliceIds } from "./ref-tokens";
import { HOTEL_WINDOW_DOORS } from "@/lib/game/hotel-data";
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

// ─── THE LIGHT INDEX (perf pass 2026-10-12) ────────────────────────────────
//
// First paint asks a LIST question — "what exists, and how much of it" — and
// one recursive tree enumeration answers it with ZERO file reads. Dates are
// derived from what the paths already carry (a case's newest piece date; a
// slice id's own date); a case that needs its index.md read for `opened` is
// left undated here and hydrated later, in bounded chunks, by getCaseHeaders.

export interface ArchiveIndexCase {
  category: CaseCategory;
  name: string;
  /** Newest piece date from the pieces' file names; "" (undated) when the
   *  case carries no pieces — the caller hydrates it via getCaseHeaders. */
  updated: string;
  /** The index plus its pieces — the pile's sheet count. */
  pages: number;
}

export interface ArchiveIndex {
  cases: ArchiveIndexCase[];
  /** Every slice id ("YYYY-MM-DD-HHMM"), both roots merged, deduped. */
  sliceIds: string[];
}

export async function getArchiveIndex(): Promise<ArchiveIndex> {
  const paths = await enumerateTreePaths("memory");
  const catSet = new Set<string>(CASE_CATEGORIES as readonly string[]);
  const byRef = new Map<string, ArchiveIndexCase>();
  const pieceDates = new Map<string, string>();
  const pieceCounts = new Map<string, number>();
  const sliceIds = new Set<string>();

  for (const p of paths) {
    const seg = p.split("/");
    if (seg[0] !== "memory") continue;
    const cat = seg[1] ?? "";
    if (catSet.has(cat)) {
      const name = seg[2] ?? "";
      if (seg.length === 4 && seg[3] === "index.md" && isValidCaseName(name)) {
        const ref = `${cat}/${name}`;
        if (!byRef.has(ref)) {
          byRef.set(ref, {
            category: cat as CaseCategory,
            name,
            updated: "",
            pages: 1,
          });
        }
      } else if (
        seg.length === 4 &&
        isValidCaseName(name) &&
        isValidPieceFileName(seg[3])
      ) {
        const ref = `${cat}/${name}`;
        const d = parsePieceFileName(seg[3])?.date ?? "";
        if (d && d > (pieceDates.get(ref) ?? "")) pieceDates.set(ref, d);
        pieceCounts.set(ref, (pieceCounts.get(ref) ?? 0) + 1);
      }
      continue;
    }
    let rel = "";
    if (cat === "records") rel = seg.slice(2, 6).join("/");
    else if (cat === "episodic" && seg[2] === "slices") {
      rel = seg.slice(3, 7).join("/");
    }
    if (/^\d{4}\/\d{2}\/\d{2}\/\d{4}$/.test(rel)) {
      sliceIds.add(rel.replaceAll("/", "-"));
    }
  }

  const cases = [...byRef.values()].map((c) => {
    const ref = `${c.category}/${c.name}`;
    return {
      ...c,
      updated: pieceDates.get(ref) ?? "",
      pages: 1 + (pieceCounts.get(ref) ?? 0),
    };
  });
  return { cases, sliceIds: [...sliceIds].sort() };
}

/**
 * Bounded header hydration for the undated cases: read just the given refs'
 * `index.md` heads (hard cap 32 per call). The caller chunks its refs so a
 * 300-case tree hydrates progressively instead of blocking anything.
 */
export async function getCaseHeaders(
  refs: string[],
): Promise<Array<{ ref: string; opened: string }>> {
  const heads = await Promise.all(
    refs
      .slice(0, 32)
      .map(async (ref): Promise<{ ref: string; opened: string } | null> => {
        const slash = ref.indexOf("/");
        if (slash <= 0 || ref.indexOf("/", slash + 1) !== -1) return null;
        const category = ref.slice(0, slash);
        const name = ref.slice(slash + 1);
        if (
          !(CASE_CATEGORIES as readonly string[]).includes(category) ||
          !isValidCaseName(name)
        ) {
          return null;
        }
        try {
          const raw = await fsReadFile(
            caseIndexPath(category as CaseCategory, name),
          );
          const doc = parseCaseDoc(raw, {
            category: category as CaseCategory,
            caseName: name,
            fileName: "index.md",
          });
          return { ref, opened: doc.opened };
        } catch {
          // a missing index is not a header — the pile keeps its undated look
          return null;
        }
      }),
  );
  return heads.filter((h): h is { ref: string; opened: string } => h !== null);
}

/** The light records list (the switch's and the library's first paint): ids
 *  and derived dates only. `turns` is reported as 1 so the bucket thickness
 *  reads as "sheets in the bucket" rather than a turn census — the census
 *  cost a read per slice and was the field's largest single expense. */
export async function getArchiveRecordIndex(): Promise<ArchiveRecord[]> {
  const { sliceIds } = await getArchiveIndex();
  return sliceIds.map((id) => ({ sliceId: id, date: id.slice(0, 10), turns: 1 }));
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

/**
 * The record index WITHOUT the case aggregation (v0.28): the record switch
 * — the open transcript's bucket siblings — needs the slice list, not the
 * piles, so it does not pay for the field's whole read. Same enumeration
 * and bounded header reads as the field's own; the bucketing itself is the
 * model's (`recordSiblings`, client-side — the bucket frame's NOW is the
 * reader's local day).
 */
export async function getArchiveRecords(
  persona?: string,
): Promise<ArchiveRecord[]> {
  if (persona) setDemoPersona(persona);
  return readArchiveRecords();
}

/** The `records/<sliceId>` grammar lives in `./refs` (pure — this module is
 *  `"use server"` and may export only async functions). */

export interface RecordDocContent extends CaseDocContent {
  sliceId: string;
  turnCount: number;
  /** The slice's recorded timezone — the record paper's letterhead prints
   *  it next to the wall clock derived from the slice id. */
  timezone: string;
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
    timezone: slice.timezone,
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
  // The letterhead's date line is the file's last write where the backend
  // has one (local mtime; null on GitHub/demo — the line is then omitted,
  // never a placeholder).
  const [raw, modified] = await Promise.all([
    fsReadFile(DOSSIER_PATHS[parsed.name]).catch(() => null),
    fsFileModifiedDate(DOSSIER_PATHS[parsed.name]),
  ]);
  if (raw === null || raw.trim().length === 0) return null;
  return {
    ref: refText,
    opened: modified ?? "",
    closed: null,
    markdown: raw.trim(),
    warnings: [],
  };
}

// ─── Reference liveness (v0.22 §7) — the paper's link pass ─────────────────
// The desk's tokenizer (archive/ref-tokens.ts, pure) finds the candidate
// refs; THIS action answers the only question the paper asks of the server:
// which of them name a document that EXISTS. Only alive refs render as
// links — a dead one stays plain text under a dotted hairline (visible,
// never blocking — the case-refs axiom). Reads reuse the same paths the
// opens use: the case grammar's dual-root candidate list, the slice store,
// the Dossier table.

/** One candidate's verdict. `kind` is the ref's vocabulary (refs.ts routes
 *  records/dossiers before the case grammar); `door` is set for LIVE record
 *  refs only — the slice's date plus whether it stands inside the hotel's
 *  door window (HOTEL_WINDOW_DOORS), which is what the paper's place line
 *  prints from. */
export interface VerifiedRef {
  ref: string;
  kind: "case" | "piece" | "legacy" | "record" | "dossier";
  alive: boolean;
  door?: { date: string; inHotelWindow: boolean };
}

/** First readable path of a candidate list, or null — the same probe the
 *  shelf's reads run (episodic keeps its own private copy; a "use server"
 *  module may not export sync helpers, so the six lines live here too). */
async function firstExisting(paths: readonly string[]): Promise<boolean> {
  for (const path of paths) {
    const raw = await fsReadFile(path).catch(() => null);
    if (raw !== null) return true;
  }
  return false;
}

/**
 * Verify a batch of candidate refs. Bounded (the desk's tokenizer can fill
 * a long document — the cap keeps one open from fanning out unbounded
 * probes); duplicates collapse before any read. The slice enumeration runs
 * AT MOST ONCE per call, and only when a live record ref needs its window
 * rank.
 */
export async function verifyRefs(
  refs: string[],
  persona?: string,
): Promise<VerifiedRef[]> {
  if (persona) setDemoPersona(persona);
  const unique = [...new Set(refs)].slice(0, 64);

  const results = await mapLimited(unique, ARCHIVE_READ_CONCURRENCY, async (ref) => {
    const record = parseRecordRef(ref);
    if (record) {
      const entry = await sliceEntryFromDisk(
        record.sliceId.split("-").join("/"),
      ).catch(() => null);
      return {
        ref,
        kind: "record" as const,
        alive: entry !== null,
        // The window rank resolves below, once, across the batch.
        door: entry ? { date: entry.date, inHotelWindow: false } : undefined,
      };
    }
    const dossier = parseDossierRef(ref);
    if (dossier) {
      const raw = await fsReadFile(DOSSIER_PATHS[dossier.name]).catch(() => null);
      return {
        ref,
        kind: "dossier" as const,
        alive: raw !== null && raw.trim().length > 0,
      };
    }
    const parsed = parseCaseRef(ref);
    if (!parsed) return { ref, kind: "case" as const, alive: false };
    return {
      ref,
      kind: parsed.kind,
      alive: await firstExisting(resolveCaseRefPaths(parsed)),
    };
  });

  // The hotel window's membership: the newest HOTEL_WINDOW_DOORS slices have
  // doors (game-shell derives its corridor from the same constant). One
  // enumeration per call, only when live records ask for it.
  if (results.some((r) => r.kind === "record" && r.alive)) {
    const rels = await enumerateSliceIds().catch(() => [] as string[]);
    const newestFirst = rels
      .map((rel) => rel.split("/").join("-"))
      .sort((a, b) => b.localeCompare(a));
    const rank = new Map(newestFirst.map((id, i) => [id, i]));
    for (const r of results) {
      if (r.kind !== "record" || !r.door) continue;
      const rankOf = rank.get(parseRecordRef(r.ref)!.sliceId);
      r.door.inHotelWindow =
        rankOf !== undefined && rankOf < HOTEL_WINDOW_DOORS;
    }
  }

  return results;
}

// ─── The room's papers (v0.25a §五) — a slice's documents, found ───────────
// A hotel room IS a slice; the papers lying in it are the documents that
// carry that slice's evidence stamp (`(refs: <sliceId>)`, the tokenizer's
// stamp harvest) plus the slice's OWN record paper. Read-only, verbatim
// refs — the desk opens them unchanged.

/** One paper lying in a room. `title` is the glanceable line (the cover
 *  discipline: case name / piece title / the record's slice id). */
export interface RoomPaper {
  ref: string;
  kind: "record" | "case" | "piece";
  title: string;
  /** Birth date (the piece filename's / the index header's), "" when none. */
  date: string;
}

/** Does this document's text stamp the slice? Reads the body once. */
function stampsSlice(markdown: string, sliceId: string): boolean {
  return stampSliceIds(markdown).includes(sliceId);
}

/** One case directory → the papers its documents earn in this slice's room
 *  (usually none). The index and the pieces read in parallel; a document
 *  whose text never stamps the slice earns nothing. */
async function readRoomPapersOfCase(
  category: CaseCategory,
  name: string,
  sliceId: string,
): Promise<RoomPaper[]> {
  const dirEntries = await fsListFiles(caseDirPath(category, name)).catch(
    () => [],
  );
  const pieceNames = dirEntries
    .filter(
      (e) =>
        e.type === "file" &&
        e.name !== "index.md" &&
        e.name.endsWith(".md") &&
        isValidPieceFileName(e.name),
    )
    .map((e) => e.name);

  const fileNames = ["index.md", ...pieceNames];
  const raws = await mapLimited(fileNames, 4, (fileName) =>
    fsReadFile(`${caseDirPath(category, name)}/${fileName}`).catch(() => null),
  );

  const out: RoomPaper[] = [];
  for (let i = 0; i < fileNames.length; i++) {
    const raw = raws[i];
    if (raw === null || !stampsSlice(raw, sliceId)) continue;
    const fileName = fileNames[i];
    if (fileName === "index.md") {
      const doc = parseCaseDoc(raw, { category, caseName: name, fileName });
      out.push({
        ref: `${category}/${name}`,
        kind: "case",
        title: name,
        date: doc.opened,
      });
    } else {
      const piece = parsePieceFileName(fileName);
      // The desk's piece ref names the STEM (the shelf's pieceRef rule —
      // the parser appends the suffix).
      out.push({
        ref: `${category}/${name}/${fileName.replace(/\.md$/, "")}`,
        kind: "piece",
        title: piece?.title ?? fileName.replace(/\.md$/, ""),
        date: piece?.date ?? "",
      });
    }
  }
  return out;
}

/**
 * The papers lying in a slice's room: the slice's own record first (the room
 * always has its transcript — the room exists because the slice does), then
 * the newest stamped case documents, capped at ROOM_PAPER_LIMIT. An illegal
 * slice id earns nothing (the red line's shape is the whole validation).
 */
export async function getRoomPapers(
  sliceId: string,
  persona?: string,
): Promise<RoomPaper[]> {
  if (persona) setDemoPersona(persona);
  if (!parseRecordRef(`records/${sliceId}`)) return [];

  const perCategory = await Promise.all(
    CASE_CATEGORIES.map(async (category) => {
      const entries = await fsListFiles(`memory/${category}`).catch(() => []);
      const names = entries
        .filter((e) => e.type === "dir" && isValidCaseName(e.name))
        .map((e) => e.name);
      const perCase = await mapLimited(names, ARCHIVE_READ_CONCURRENCY, (name) =>
        readRoomPapersOfCase(category, name, sliceId),
      );
      return perCase.flat();
    }),
  );

  const stamped = perCategory
    .flat()
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, ROOM_PAPER_LIMIT - 1);

  return [
    {
      ref: `records/${sliceId}`,
      kind: "record",
      title: sliceId,
      date: sliceId.slice(0, 10),
    },
    ...stamped,
  ];
}
