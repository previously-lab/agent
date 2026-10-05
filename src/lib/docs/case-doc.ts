/**
 * Case document format + the write-ops (v0.19 §B.3, §D.4; v0.21 write window).
 *
 * On-disk shape (`index.md` and pieces are isomorphic):
 *
 *   ---
 *   opened: 2026-09-05              # birth date (YYYY-MM-DD) — immutable
 *   updated: 2026-09-05T13:22:10.000Z   # last-write stamp (ISO) — restamped
 *   ---                             #   mechanically on EVERY write
 *
 *   正文：一次写完整的完整文本——这份文档当下的全部认识。
 *
 *   —— 尾部 ——
 *   2026-10-02：文中价格已过时，最新见 …。
 *   2026-11-09：供应商部分另开 research/…。
 *
 * Rules (structure, not suggestion):
 * - Header = `opened` + `updated`, nothing else. `updated` is a MACHINE
 *   timestamp (ISO, UTC): the write entry restamps it on every write; the
 *   model never touches it. It anchors the WRITE WINDOW (see
 *   write-window.ts): within the window the 正文 may be rewritten whole;
 *   past it the document grows only by dated tail lines / new pieces.
 * - `closed` is RETIRED (v0.21): no op produces it and no guard consults
 *   it — sealing is the window closing, produced by time alone. The READ
 *   side stays tolerant: a historical `closed:` line parses without error
 *   (surfaced on the parsed doc for readers) and round-trips verbatim — no
 *   migration rewrite of historical files.
 * - Same-source rule: a piece's `opened` and the birth date in its name come
 *   from the same variable — implemented by parsing the name and filling
 *   `opened` from it. On parse, a header/date mismatch is a WARNING and the
 *   NAME (identity) wins.
 * - 正文 is written whole, in one pass. Inside the write window it may be
 *   rewritten freely (`rewriteBody`) — drafts are NOT archived (no history
 *   mechanism, §D.4). Past the window the 正文 is settled; only the tail
 *   grows (`appendTail` — always allowed, inside the window too).
 * - 尾部 = dated supplement lines, one per line, append-only.
 * - Tolerant-parse contract: a broken file always opens — problems become
 *   warnings and unrecognized bytes are preserved verbatim (`preserved`).
 *
 * The ops are PURE (no I/O, no clock). Illegal NAMES still throw here, loud
 * and visible; the TIME guards (write window, optimistic `expectedUpdated`
 * check) live in the write entry (`applyCaseWriteIntent`, librarian.ts),
 * which owns the fresh-read-inside-the-lock and the wall clock.
 */
import matter from "gray-matter";
import { isValidDate } from "./naming";
import {
  buildPieceFileName,
  isValidCaseName,
  parsePieceFileName,
} from "./case-naming";
import type { CaseCategory } from "./paths";

// ─── Types ──────────────────────────────────────────────────────────────────

/** One dated supplement line in the tail. */
export interface TailLine {
  /** YYYY-MM-DD. */
  date: string;
  /** The line's text (after `date：`). */
  text: string;
}

/** A parsed case document (`index.md` or a dated piece). */
export interface CaseDoc {
  /** `index.md`, or `<出生日期>-<标题>.md` for a piece. */
  fileName: string;
  category: CaseCategory;
  caseName: string;
  /**
   * Birth date, RESOLVED per the same-source rule: for a piece it is parsed
   * from the file name (the header cannot disagree — it loses); for
   * `index.md` it comes from the header.
   */
  opened: string;
  /**
   * Last-write stamp (ISO datetime on new writes; a legacy date-only value
   * is tolerated), RESOLVED: the header's `updated`, falling back to
   * `opened` for documents written before the field existed (their last
   * known write is their birth). "" when neither exists — reads as
   * out-of-window everywhere.
   */
  updated: string;
  /**
   * RETIRED (v0.21) — the historical seal date, parse-tolerated and
   * round-tripped verbatim for old files. Never produced by any op, never
   * consulted by any guard: sealing is the write window closing.
   */
  closed: string | null;
  /** 正文 — the complete current text, written whole. */
  body: string;
  /** 尾部 — dated supplement lines, append-only. */
  tail: TailLine[];
  /**
   * Unrecognized bytes kept verbatim (e.g. a legacy v0.15 entry stream),
   * re-emitted unchanged. Empty for clean new-format docs.
   */
  preserved: string;
  /** Parse problems; never fatal. */
  warnings: string[];
}

// ─── Field coercion (same guards as the legacy layer) ──────────────────────

function normalizeString(v: unknown): string {
  if (typeof v === "string") return v;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (v && typeof v === "object") return Object.keys(v)[0] ?? "";
  return "";
}

/**
 * Normalize a date header field to a YYYY-MM-DD string, eating every shape
 * YAML can hand us: a `Date` (UNQUOTED `opened: 2026-10-02` parses as one),
 * a plain string, or a nested object with a `date` key (the v0.18
 * closed-block shape). Returns "" when nothing date-like is there; validity
 * is checked by the caller so bad values degrade to warnings, never
 * exceptions.
 */
function normalizeDateValue(v: unknown): string {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "string") return v;
  if (v && typeof v === "object") {
    return normalizeString((v as Record<string, unknown>).date);
  }
  return "";
}

/**
 * Normalize the `updated` stamp — like normalizeDateValue but PRESERVING the
 * time of day: an unquoted ISO timestamp arrives as a Date and must not be
 * truncated to its date (the write window measures minutes).
 */
function normalizeStampValue(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "string") return v;
  if (v && typeof v === "object") {
    return normalizeStampValue((v as Record<string, unknown>).date);
  }
  return "";
}

const TAIL_MARKER = /^——\s*尾部\s*——\s*$/;
const TAIL_LINE = /^(\d{4}-\d{2}-\d{2})[:：]\s?(.*)$/;
const LEGACY_ENTRY_HEADER = /^## (\d{4}-\d{2}-\d{2})\s*[-—–]\s*(.+?)\s*$/;
const LEGACY_AS_OF = /^>\s*截至\s*(\d{4}-\d{2}-\d{2})\s*[:：]\s*(.*)$/;

// ─── Parse ──────────────────────────────────────────────────────────────────

export interface CaseDocLocation {
  category: CaseCategory;
  caseName: string;
  fileName: string;
}

/**
 * Parse a case document tolerantly. `location` carries the identity the
 * caller learned from the path (category/caseName) plus the file name —
 * the name is the authority for a piece's birth date (same-source rule).
 */
export function parseCaseDoc(raw: string, location: CaseDocLocation): CaseDoc {
  const warnings: string[] = [];
  const { category, caseName, fileName } = location;
  let data: Record<string, unknown> = {};
  let content: string = raw;
  try {
    const parsed = matter(raw);
    data = parsed.data as Record<string, unknown>;
    content = parsed.content;
  } catch {
    warnings.push("frontmatter 解析失败，按无 frontmatter 处理");
  }

  const unknownFields = Object.keys(data).filter(
    (k) => k !== "opened" && k !== "updated" && k !== "closed" && k !== "status",
  );
  if (unknownFields.length > 0) {
    warnings.push(`忽略未知 header 字段: ${unknownFields.join(", ")}`);
  }

  // ── same-source: the name is the authority for a piece's birth date ──
  const pieceName = fileName === "index.md" ? null : parsePieceFileName(fileName);
  if (fileName !== "index.md" && !pieceName) {
    warnings.push(`篇名 "${fileName}" 不合法（需 <YYYY-MM-DD>-<标题>.md）`);
  }
  const headerOpened = normalizeDateValue(data.opened);
  let opened: string;
  if (pieceName) {
    if (headerOpened && headerOpened !== pieceName.date) {
      warnings.push(
        `opened "${headerOpened}" 与篇名出生日期 "${pieceName.date}" 不一致，以篇名为准`,
      );
    }
    opened = pieceName.date;
  } else {
    opened = headerOpened;
    if (!opened) warnings.push("缺少 opened（index.md 的 opened 是唯一出生日期）");
  }
  if (opened && !isValidDate(opened)) {
    warnings.push(`opened "${opened}" 不是合法 YYYY-MM-DD 日期`);
  }

  // ── updated: the last-write stamp (ISO on new writes, legacy date-only
  // tolerated). Absent on every pre-window document — falls back to opened
  // silently (their last known write is their birth); that is history, not
  // a problem, so no warning. A present-but-unparseable value warns and
  // falls back the same way.
  let updated = normalizeStampValue(data.updated);
  if (updated && Number.isNaN(new Date(updated).getTime())) {
    warnings.push(`updated "${updated}" 不是合法时间戳，按 opened 处理`);
    updated = "";
  }
  if (!updated) updated = opened;

  // ── closed (RETIRED, read-tolerant): a historical seal date is parsed and
  // surfaced verbatim, but nothing consults it. Accept Date / string /
  // nested-object shapes; a value that is present but not a valid date
  // warns and reads as absent — visible, never a crash.
  let closed: string | null = null;
  const rawClosed = data.closed;
  if (rawClosed !== undefined && rawClosed !== null && rawClosed !== "") {
    const isLegacyBlock =
      typeof rawClosed === "object" && !(rawClosed instanceof Date);
    const d = normalizeDateValue(rawClosed);
    if (d) {
      if (isLegacyBlock) {
        warnings.push("旧版结案块（含 cause 等字段）已简化为封口日期");
      }
      if (isValidDate(d)) {
        closed = d;
      } else {
        warnings.push(`closed "${d}" 不是合法 YYYY-MM-DD 日期，按无 closed 处理`);
      }
    }
  }

  // Legacy v0.15 three-field header: status — mapped per §D.1. (The legacy
  // `updated` needs no mapping: it parses as the first-class stamp above.)
  const legacyStatus = normalizeString(data.status);
  if (legacyStatus) {
    const legacyUpdated = normalizeString(data.updated);
    if (legacyStatus === "closed" || legacyStatus === "void") {
      if (!closed && legacyUpdated) {
        closed = legacyUpdated;
        warnings.push(
          `旧版 status: ${legacyStatus} 映射为 closed: ${legacyUpdated}（历史封口日期，已退役）`,
        );
      }
    } else {
      warnings.push(`旧版 status: ${legacyStatus} 已忽略（状态标记已退役）`);
    }
  }

  // ── body / tail / preserved, line-walked after the header ──
  const lines = content.replace(/\r\n/g, "\n").split("\n");

  // A legacy `# heading` folds into the body (its text is content, not markup).
  let start = 0;
  while (start < lines.length && lines[start].trim() === "") start += 1;
  if (start < lines.length && /^#\s+/.test(lines[start])) {
    lines[start] = lines[start].replace(/^#\s+/, "");
  }

  // Locate the tail marker; after it, dated lines are tail entries.
  let markerIdx = -1;
  for (let i = start; i < lines.length; i += 1) {
    if (TAIL_MARKER.test(lines[i])) {
      markerIdx = i;
      break;
    }
  }

  // A legacy dated entry stream (v0.15 条目流) is preserved verbatim, and a
  // legacy 截至块 is promoted to the body (§D.1) when there is no body yet.
  let legacyStreamStart = -1;
  for (let i = start; i < (markerIdx >= 0 ? markerIdx : lines.length); i += 1) {
    if (LEGACY_ENTRY_HEADER.test(lines[i])) {
      legacyStreamStart = i;
      break;
    }
  }

  const bodyEnd =
    legacyStreamStart >= 0 ? legacyStreamStart : markerIdx >= 0 ? markerIdx : lines.length;
  const bodyLines: string[] = [];
  const preservedLines: string[] = [];
  for (let i = start; i < bodyEnd; i += 1) {
    const asOf = LEGACY_AS_OF.exec(lines[i]);
    if (asOf && bodyLines.every((l) => l.trim() === "")) {
      bodyLines.push(`截至 ${asOf[1]}：${asOf[2]}`);
      continue;
    }
    bodyLines.push(lines[i]);
  }
  if (legacyStreamStart >= 0) {
    warnings.push("旧版条目流（## <date> — …）原文保留于文末，未映射为尾部");
    for (let i = legacyStreamStart; i < (markerIdx >= 0 ? markerIdx : lines.length); i += 1) {
      preservedLines.push(lines[i]);
    }
  }

  const tail: TailLine[] = [];
  if (markerIdx >= 0) {
    for (let i = markerIdx + 1; i < lines.length; i += 1) {
      const line = lines[i];
      if (line.trim() === "") continue;
      const m = TAIL_LINE.exec(line);
      if (m) {
        tail.push({ date: m[1], text: m[2].trim() });
      } else {
        warnings.push(`尾部存在无法解析的行，原文保留: ${line.slice(0, 40)}`);
        preservedLines.push(line);
      }
    }
  }

  return {
    fileName,
    category,
    caseName,
    opened,
    updated,
    closed,
    body: bodyLines.join("\n").trim(),
    tail,
    preserved: preservedLines.join("\n").trim(),
    warnings,
  };
}

// ─── Serialize ──────────────────────────────────────────────────────────────

/**
 * Serialize back to Markdown: the `opened` + `updated` header (a historical
 * `closed` line round-trips verbatim — read tolerance, never a new seal),
 * the body, the tail (under its marker), and any preserved bytes verbatim
 * at the end. Emits ONLY the new shape — a doc that round-trips here is
 * new-format on disk (legacy bytes in `preserved` excepted).
 */
export function serializeCaseDoc(doc: CaseDoc): string {
  const fm: Record<string, unknown> = {};
  if (doc.opened) fm.opened = doc.opened;
  if (doc.updated) fm.updated = doc.updated;
  if (doc.closed) fm.closed = doc.closed;

  const parts: string[] = [doc.body];
  if (doc.tail.length > 0) {
    parts.push(
      "—— 尾部 ——\n" + doc.tail.map((t) => `${t.date}：${t.text}`).join("\n"),
    );
  }
  if (doc.preserved) parts.push(doc.preserved);
  return matter.stringify(parts.filter((p) => p.trim() !== "").join("\n\n") + "\n", fm);
}

// ─── The write-ops (pure; illegal names throw — time guards live in the
//     write entry, which owns the clock and the locked fresh read) ──────────

function assertDate(date: string, field: string): void {
  if (!isValidDate(date)) {
    throw new Error(`${field} must be a valid YYYY-MM-DD date, got ${JSON.stringify(date)}`);
  }
}

function baseDoc(
  input: { category: CaseCategory; caseName: string; fileName: string },
  opened: string,
): CaseDoc {
  if (!isValidCaseName(input.caseName)) {
    throw new Error(`Illegal case name: ${JSON.stringify(input.caseName)}`);
  }
  return {
    fileName: input.fileName,
    category: input.category,
    caseName: input.caseName,
    opened,
    updated: opened,
    closed: null,
    body: "",
    tail: [],
    preserved: "",
    warnings: [],
  };
}

/**
 * createCase — seed a case's `index.md` (the one mandatory document). The
 * case directory itself is created by the writer layer; this op produces
 * the document with its birth date. `opened` is REQUIRED (a case name
 * carries no date — the header is the only birth record). `updated` starts
 * at the birth date; the write entry restamps it to the write instant.
 */
export function createCase(input: {
  category: CaseCategory;
  caseName: string;
  opened: string;
  body: string;
}): CaseDoc {
  assertDate(input.opened, "opened");
  const doc = baseDoc({ ...input, fileName: "index.md" }, input.opened);
  return { ...doc, body: input.body.trim() };
}

/**
 * createDoc — add one dated piece to a case. The piece name is built from
 * `date` + `title` and `opened` is filled FROM THE NAME — the same-source
 * rule is structural here (there is no second date to disagree). An illegal
 * title (4-digit lead, bad date, separators) throws.
 */
export function createDoc(input: {
  category: CaseCategory;
  caseName: string;
  date: string;
  title: string;
  body: string;
}): CaseDoc {
  assertDate(input.date, "date");
  const fileName = buildPieceFileName(input.date, input.title);
  const doc = baseDoc({ ...input, fileName }, input.date);
  return { ...doc, body: input.body.trim() };
}

/**
 * rewriteBody — replace the 正文 wholesale (draft semantics: the old draft
 * is NOT archived, §D.4). The op itself is unconditional; the WRITE WINDOW
 * guard (only within the window may a rewrite land) is enforced by the
 * write entry, which owns the clock.
 */
export function rewriteBody(doc: CaseDoc, body: string): CaseDoc {
  return { ...doc, body: body.trim() };
}

/**
 * appendTail — add one dated supplement line. Always allowed: past the
 * write window the tail is the document's only in-place growth, and inside
 * the window an extra dated line is harmless.
 */
export function appendTail(doc: CaseDoc, line: { date: string; text: string }): CaseDoc {
  assertDate(line.date, "line.date");
  const text = line.text.trim();
  if (!text) throw new Error("appendTail requires non-empty text");
  return { ...doc, tail: [...doc.tail, { date: line.date, text }] };
}
