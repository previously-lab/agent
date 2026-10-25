/**
 * native-sections — deterministic splitter between ordinary Markdown and
 * explicitly activated native "html live" fences.
 *
 * Contract ( relied on by the caller; do not loosen without flagging ):
 * - `raw` of every section is the exact original bytes; concatenating all
 *   `raw` in order ALWAYS equals the input, byte for byte (CRLF, mixed
 *   endings, blank lines, indentation, missing final newline included).
 * - `source` is the exact payload: Markdown bytes for markdown sections,
 *   fence BODY bytes only (no delimiters) for native sections.
 * - Activation is ONLY a root-level backtick fence whose whitespace-separated
 *   info tokens begin exactly `html live`. Tilde fences, `html`, case
 *   variants, blockquoted/list-indented fences never activate.
 * - Markdown HTML blocks (comments, raw-text elements, declarations, and
 *   regular block contexts) stay ordinary bytes; their inner fences never activate.
 * - EVERY fenced block is scanned (root or not, native or not), so a quoted
 *   ```html live sample inside an outer fence is swallowed as body text and
 *   can never activate. A closing fence must use the same fence character,
 *   be at least as long, be indented 0..3 spaces, and carry only spaces/tabs
 *   after it; a shorter fence never closes.
 * - Keys are deterministic and stable for a completed prefix as later prose
 *   streams: native keys use the full-answer native fence ordinal plus the
 *   optional explicit id; markdown keys use the markdown-run ordinal.
 * - `version` is a deterministic FNV-1a checksum of the body — a change
 *   detector, NOT random and NOT a security token.
 * - An unterminated explicitly opened native fence is returned with
 *   `closed: false` as a placeholder/fallback; the caller never executes it.
 *
 * Pure and synchronous: no DOM, fs, network, crypto, or dependencies.
 */

export type NativeMarkdownSection = {
  kind: "markdown";
  key: string;
  source: string;
  raw: string;
};

export type NativeHtmlSection = {
  kind: "native";
  key: string;
  source: string;
  raw: string;
  ordinal: number;
  closed: boolean;
  explicitId?: string;
  version: string;
};

export type NativeSection = NativeMarkdownSection | NativeHtmlSection;

type Line = { start: number; end: number; eolEnd: number; text: string };

type FenceOpen = { char: "`" | "~"; length: number; info: string };
type HtmlBlock = "blank" | "comment" | "pi" | "cdata" | "declaration" | "pre" | "script" | "style" | "textarea";

/** Bounded, conservative ASCII grammar for explicit native element ids. */
const EXPLICIT_ID = /^id="([A-Za-z][A-Za-z0-9_-]{0,63})"$/;

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const LIST_MARKER = /^( *)(?:[-*+]|\d{1,9}[.)])(?:[ \t]+|$)/;
const HTML_LINE = /^ {0,3}(.*)$/;
const HTML_RAW_OPEN = /^<(pre|script|style|textarea)(?:[ \t>]|$)/i;
const HTML_DECLARATION = /^<![A-Z]/;
const HTML_REGULAR_OPEN = /^<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h1|h2|h3|h4|h5|h6|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:[ \t]|\/>|>|$)/i;
const HTML_ATTRIBUTE = String.raw`[ \t]+[A-Za-z_:][A-Za-z0-9_.:-]*(?:[ \t]*=[ \t]*(?:[^ \t"'=<>\x60]+|'[^']*'|"[^"]*"))?`;
const HTML_COMPLETE_OPEN = new RegExp(`^<[A-Za-z][A-Za-z0-9-]*(?:${HTML_ATTRIBUTE})*[ \t]*/?>[ \t]*$`);
const HTML_COMPLETE_CLOSE = /^<\/[A-Za-z][A-Za-z0-9-]*[ \t]*>[ \t]*$/;

function matchHtmlBlockStart(text: string, inParagraph: boolean): HtmlBlock | null {
  const rest = HTML_LINE.exec(text)?.[1];
  if (rest === undefined) return null;
  const raw = HTML_RAW_OPEN.exec(rest);
  if (raw) return raw[1].toLowerCase() as HtmlBlock;
  if (rest.startsWith("<!--")) return "comment";
  if (rest.startsWith("<?")) return "pi";
  if (rest.startsWith("<![CDATA[")) return "cdata";
  if (HTML_DECLARATION.test(rest)) return "declaration";
  if (HTML_REGULAR_OPEN.test(rest)) return "blank";
  if (!inParagraph && (HTML_COMPLETE_OPEN.test(rest) || HTML_COMPLETE_CLOSE.test(rest))) return "blank";
  return null;
}

function matchHtmlBlockEnd(text: string, block: HtmlBlock): boolean {
  if (block === "blank") return text.trim() === "";
  if (block === "comment") return text.includes("-->");
  if (block === "pi") return text.includes("?>");
  if (block === "cdata") return text.includes("]]>");
  if (block === "declaration") return text.includes(">");
  return text.toLowerCase().includes(`</${block}>`);
}

function splitLines(source: string): Line[] {
  const lines: Line[] = [];
  let pos = 0;
  const n = source.length;
  while (pos < n) {
    const start = pos;
    let i = pos;
    while (i < n && source[i] !== "\n" && source[i] !== "\r") i++;
    const end = i;
    let eolEnd = i;
    if (i < n) eolEnd = source[i] === "\r" && source[i + 1] === "\n" ? i + 2 : i + 1;
    lines.push({ start, end, eolEnd, text: source.slice(start, end) });
    pos = eolEnd;
  }
  return lines;
}

/** Leading-space indent; a tab before content counts as 4 (past the 0..3 window). */
function lineIndent(text: string): number {
  let i = 0;
  while (i < text.length && text[i] === " ") i++;
  return text[i] === "\t" ? 4 : i;
}

function matchFenceOpen(text: string): FenceOpen | null {
  const m = FENCE_OPEN.exec(text);
  if (!m) return null;
  const fence = m[1];
  const info = m[2];
  // A backtick fence whose info string contains a backtick is not a fence.
  if (fence[0] === "`" && info.includes("`")) return null;
  return { char: fence[0] as "`" | "~", length: fence.length, info };
}

function matchFenceClose(text: string, open: FenceOpen): boolean {
  let run = 0;
  let i = 0;
  while (i < text.length && text[i] === " " && i < 3) i++;
  const indentEnd = i;
  while (i < text.length && text[i] === open.char) {
    run++;
    i++;
  }
  if (run < open.length || i === indentEnd) return false;
  while (i < text.length) {
    if (text[i] !== " " && text[i] !== "\t") return false;
    i++;
  }
  return true;
}

/** `html live` plus optional bounded extra meta such as id="chart". */
function parseNativeInfo(info: string): { native: boolean; explicitId?: string } {
  const tokens = info.trim().split(/[ \t]+/).filter(Boolean);
  if (tokens.length < 2 || tokens[0] !== "html" || tokens[1] !== "live") return { native: false };
  for (const token of tokens.slice(2)) {
    const id = EXPLICIT_ID.exec(token);
    if (id) return { native: true, explicitId: id[1] };
  }
  return { native: true };
}

/**
 * Deterministic body checksum (FNV-1a 32-bit). Change detection only —
 * not a security token, not a nonce.
 */
export function nativeSourceVersion(source: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < source.length; i++) {
    hash ^= source.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `fnv1a-${hash.toString(16).padStart(8, "0")}`;
}

/**
 * Split `source` into alternating markdown/native sections. Pure; repeated
 * calls on growing prefixes never mutate anything and never change the key,
 * source, or version of a previously completed section.
 */
export function parseNativeSections(source: string): NativeSection[] {
  if (source.length === 0) return [];
  const lines = splitLines(source);
  const sections: NativeSection[] = [];
  const listStack: number[] = [];
  let cursor = 0;
  let mdOrdinal = 0;
  let nativeOrdinal = 0;
  let htmlBlock: HtmlBlock | null = null;
  let inParagraph = false;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (htmlBlock) {
      if (matchHtmlBlockEnd(line.text, htmlBlock)) {
        htmlBlock = null;
        inParagraph = false;
      }
      i++;
      continue;
    }
    const blank = line.text.trim() === "";
    if (blank) inParagraph = false;
    const indent = lineIndent(line.text);
    if (!blank) {
      while (listStack.length > 0 && indent <= listStack[listStack.length - 1]) listStack.pop();
      const marker = LIST_MARKER.exec(line.text);
      if (marker) listStack.push(marker[1].length);
    }
    const open = matchFenceOpen(line.text);
    if (open) {
      inParagraph = false;
      const rootLevel = listStack.length === 0;
      let close = -1;
      for (let j = i + 1; j < lines.length; j++) {
        if (matchFenceClose(lines[j].text, open)) {
          close = j;
          break;
        }
      }
      const info = rootLevel && open.char === "`" ? parseNativeInfo(open.info) : { native: false as const };
      if (!info.native) {
        // Ordinary fenced block (or a non-root quoted one): bytes stay
        // Markdown, but the whole block is consumed so nested samples can
        // never be mistaken for activation sites.
        i = close >= 0 ? close + 1 : lines.length;
        continue;
      }
      if (line.start > cursor) {
        const raw = source.slice(cursor, line.start);
        sections.push({ kind: "markdown", key: `md-${mdOrdinal++}`, source: raw, raw });
      }
      const key = info.explicitId ? `native-${nativeOrdinal}-${info.explicitId}` : `native-${nativeOrdinal}`;
      const bodyStart = line.eolEnd;
      if (close >= 0) {
        const closeLine = lines[close];
        const body = source.slice(bodyStart, closeLine.start);
        sections.push({
          kind: "native",
          key,
          source: body,
          raw: source.slice(line.start, closeLine.eolEnd),
          ordinal: nativeOrdinal,
          closed: true,
          explicitId: info.explicitId,
          version: nativeSourceVersion(body),
        });
        nativeOrdinal++;
        cursor = closeLine.eolEnd;
        i = close + 1;
        continue;
      }
      const body = source.slice(bodyStart);
      sections.push({
        kind: "native",
        key,
        source: body,
        raw: source.slice(line.start),
        ordinal: nativeOrdinal,
        closed: false,
        explicitId: info.explicitId,
        version: nativeSourceVersion(body),
      });
      nativeOrdinal++;
      cursor = source.length;
      i = lines.length;
      continue;
    }
    const html = matchHtmlBlockStart(line.text, inParagraph);
    if (html) {
      htmlBlock = matchHtmlBlockEnd(line.text, html) ? null : html;
      inParagraph = false;
      i++;
      continue;
    }
    if (!blank) inParagraph = true;
    i++;
  }
  if (cursor < source.length) {
    const raw = source.slice(cursor);
    sections.push({ kind: "markdown", key: `md-${mdOrdinal++}`, source: raw, raw });
  }
  return sections;
}
