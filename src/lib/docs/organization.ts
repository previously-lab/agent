/** Small, pure helpers for choosing and linking a document's reading home. */
import { formatDocumentLink } from "@/lib/documents/document-link";
import { buildPieceFileName, parsePieceFileName } from "./case-naming";
import { caseDirPath, casePiecePath, type CaseCategory } from "./paths";
import { isHistoryArchiveFileName } from "./history-archive";

export interface CasePieceCatalogEntry {
  ref: string;
  title: string;
  date: string;
  read: boolean;
}

/** readRefs comes only from run-local full-read receipts, never the listing. */
export function casePieceCatalog(input: {
  category: CaseCategory;
  caseName: string;
  paths: readonly string[] | null;
  readRefs?: ReadonlySet<string>;
}): CasePieceCatalogEntry[] | null {
  if (input.paths === null) return null;
  const prefix = `${caseDirPath(input.category, input.caseName)}/`;
  return [...new Set(input.paths)].flatMap((path) => {
    if (!path.startsWith(prefix) || isHistoryArchiveFileName(path)) return [];
    const piece = parsePieceFileName(path.slice(prefix.length));
    if (!piece) return [];
    const ref = path.slice("memory/".length, -".md".length);
    return [{ ...piece, ref, read: input.readRefs?.has(ref) === true }];
  }).sort((a, b) => a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0);
}

export function renderCasePieceCatalog(entries: CasePieceCatalogEntry[] | null): string {
  if (entries === null) return "CASE PIECES — inventory unavailable; do not infer that no pieces exist.";
  const heading = "CASE PIECES — titles are reading pointers, not evidence or read receipts. Read relevant unread pieces before reusing their content or adding another.";
  if (entries.length === 0) return `${heading}\n(no dated pieces listed)`;
  return `${heading}\n${entries.map((entry) =>
    `- ${entry.ref} — ${entry.title} (${entry.date}; ${entry.read ? "full read in this run" : "UNREAD in this run"})`,
  ).join("\n")}`;
}

/** A canonical navigable pointer, generated only for a validated piece identity. */
export function casePieceNavigation(input: {
  category: CaseCategory;
  caseName: string;
  date: string;
  title: string;
}): { ref: string; line: string } {
  const fileName = buildPieceFileName(input.date, input.title);
  const path = casePiecePath(input.category, input.caseName, fileName);
  const ref = path.slice("memory/".length, -".md".length);
  const href = formatDocumentLink(ref);
  if (!href) throw new Error("The piece identity cannot be represented by a semantic document link");
  const label = input.title.replace(/[\\[\]]/g, "\\$&");
  return { ref, line: `[${label}](${href})` };
}

/** Opening + first piece need two authored texts; never silently copy one twice. */
export function caseOpeningBody(input: {
  category: CaseCategory;
  caseName: string;
  date: string;
  body: string;
  pieceTitle?: string;
  overviewBody?: string;
}): string {
  const body = input.body.trim();
  if (!body) throw new Error("body must not be empty");
  if (!input.pieceTitle) return body;
  const overview = input.overviewBody?.trim();
  if (!overview || overview === body) {
    throw new Error("Opening a case with a first piece requires a distinct overviewBody: introduce the case and its reading purpose; body belongs to the piece. Do not copy the piece into the overview.");
  }
  const { line } = casePieceNavigation({ ...input, title: input.pieceTitle });
  return overview.includes(line) ? overview : `${overview}\n\n${line}`;
}
