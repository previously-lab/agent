import { createHash } from "node:crypto";

export interface TextPageSelection {
  offset?: number;
  revision?: string;
}

/** End at a Unicode character boundary and always consume a character when possible. */
export function textPageEnd(text: string, start: number, size: number): number {
  let end = Math.min(start + size, text.length);
  if (end > start && end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!) && /[\uDC00-\uDFFF]/.test(text[end]!)) {
    end = end - 1 === start ? end + 1 : end - 1;
  }
  return end;
}

/** Stable offsets for the exact rendered selection; keep a Unicode pair together. */
export function readTextPage(text: string, selection: TextPageSelection, pageSize: number) {
  const start = selection.offset ?? 0;
  const revision = createHash("sha256").update(text).digest("hex");
  if (selection.revision && revision !== selection.revision) {
    return { ok: false as const, error: "This selection changed. Start the read again to use its current revision." };
  }
  if (!Number.isSafeInteger(start) || start < 0 || start > text.length) {
    return { ok: false as const, error: "The offset lies outside the selected text." };
  }
  const end = textPageEnd(text, start, pageSize);
  return { ok: true as const, revision, start, end, total: text.length, text: text.slice(start, end) };
}

export function coversEntireText(pages: ReadonlyArray<{ start: number; end: number }>, total: number) {
  let through = 0;
  for (const { start, end } of [...pages].sort((a, b) => a.start - b.start)) {
    if (start > through) return false;
    through = Math.max(through, end);
    if (through === total) return true;
  }
  return false;
}
