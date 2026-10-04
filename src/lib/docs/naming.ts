/**
 * Document file-name discipline (v0.15 design §2.1, §5).
 *
 * The file name IS the identity — set at birth, never renamed, moved,
 * deleted, or reused. There is no separate id system.
 *
 * Two shapes:
 *   - dated kinds: `<出生日期>-<标题>.md`  (e.g. `2026-09-05-手机购买调研.md`)
 *   - `topic`:     `<名字>.md`             (e.g. `用户手机.md`)
 *
 * The structural red line lives HERE: a document file name must never pass
 * the slice-id validation (`YYYY-MM-DD-HHMM`). For dated docs the date prefix
 * is followed by `-`, and the title may not START with four digits — so
 * `2026-09-05-1234.md` (a slice-id shape) is rejected. Topic names obey the
 * same no-4-digit-leading rule so no document file name can ever collide
 * with the slice namespace. `isValidDocFileName` is the single enforcement
 * point future writers call to refuse illegal names.
 */
import { DATED_DOC_KINDS, type DocKind } from "./types";

/** Slice-id shape (kept for reference/documentation; see isValidDocFileName). */
export const SLICE_ID_PATTERN = /^\d{4}-\d{2}-\d{2}-\d{4}$/;

/** A real calendar day in YYYY-MM-DD form (rejects 2026-13-40 etc.). */
export function isValidDate(date: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return (
    dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d
  );
}

/** Characters that can never appear inside any file-name component. */
export function hasUnsafeChars(name: string): boolean {
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

/**
 * Purify a user-derived name component into a safe file-name fragment — the
 * SAME unsafe-chars discipline `hasUnsafeChars` validates (separators, NUL,
 * `.`/`..`, edge whitespace), widened to the control range and the
 * windows-forbidden set, applied as REPLACEMENT because the input is derived
 * user input, not an identity the system chose. Every unsafe run becomes one
 * `-`; repeats and edge dots/spaces collapse; the result is capped at 120
 * chars. May return "" when nothing survives — the caller owns the fallback.
 * This is the single source of the sanitize list (the attachments module
 * used to mirror it).
 */
export function sanitizeNameComponent(raw: string): string {
  return raw
    .normalize("NFKC")
    .replace(/[/\\\0-\x1f<>:"|?*]+/g, "-")
    .replace(/\.\.+/g, ".")
    .replace(/^[.\s]+|[.\s]+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 120);
}

/**
 * The one naming rule that guards the slice-id namespace: a title (or topic
 * name) must not begin with four digits. `2026-09-05-1234.md` would otherwise
 * parse as born 2026-09-05 titled "1234" and be indistinguishable from a
 * slice id at a glance; more generally a 4-digit-leading title is how a doc
 * name could ever match `YYYY-MM-DD-HHMM`-style shapes.
 */
export function startsWithFourDigits(title: string): boolean {
  return /^\d{4}/.test(title);
}

/**
 * Is `fileName` a legal document file name?
 *
 * - dated kinds: `<YYYY-MM-DD>-<标题>.md` — real calendar date, non-empty
 *   title, title must not start with four digits (see above).
 * - `topic`: `<名字>.md` — non-empty name, also no four-digit lead.
 * - All kinds: `.md` suffix, no path separators / traversal / surrounding
 *   whitespace.
 *
 * This function is the enforcement point: writers MUST validate through it
 * before creating a document, so an illegal name can never land on disk.
 */
export function isValidDocFileName(fileName: string, kind: DocKind): boolean {
  if (typeof fileName !== "string" || !fileName.endsWith(".md")) return false;
  const stem = fileName.slice(0, -".md".length);
  if (hasUnsafeChars(stem) || stem.includes(".md")) return false;

  if (kind === "topic") {
    return !startsWithFourDigits(stem);
  }

  if (!(DATED_DOC_KINDS as readonly string[]).includes(kind)) return false;
  const m = /^(\d{4}-\d{2}-\d{2})-(.+)$/.exec(stem);
  if (!m) return false;
  const [, date, title] = m;
  if (!isValidDate(date)) return false;
  if (hasUnsafeChars(title)) return false;
  if (startsWithFourDigits(title)) return false;
  return true;
}

export interface ParsedDocFileName {
  /** Birth date for dated kinds; null for topic. */
  date: string | null;
  /** Title for dated kinds; the name for topic. */
  title: string;
}

/**
 * Split a known-valid file name into its parts. Returns null when the name
 * is illegal for the kind — callers that already validated can rely on the
 * non-null shape, tolerant readers should check.
 */
export function parseDocFileName(
  fileName: string,
  kind: DocKind,
): ParsedDocFileName | null {
  if (!isValidDocFileName(fileName, kind)) return null;
  const stem = fileName.slice(0, -".md".length);
  if (kind === "topic") return { date: null, title: stem };
  const m = /^(\d{4}-\d{2}-\d{2})-(.+)$/.exec(stem)!;
  return { date: m[1], title: m[2] };
}

/**
 * Build the file name for a new document. Validates through
 * `isValidDocFileName` and throws on an illegal result — the writer's
 * last-resort guard so a bad title fails at write time, never on disk.
 */
export function buildDocFileName(kind: DocKind, date: string, title: string): string {
  const fileName =
    kind === "topic" ? `${title}.md` : `${date}-${title}.md`;
  if (!isValidDocFileName(fileName, kind)) {
    throw new Error(`Illegal document file name for kind "${kind}": ${JSON.stringify(fileName)}`);
  }
  return fileName;
}
