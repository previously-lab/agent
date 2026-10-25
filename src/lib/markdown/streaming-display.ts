/**
 * streaming-display — DISPLAY-ONLY conservative tail repair for ordinary
 * streaming Markdown. The result must never be persisted; the caller applies
 * it only to the latest streaming Markdown section.
 *
 * Guarantees:
 * - The source is ALWAYS preserved as an exact prefix; this function only
 *   ever appends a minimal suffix. It never trims, reindents, or normalizes
 *   line endings.
 * - It never appends to a completed source: repairs fire only on a detected
 *   incomplete trailing construct, on the last line only, so incomplete
 *   syntax from earlier completed lines is not reanimated.
 * - It never makes raw HTML executable and never touches an explicitly
 *   opened `html live` fence — that tail belongs to parseNativeSections'
 *   placeholder/fallback, so such input is returned unchanged.
 * - Fence state uses the SAME root-level scanner rules as
 *   src/lib/markdown/native-sections.ts (deliberate parity: same open/close
 *   grammar, list-context and HTML-block rules; shorter fences never close).
 *   Keep the two scanners in sync when changing either.
 *
 * Pure and synchronous: no DOM, fs, network, crypto, or dependencies.
 */

type Line = { text: string };

type TailFence = { char: "`" | "~"; length: number; native: boolean; root: boolean };
type HtmlBlock = "blank" | "comment" | "pi" | "cdata" | "declaration" | "pre" | "script" | "style" | "textarea";

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const LIST_MARKER = /^( *)(?:[-*+]|\d{1,9}[.)])(?:[ \t]+|$)/;
const NATIVE_INFO = /^html[ \t]+live(?:[ \t]|$)/;
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
    let i = pos;
    while (i < n && source[i] !== "\n" && source[i] !== "\r") i++;
    lines.push({ text: source.slice(pos, i) });
    pos = i < n ? (source[i] === "\r" && source[i + 1] === "\n" ? i + 2 : i + 1) : i;
  }
  return lines;
}

function lineIndent(text: string): number {
  let i = 0;
  while (i < text.length && text[i] === " ") i++;
  return text[i] === "\t" ? 4 : i;
}

function matchFenceOpen(text: string): { char: "`" | "~"; length: number; info: string } | null {
  const m = FENCE_OPEN.exec(text);
  if (!m) return null;
  if (m[1][0] === "`" && m[2].includes("`")) return null;
  return { char: m[1][0] as "`" | "~", length: m[1].length, info: m[2] };
}

function matchFenceClose(text: string, open: { char: "`" | "~"; length: number }): boolean {
  let i = 0;
  while (i < text.length && text[i] === " " && i < 3) i++;
  const indentEnd = i;
  let run = 0;
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

/** The unclosed fence, plus whether the final line is inside a fenced or HTML block. */
function findTailFence(source: string): { open: TailFence | null; lastLineProtected: boolean } {
  const lines = splitLines(source);
  const listStack: number[] = [];
  let open: TailFence | null = null;
  let htmlBlock: HtmlBlock | null = null;
  let inParagraph = false;
  let lastLineProtected = false;
  for (const line of lines) {
    lastLineProtected = false;
    if (open) {
      lastLineProtected = true;
      if (matchFenceClose(line.text, open)) open = null;
      continue;
    }
    if (htmlBlock) {
      lastLineProtected = true;
      if (matchHtmlBlockEnd(line.text, htmlBlock)) {
        htmlBlock = null;
        inParagraph = false;
      }
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
    const candidate = matchFenceOpen(line.text);
    if (candidate) {
      const root = listStack.length === 0;
      open = {
        char: candidate.char,
        length: candidate.length,
        native: root && candidate.char === "`" && NATIVE_INFO.test(candidate.info),
        root,
      };
      lastLineProtected = true;
      inParagraph = false;
      continue;
    }
    const html = matchHtmlBlockStart(line.text, inParagraph);
    if (html) {
      lastLineProtected = true;
      htmlBlock = matchHtmlBlockEnd(line.text, html) ? null : html;
      inParagraph = false;
      continue;
    }
    if (!blank) inParagraph = true;
  }
  return { open, lastLineProtected };
}

/** Conservative last-line inline repair: unclosed inline code, unclosed
 *  bold, and an incomplete trailing Markdown link may each be completed.
 *  Bold runs at or after an incomplete trailing link are left alone (they
 *  may be part of the link destination), so the common bold-before-link
 *  tail closes as `)**`. */
function repairInlineTail(source: string): string {
  const breakAt = Math.max(source.lastIndexOf("\n"), source.lastIndexOf("\r"));
  const tail = source.slice(breakAt + 1);
  if (tail.trim() === "") return source;
  // Escaped characters never count as markup.
  const unescaped = tail.replace(/\\[\s\S]/g, "");
  // Mask complete single-backtick inline-code spans, then look at what remains.
  const masked = unescaped.replace(/`[^`\r\n]*`/g, "");
  let suffix = "";
  const strayTicks = masked.split("`").length - 1;
  if (strayTicks % 2 === 1) return source + "`";
  const prose = masked.replace(/`+/g, "");
  const link = /\[[^\]\r\n]*\]\([^\)\r\n]*$/.exec(prose);
  // An odd number of `**` before the trailing link (or anywhere when there
  // is none) means one opener is unclosed; runs inside the link are skipped.
  const boldRuns = prose.slice(0, link ? link.index : prose.length).match(/\*\*/g);
  const boldOpen = Boolean(boldRuns && boldRuns.length % 2 === 1);
  // Close the link first so a bold-before-link tail completes as `)**`.
  if (link) suffix += ")";
  if (boldOpen) suffix += "**";
  return suffix === "" ? source : source + suffix;
}

/** Most recent existing line-ending style, for the appended suffix only. */
function lastEol(source: string): string {
  const lf = source.lastIndexOf("\n");
  const cr = source.lastIndexOf("\r");
  if (cr > lf) return "\r";
  if (lf > cr) return source[lf - 1] === "\r" ? "\r\n" : "\n";
  return "\n";
}

/**
 * Append the minimal display suffix for an incomplete streaming tail, or
 * return `source` unchanged when it is already complete (or when the tail is
 * a native `html live` fence, which parseNativeSections owns).
 */
export function repairStreamingMarkdown(source: string): string {
  if (source.length === 0) return source;
  const { open, lastLineProtected } = findTailFence(source);
  if (open) {
    if (open.native || !open.root) return source;
    const eol = /[\r\n]$/.test(source) ? "" : lastEol(source);
    return source + eol + open.char.repeat(open.length);
  }
  if (lastLineProtected) return source;
  return repairInlineTail(source);
}
