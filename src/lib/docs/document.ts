/**
 * Document body notation: parse / serialize / write-ops (v0.15 design §2.3–2.4).
 *
 * On-disk shape:
 *
 *   ---
 *   status: active        # the ONLY three machine fields
 *   opened: 2026-09-05
 *   updated: 2026-09-05
 *   ---
 *   # 关于手机购买的调研              (optional heading, preserved verbatim)
 *
 *   > 截至 2026-09-05：<一段话>       (截至块 — the only rewritable body region)
 *
 *   ## 2026-09-05 — 开篇             (append-only dated entry stream)
 *   散文……
 *
 * Contract: **parsing is tolerant.** A broken file always parses — missing
 * frontmatter, an illegal status, a malformed date, a `##` line that is not
 * a dated entry: all become `warnings`, and every unrecognized byte is kept
 * in a `raw` section so re-serialization loses nothing. A document must
 * never be "unopenable".
 *
 * Write-ops (`appendEntry` / `rewriteAsOf` / `markStatus`) are pure: they
 * return a NEW ParsedDoc. Semantics they guarantee: the entry stream is
 * append-only — no op ever edits or reorders an existing entry; only the
 * 截至块 is replaced, and `updated` is restamped to the write date.
 */
import matter from "gray-matter";
import {
  DOC_STATUSES,
  type DocAsOf,
  type DocEntry,
  type DocKind,
  type DocStatus,
  type ParsedDoc,
} from "./types";
import { isValidDate } from "./naming";

// ─── Field coercion (same guards as episodic/strand-files.ts) ──────────────

/** Coerce a value that should be a string (gray-matter can parse unquoted
 *  YAML values containing ": " as objects, and bare YYYY-MM-DD as Dates). */
function normalizeString(v: unknown): string {
  if (typeof v === "string") return v;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (v && typeof v === "object") return Object.keys(v)[0] ?? "";
  return "";
}

const ENTRY_HEADER = /^## (\d{4}-\d{2}-\d{2})\s*[-—–]\s*(.+?)\s*$/;
const AS_OF_FIRST = /^>\s*截至\s*(\d{4}-\d{2}-\d{2})\s*[:：]\s*(.*)$/;
const HEADING = /^#\s+(.+?)\s*$/;

// ─── Parse ──────────────────────────────────────────────────────────────────

/**
 * Parse a document file's raw Markdown into a ParsedDoc. Tolerant by
 * contract (see module header): warnings, never exceptions.
 *
 * @param raw      file contents
 * @param fileName identity — the file name (path is irrelevant)
 * @param kind     the kind — supplied by the caller from the directory found in
 */
export function parseDoc(raw: string, fileName: string, kind: DocKind): ParsedDoc {
  const warnings: string[] = [];
  let data: Record<string, unknown> = {};
  let body: string = raw;

  try {
    const parsed = matter(raw);
    data = parsed.data as Record<string, unknown>;
    body = parsed.content;
  } catch {
    warnings.push("frontmatter 解析失败，按无 frontmatter 处理");
  }

  // ── frontmatter: only three machine fields, everything else is dropped ──
  const unknownFields = Object.keys(data).filter(
    (k) => k !== "status" && k !== "opened" && k !== "updated",
  );
  if (unknownFields.length > 0) {
    warnings.push(`忽略未知 frontmatter 字段: ${unknownFields.join(", ")}`);
  }

  let status = normalizeString(data.status) as DocStatus | "";
  if (!status) {
    warnings.push("缺少 status，按 active 处理");
    status = "active";
  } else if (!(DOC_STATUSES as readonly string[]).includes(status)) {
    warnings.push(`status "${status}" 非法（应为 active|closed|void），按 active 处理`);
    status = "active";
  }

  const opened = normalizeString(data.opened);
  if (!opened) warnings.push("缺少 opened");
  else if (!isValidDate(opened)) warnings.push(`opened "${opened}" 不是 YYYY-MM-DD 日期`);

  const updated = normalizeString(data.updated);
  if (!updated) warnings.push("缺少 updated");
  else if (!isValidDate(updated)) warnings.push(`updated "${updated}" 不是 YYYY-MM-DD 日期`);

  // ── body: heading, 截至块, then the ordered entry stream ──
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  const skipBlanks = () => {
    while (i < lines.length && lines[i].trim() === "") i += 1;
  };

  skipBlanks();
  let heading: string | null = null;
  const hm = i < lines.length ? HEADING.exec(lines[i]) : null;
  if (hm) {
    heading = hm[1];
    i += 1;
  }

  skipBlanks();
  let asOf: DocAsOf | null = null;
  if (i < lines.length && lines[i].startsWith(">")) {
    const first = AS_OF_FIRST.exec(lines[i]);
    if (first) {
      const textLines: string[] = [first[2]];
      i += 1;
      while (i < lines.length && lines[i].startsWith(">")) {
        textLines.push(lines[i].replace(/^>\s?/, ""));
        i += 1;
      }
      asOf = { date: first[1], text: textLines.join("\n").trim() };
    } else {
      warnings.push("存在无法解析的引用块（非 截至 格式），保留原文");
    }
  }

  const sections: ParsedDoc["sections"] = [];
  let buf: string[] = [];
  const flushRaw = () => {
    const text = buf.join("\n").trim();
    if (text) sections.push({ type: "raw", text });
    buf = [];
  };
  let sawEntry = false;

  for (; i < lines.length; i += 1) {
    const line = lines[i];
    const em = ENTRY_HEADER.exec(line);
    if (em) {
      flushRaw();
      const entryLines: string[] = [];
      i += 1;
      while (i < lines.length && !/^##\s/.test(lines[i])) {
        entryLines.push(lines[i]);
        i += 1;
      }
      i -= 1; // leave any `##` line for the outer loop (entry header or raw)
      sections.push({
        type: "entry",
        entry: { date: em[1], title: em[2], body: entryLines.join("\n").trim() },
      });
      sawEntry = true;
    } else {
      if (/^##\s/.test(line)) {
        warnings.push(`条目头无法解析，保留原文: ${line.slice(0, 40)}`);
      }
      buf.push(line);
    }
  }
  flushRaw();
  if (!sawEntry && sections.length === 0 && !asOf) {
    warnings.push("正文为空");
  }

  return {
    fileName,
    kind,
    frontmatter: { status, opened, updated },
    heading,
    asOf,
    sections,
    warnings,
  };
}

// ─── Serialize ──────────────────────────────────────────────────────────────

/**
 * Serialize a ParsedDoc back to Markdown. Emits exactly the three machine
 * frontmatter fields (unknown fields are dropped by design), then heading,
 * 截至块, and the sections in order. Entries are emitted verbatim from the
 * parsed form — the stream a reader saw is the stream a writer writes back.
 */
export function serializeDoc(doc: ParsedDoc): string {
  const fm: Record<string, unknown> = {
    status: doc.frontmatter.status,
  };
  if (doc.frontmatter.opened) fm.opened = doc.frontmatter.opened;
  if (doc.frontmatter.updated) fm.updated = doc.frontmatter.updated;

  const parts: string[] = [];
  if (doc.heading) parts.push(`# ${doc.heading}`);
  if (doc.asOf) {
    const text = doc.asOf.text || "（空）";
    parts.push(`> 截至 ${doc.asOf.date}：${text}`);
  }
  for (const s of doc.sections) {
    if (s.type === "entry") {
      parts.push(`## ${s.entry.date} — ${s.entry.title}\n\n${s.entry.body}`.trimEnd());
    } else {
      parts.push(s.text);
    }
  }

  return matter.stringify(parts.join("\n\n") + "\n", fm);
}

// ─── Write-ops (pure; return a NEW doc) ────────────────────────────────────

function assertDate(date: string, field: string): void {
  if (!isValidDate(date)) throw new Error(`${field} must be YYYY-MM-DD, got ${JSON.stringify(date)}`);
}

/**
 * Seed a brand-new document skeleton (status active, `updated` = birth date).
 * The caller validates the file name through `isValidDocFileName` first.
 */
export function createDocSkeleton(input: {
  fileName: string;
  kind: DocKind;
  opened: string;
  heading?: string | null;
}): ParsedDoc {
  assertDate(input.opened, "opened");
  return {
    fileName: input.fileName,
    kind: input.kind,
    frontmatter: { status: "active", opened: input.opened, updated: input.opened },
    heading: input.heading ?? null,
    asOf: null,
    sections: [],
    warnings: [],
  };
}

/**
 * Append a dated entry to the stream. Append-only: existing entries and raw
 * sections are untouched. Restamps `updated` to the entry's date (the writer
 * restamps within its own write). Pure — returns a new doc.
 */
export function appendEntry(
  doc: ParsedDoc,
  entry: { date: string; title: string; body: string },
): ParsedDoc {
  assertDate(entry.date, "entry.date");
  const title = entry.title.trim();
  if (!title) throw new Error("entry title must be non-empty");
  const clean: DocEntry = { date: entry.date, title, body: entry.body.trim() };
  return {
    ...doc,
    frontmatter: { ...doc.frontmatter, updated: entry.date },
    sections: [...doc.sections, { type: "entry" as const, entry: clean }],
  };
}

/**
 * Rewrite the 截至块 — the ONLY body region writable in place. Replaces the
 * old block wholesale (the entry stream below still records the history).
 * Restamps `updated` to the as-of date. Pure — returns a new doc.
 */
export function rewriteAsOf(doc: ParsedDoc, asOf: { date: string; text: string }): ParsedDoc {
  assertDate(asOf.date, "asOf.date");
  return {
    ...doc,
    frontmatter: { ...doc.frontmatter, updated: asOf.date },
    asOf: { date: asOf.date, text: asOf.text.trim() },
  };
}

/**
 * Flip the status. `void` structurally REQUIRES a dated 作废 entry already
 * in the stream (the supersession statement lives in prose, not a field) —
 * throws otherwise. Restamps `updated`. Pure — returns a new doc.
 */
export function markStatus(
  doc: ParsedDoc,
  status: DocStatus,
  date: string,
): ParsedDoc {
  assertDate(date, "date");
  if (status === "void") {
    const hasVoidEntry = doc.sections.some(
      (s) => s.type === "entry" && s.entry.title.includes("作废"),
    );
    if (!hasVoidEntry) {
      throw new Error('status "void" requires a dated 作废 entry in the stream first');
    }
  }
  return {
    ...doc,
    frontmatter: { ...doc.frontmatter, status, updated: date },
  };
}
