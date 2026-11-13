/** Final-storage budgets. Characters are Unicode code points, never UTF-16 units. */
import { WriteRefusal } from "./write-window";

export interface DocumentSize { characters: number; bytes: number; lines: number }
export const DOCUMENT_LIMITS: DocumentSize = { characters: 12_000, bytes: 48 * 1024, lines: 400 };
export const DOCUMENT_SOFT_LIMITS: DocumentSize = { characters: 4_000, bytes: 12 * 1024, lines: 100 };
export const TAIL_ENTRY_LIMITS: DocumentSize = { characters: 600, bytes: 2 * 1024, lines: 6 };
export const TAIL_TOTAL_LIMITS: DocumentSize = { characters: 2_000, bytes: 8 * 1024, lines: 80 };
export function documentSize(text: string): DocumentSize {
  let characters = 0;
  for (const _character of text) { void _character; characters++; }
  // A terminating newline ends the last line; it does not create an extra empty line.
  const breaks = text.match(/\r\n|\r|\n/g)?.length ?? 0;
  return { characters, bytes: new TextEncoder().encode(text).length,
    lines: text.length === 0 ? 0 : breaks + (/\r$|\n$/.test(text) ? 0 : 1) };
}
export function exceededSize(size: DocumentSize, limits = DOCUMENT_LIMITS): (keyof DocumentSize)[] {
  return (Object.keys(limits) as (keyof DocumentSize)[]).filter((key) => size[key] > limits[key]);
}
/** Exact canonical storage grammar, including date-only ids; substring matches are unsafe. */
export function isConversationRecordPath(path: string): boolean {
  // Uploaded source bytes belong to the record, not the authored-document lane.
  const attachment = /^(memory\/records\/\d{4}\/\d{2}\/\d{2}(?:\/\d{4})?)\/attachments\/[^/\\]+$/.exec(path);
  if (attachment) return isConversationRecordPath(`${attachment[1]}/core.md`);
  const match = /^memory\/records\/(\d{4})\/(\d{2})\/(\d{2})(?:\/(\d{4}))?\/(?:core|agent|previously)\.md$/.exec(path);
  if (!match) return false;
  const [year, month, day, time] = match.slice(1, 5);
  const date = new Date(`${year}-${month}-${day}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === `${year}-${month}-${day}` &&
    (!time || (Number(time.slice(0, 2)) < 24 && Number(time.slice(2)) < 60));
}
export function isAuthoredDocumentPath(path: string): boolean {
  return path.startsWith("memory/") && !path.startsWith("memory/episodic/") &&
    /\.md$/i.test(path) && !isConversationRecordPath(path);
}
export class DocumentFullRefusal extends WriteRefusal {
  readonly details: { path: string; current: DocumentSize | null; candidate: DocumentSize;
    limits: DocumentSize; exceeded: (keyof DocumentSize)[]; recovery: string[] };
  constructor(path: string, candidate: string, previous: string | null = null, limits = DOCUMENT_LIMITS) {
    const details = { path, current: previous === null ? null : documentSize(previous), candidate: documentSize(candidate),
      limits, exceeded: exceededSize(documentSize(candidate), limits),
      recovery: ["Read the target and relevant existing pieces.", "Write a focused new piece/continuation; a full index does not prevent adding a piece.",
        "For an existing oversized document, use evidence-backed reorganize with a lossless history archive; do not overwrite settled prose."] };
    if (path === "memory/people/user/index.md") details.recovery = [
      "Keep the stored runtime model intact. Shorten the proposed card/direction through the existing evolution mutations; preserve qualifications and records evidence. Independently useful evidence can live in a focused case rather than being copied into the model.",
      "If the stored model itself is oversized, HQ must readCase people/user and actual raw records, then call reorganizeUserModel (bounded card/direction, optional focused pieces, evidence). Its complete prior model is archived before replacement; then resume evolveProfile.",
      "The user's own people/user/profile.md is a separate user-owned document and must not be rewritten by this recovery.",
    ];
    super("document_full", `document_full: ${JSON.stringify(details)}`);
    this.details = details;
  }
}
export function assertDocumentWrite(path: string, candidate: string, previous: string | null = null, maintenance = false): void {
  if (!isAuthoredDocumentPath(path) || candidate === previous) return;
  const size = documentSize(candidate);
  const before = previous === null ? null : documentSize(previous);
  if (before && exceededSize(before).length) {
    const decreases = (Object.keys(size) as (keyof DocumentSize)[]).every((key) => size[key] <= before[key]) &&
      (Object.keys(size) as (keyof DocumentSize)[]).some((key) => size[key] < before[key]);
    if (maintenance && decreases) return;
    throw new DocumentFullRefusal(path, candidate, previous);
  }
  if (exceededSize(size).length) throw new DocumentFullRefusal(path, candidate, previous);
}
export function assertTailBudget(path: string, line: string, completeTail: string): void {
  if (exceededSize(documentSize(line), TAIL_ENTRY_LIMITS).length) throw new DocumentFullRefusal(path, line, null, TAIL_ENTRY_LIMITS);
  if (exceededSize(documentSize(completeTail), TAIL_TOTAL_LIMITS).length) throw new DocumentFullRefusal(path, completeTail, null, TAIL_TOTAL_LIMITS);
}
export const DOCUMENT_BUDGET_RULE = "Final authored files (including metadata/history) must fit 12,000 Unicode code points, 48 KiB UTF-8 and 400 lines. " +
  "A tail adds only 1–2 conclusion sentences plus records references (600 characters/2 KiB/6 lines per addition; 2,000 characters/8 KiB/80 lines total). " +
  "Do not reproduce conversation in reports. Reuse a fully read existing product when it covers the claim; the same source may support different reading purposes. " +
  "document_full is recoverable: create a focused piece/continuation, or explicitly reorganize with a preserved source archive. Never truncate source material.";
