import { parseCaseRef, resolveCaseRefPaths, type CaseRef } from "./case-refs";
import { archiveCaseDirPath } from "./paths";

export const ARCHIVE_NOTE_NAME = "_ARCHIVED.md";

/** For a missing piece, the owner's archived index shadows unrelated legacy fallbacks. */
export function archivedCaseRefPaths(ref: string | CaseRef): string[] {
  const parsed = typeof ref === "string" ? parseCaseRef(ref) : ref;
  if (!parsed || parsed.kind === "legacy") return [];
  const directory = archiveCaseDirPath(parsed.category, parsed.caseName);
  const index = `${directory}/index.md`;
  return parsed.kind === "case" ? [index] : [`${directory}/${parsed.pieceFileName}`, index];
}

export function casePaperLookup(ref: CaseRef) {
  const [active, ...fallbacks] = resolveCaseRefPaths(ref);
  const archived = archivedCaseRefPaths(ref);
  return { paths: [active!, ...archived, ...fallbacks], historicalPath: archived[0], missingPieceMarker: archived[1] };
}

export function archiveNotePath(historicalPath: string): string {
  return historicalPath.slice(0, historicalPath.lastIndexOf("/") + 1) + ARCHIVE_NOTE_NAME;
}

/** The reason is author's Markdown; keep its links and discard the archive note's header. */
export function archiveNoteBody(raw: string): string {
  return raw.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "").trim();
}
