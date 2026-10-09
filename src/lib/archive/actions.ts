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
import { setDemoPersona } from "@/lib/demo/demo-fs";

/** One pile in the archive field — one case. */
export interface ArchivePile {
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
 * for its header and piece list. Missing category directories list as empty
 * (pre-migration is a normal state — the shelf's own rule).
 */
export async function getArchiveField(
  persona?: string,
): Promise<ArchiveFieldData> {
  if (persona) setDemoPersona(persona);

  const perCategory = await Promise.all(
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
  );

  return { piles: perCategory.flat() };
}
