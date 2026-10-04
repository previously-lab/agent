/**
 * Case naming red line (v0.19 §B.2, 主 agent 裁决版) — the rule平移自 v0.15
 * `naming.ts`, scoped to the TITLE segment.
 *
 * Why: slice ids live in the `YYYY-MM-DD-HHMM` namespace; a case name or
 * piece name must never be parseable as one. A dated name
 * `<出生日期>-<标题>` can never collide when its date is a real calendar
 * date and the TITLE segment is not four digits — `research/2026-11-05-屏幕
 * 供应商` is safe, while `research/2026-11-05-1430` would BE a slice-id
 * shape and is barred. So:
 *
 * - dated case names (`<YYYY-MM-DD>-<标题>`) and piece names
 *   (`<YYYY-MM-DD>-<标题>.md`): the TITLE may not start with four digits.
 * - plain names (`people/陈勇超`, `self/search`, …): the WHOLE name may
 *   not start with four digits.
 *
 * `isValidCaseName` / `isValidPieceFileName` are callable enforcement
 * points: the path builders in `paths.ts` and the write ops in
 * `case-doc.ts` validate through them, so an illegal name is refused
 * BEFORE it can reach the filesystem.
 */
import { isValidDate } from "./naming";

/** Characters/conditions that can never appear in any name component. */
function hasUnsafeShape(name: string): boolean {
  return (
    name.length === 0 ||
    name !== name.trim() ||
    name.includes("/") ||
    name.includes("\\") ||
    name.includes("\0") ||
    name === "." ||
    name === ".." ||
    name.includes("..")
  );
}

/** The red line: a 4-digit-leading TITLE could complete a slice-id shape. */
export function startsWithFourDigits(name: string): boolean {
  return /^\d{4}/.test(name);
}

/**
 * Is `caseName` legal? Two shapes, both ruled:
 *
 * - dated: `<YYYY-MM-DD>-<标题>` — a real calendar date and a non-empty
 *   title not starting with four digits (the title is where the red line
 *   bites; `2026-11-05-屏幕供应商` is a legal case name);
 * - plain (`people/陈勇超`, `self/search`): any non-empty name not
 *   starting with four digits.
 *
 * Both shapes forbid path separators / traversal / surrounding whitespace.
 */
export function isValidCaseName(caseName: string): boolean {
  if (typeof caseName !== "string") return false;
  if (hasUnsafeShape(caseName)) return false;
  const dated = /^(\d{4}-\d{2}-\d{2})-(.+)$/.exec(caseName);
  if (dated) {
    const [, date, title] = dated;
    if (!isValidDate(date)) return false;
    if (hasUnsafeShape(title)) return false;
    if (startsWithFourDigits(title)) return false;
    return true;
  }
  if (startsWithFourDigits(caseName)) return false;
  return true;
}

/**
 * Is `fileName` a legal piece name? `<出生日期>-<标题>.md` — a real
 * calendar date, a non-empty title that does not start with four digits,
 * no path separators / traversal / whitespace anywhere. (`index.md` is not
 * a piece — it is validated simply as a fixed file name.)
 */
export function isValidPieceFileName(fileName: string): boolean {
  if (typeof fileName !== "string" || !fileName.endsWith(".md")) return false;
  const stem = fileName.slice(0, -".md".length);
  if (hasUnsafeShape(stem) || stem.includes(".md")) return false;
  const m = /^(\d{4}-\d{2}-\d{2})-(.+)$/.exec(stem);
  if (!m) return false;
  const [, date, title] = m;
  if (!isValidDate(date)) return false;
  if (hasUnsafeShape(title)) return false;
  if (startsWithFourDigits(title)) return false;
  return true;
}

export interface ParsedPieceName {
  /** Birth date, taken from the name (same-source rule, §B.3). */
  date: string;
  title: string;
}

/** Split a legal piece name into date + title; null when illegal. */
export function parsePieceFileName(fileName: string): ParsedPieceName | null {
  if (!isValidPieceFileName(fileName)) return null;
  const m = /^(\d{4}-\d{2}-\d{2})-(.+)\.md$/.exec(fileName)!;
  return { date: m[1], title: m[2] };
}

/**
 * Build a piece file name, validating through `isValidPieceFileName`;
 * throws on an illegal result. `date` and `title` come from the SAME
 * caller variables that seed `opened` (§B.3 同源写入规则).
 */
export function buildPieceFileName(date: string, title: string): string {
  const fileName = `${date}-${title}.md`;
  if (!isValidPieceFileName(fileName)) {
    throw new Error(
      `Illegal piece file name: ${JSON.stringify(fileName)} — ` +
        `need <YYYY-MM-DD>-<标题>.md with a real date and a title not starting with four digits`,
    );
  }
  return fileName;
}
