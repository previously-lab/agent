/**
 * Case document format + the five write-ops (v0.19 §B.3, §B.4, §D.4).
 *
 * On-disk shape (`index.md` and pieces are isomorphic):
 *
 *   ---
 *   opened: 2026-09-05      # the ONLY mandatory header field
 *   closed: 2026-10-02      # optional — present = sealed (写完封口), absent = 还在写
 *   ---
 *
 *   正文：一次写完整的完整文本——这份文档当下的全部认识。
 *
 *   —— 尾部 ——
 *   2026-10-02：封口。结论如上；供应商部分另开 research/…。
 *   2026-11-09：文中价格已过时，最新见 …。
 *
 * Rules (structure, not suggestion):
 * - Header = two dates, nothing else. `closed` present means sealed; state
 *   is DERIVED from the record (axiom F), never stored as a status field.
 * - Same-source rule: a piece's `opened` and the birth date in its name come
 *   from the same variable — implemented by parsing the name and filling
 *   `opened` from it. On parse, a header/date mismatch is a WARNING and the
 *   NAME (identity) wins.
 * - 正文 is written whole, in one pass. While 还在写 it may be rewritten
 *   freely (`rewriteBody`) — drafts are NOT archived (no history mechanism,
 *   §D.4). After sealing, 正文 is frozen byte-for-byte; only the tail grows.
 * - 尾部 = dated supplement lines, one per line, append-only, ONLY after
 *   sealing (`appendTail`). `closeDoc` lands the `closed` date and the
 *   closing tail line in the SAME op (they are born and die together).
 * - Tolerant-parse contract: a broken file always opens — problems become
 *   warnings and unrecognized bytes are preserved verbatim (`preserved`).
 *
 * The five ops are PURE (no I/O). The ops layer is also the only
 * enforcement point for illegal transitions: `rewriteBody` on a sealed doc,
 * `appendTail`/`closeDoc` on a living doc, and any illegal name all throw —
 * rejections are loud, never silent.
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
  /** Seal date, or null while 还在写. */
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
 * YAML can hand us: a `Date` (UNQUOTED `closed: 2026-10-02` parses as one —
 * dropping it would silently read a sealed doc as 还在写), a plain string,
 * or a nested object with a `date` key (the v0.18 closed-block shape).
 * Returns "" when nothing date-like is there; validity is checked by the
 * caller so bad values degrade to warnings, never exceptions.
 */
function normalizeDateValue(v: unknown): string {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "string") return v;
  if (v && typeof v === "object") {
    return normalizeString((v as Record<string, unknown>).date);
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
    (k) => k !== "opened" && k !== "closed" && k !== "status" && k !== "updated",
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

  // ── closed: direct date, or the legacy shapes mapped forward ──
  // `closed` is the single most consequential bit (present = sealed, body
  // frozen; absent = 还在写), so a parse miss here is a state lie. Accept
  // Date / string / nested-object shapes; a value that is present but not a
  // valid date warns and reads as UNSEALED — visible, never a crash.
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
        warnings.push(`closed "${d}" 不是合法 YYYY-MM-DD 日期，按还在写处理`);
      }
    }
  }

  // Legacy v0.15 three-field header: status (+updated) — mapped per §D.1.
  const legacyStatus = normalizeString(data.status);
  const legacyUpdated = normalizeString(data.updated);
  if (legacyStatus || legacyUpdated) {
    if (legacyStatus === "closed" || legacyStatus === "void") {
      if (!closed && legacyUpdated) {
        closed = legacyUpdated;
        warnings.push(
          `旧版 status: ${legacyStatus} 映射为 closed: ${legacyUpdated}（以 header 日期封口）`,
        );
      }
    } else if (legacyStatus) {
      warnings.push(`旧版 status: ${legacyStatus} 已忽略（closed 缺席 = 还在写）`);
    }
    if (legacyUpdated) {
      warnings.push("旧版 updated 字段已忽略（日期记法由正文与尾部承载）");
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
    closed,
    body: bodyLines.join("\n").trim(),
    tail,
    preserved: preservedLines.join("\n").trim(),
    warnings,
  };
}

// ─── Serialize ──────────────────────────────────────────────────────────────

/**
 * Serialize back to Markdown: the two-date header, the body, the tail
 * (under its marker), and any preserved bytes verbatim at the end. Emits
 * ONLY the new shape — a doc that round-trips here is new-format on disk
 * (legacy bytes in `preserved` excepted: tolerance keeps them readable).
 */
export function serializeCaseDoc(doc: CaseDoc): string {
  const fm: Record<string, unknown> = {};
  if (doc.opened) fm.opened = doc.opened;
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

// ─── The five write-ops (pure; illegal transitions throw) ───────────────────

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
 * carries no date — the header is the only birth record).
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
 * rewriteBody — replace the 正文 wholesale. Only while 还在写 (draft
 * semantics: the old draft is NOT archived, §D.4). Throws on a sealed doc.
 */
export function rewriteBody(doc: CaseDoc, body: string): CaseDoc {
  if (doc.closed) {
    throw new Error(
      `rewriteBody refused: ${doc.caseName}/${doc.fileName} is sealed (closed ${doc.closed}) — sealed 正文 is frozen; use appendTail`,
    );
  }
  return { ...doc, body: body.trim() };
}

/**
 * closeDoc — seal the document: header gains `closed: <date>` AND the tail
 * gains the closing line IN THE SAME OP (the block and the record are born
 * together, axiom F). Only while 还在写; `note` is the closing/去向 prose.
 */
export function closeDoc(
  doc: CaseDoc,
  close: { date: string; note: string },
): CaseDoc {
  if (doc.closed) {
    throw new Error(
      `closeDoc refused: ${doc.caseName}/${doc.fileName} is already sealed (closed ${doc.closed})`,
    );
  }
  assertDate(close.date, "close.date");
  const note = close.note.trim();
  if (!note) throw new Error("closeDoc requires a closing note (去向说明)");
  return {
    ...doc,
    closed: close.date,
    tail: [...doc.tail, { date: close.date, text: note }],
  };
}

/**
 * appendTail — add one dated supplement line. Only on a SEALED document
 * (sealed 正文 is frozen; the tail is the only writable region). Throws
 * while 还在写 (drafts are rewritten via `rewriteBody`, not annotated).
 */
export function appendTail(doc: CaseDoc, line: { date: string; text: string }): CaseDoc {
  if (!doc.closed) {
    throw new Error(
      `appendTail refused: ${doc.caseName}/${doc.fileName} is still being written (no closed date) — rewrite the body or closeDoc first`,
    );
  }
  assertDate(line.date, "line.date");
  const text = line.text.trim();
  if (!text) throw new Error("appendTail requires non-empty text");
  return { ...doc, tail: [...doc.tail, { date: line.date, text }] };
}
