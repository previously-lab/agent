/** Document measurements for readable pages and lossless archive shards. Characters are Unicode code points, never UTF-16 units. */
import { isArchivedCaseStoragePath } from "./paths";

export interface DocumentSize { characters: number; bytes: number; lines: number }
export const DOCUMENT_LIMITS: DocumentSize = { characters: 12_000, bytes: 48 * 1024, lines: 400 };
export const DOCUMENT_SOFT_LIMITS: DocumentSize = { characters: 4_000, bytes: 12 * 1024, lines: 100 };
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
    !path.startsWith("memory/timeline/") && !isArchivedCaseStoragePath(path) &&
    /\.md$/i.test(path) && !isConversationRecordPath(path);
}
export const DOCUMENT_BUDGET_RULE = "Organize documents by reading purpose. Keep dated tail entries focused on new conclusions and their record references. " +
  "Reuse an existing product when it answers the question. Write a separate piece when it has an independent purpose. Preserve the source when reorganizing.";
