/**
 * The paper's reference tokenizer (v0.22 §7 / v0.25a §五) — the PURE half of
 * "references in a paper become links". One grammar, two consumers:
 *
 *   - `extractMarkdownRefs` — the desk's pre-flight: which candidate refs a
 *     document carries, handed to `verifyRefs` (archive/actions.ts) before
 *     the paper renders;
 *   - the remark plugin (`src/lib/markdown/remark-doc-refs.ts`) — the render
 *     half, splitting mdast text nodes on the SAME per-chunk tokenizer, so
 *     what gets verified is exactly what can light up.
 *
 * WHAT IS A CANDIDATE (and nothing else is):
 *
 *   分类/case名[/篇名]     a case/piece ref — first segment one of the nine
 *                          categories; the whole match must pass
 *                          `parseCaseRef` (the naming red line included).
 *                          A failing two-segment match falls back to the
 *                          one-segment case form ("research/手机调研/报价篇"
 *                          cites the case when 报价篇 is not a dated piece).
 *   records/<sliceId>      a slice's transcript paper.
 *   dossier/<name>         previously | direction only.
 *   (refs: …)              an evidence stamp — every slice id inside becomes
 *     — refs: …            a `records/<id>` candidate (the stamp's own
 *                          punctuation stays plain text; the id is the link).
 *
 * REFUSALS (the negatives the tests prove): bare slice ids outside a stamp
 * (a date followed by a bare HHMM reads as prose, not a citation), bare
 * dates and times, numbers, file paths (`src/lib/refs.ts` — no category
 * ever leads it), unknown categories, `records/` with a malformed id,
 * `dossier/` of anything but the two documents, code spans and fenced code
 * (the extractor strips them; the plugin never visits code nodes), and
 * anything inside an existing markdown link (the plugin skips link nodes).
 *
 * KNOWN LIMIT, stated once: case/piece names with INTERIOR SPACES tokenize
 * only up to the first space (a name's charset cannot include prose's word
 * separator without swallowing the sentence around it). Such a citation
 * degrades to a dead-styled shorter span or plain text — visible, never
 * blocking, the case-refs axiom.
 */

import { CASE_CATEGORIES } from "@/lib/docs/paths";
import { parseCaseRef } from "@/lib/docs/case-refs";
import { parseDossierRef } from "./refs";

/** One candidate found in prose: the NORMALIZED ref (the form verifyRefs and
 *  openDesk speak) and its character span in the source chunk. */
export interface RefToken {
  ref: string;
  start: number;
  end: number;
}

/** The live slice id shape — refs.ts's record grammar, and the same red
 *  line the stamp harvest applies inside `(refs: …)`. */
const SLICE_ID_SOURCE = "\\d{4}-\\d{2}-\\d{2}-\\d{4}";

/** Word characters that may NOT precede a `records/`, `dossier/` or category
 *  segment — otherwise `myrecords/…` or `selfresearch/…` would light up. */
const LEAD_BOUNDARY_RE = /[\w/]/;

/**
 * One name segment's charset: anything that is not whitespace, a path
 * separator, or a sentence/closing punctuation mark (ASCII + CJK). This is
 * what keeps `research/手机调研的结论。` from swallowing the prose around a
 * citation — the match ends at the first punctuation or space, and
 * `parseCaseRef` has the final say on what remains.
 */
const SEGMENT = `[^\\s/\\\\,.;:!?()（）{}[\\]〈〉《》【】"'«»\`，。、；：！？·…—]`;

const CASE_RE = new RegExp(
  `(?:${CASE_CATEGORIES.join("|")})/${SEGMENT}+(?:/${SEGMENT}+)?`,
  "g",
);
const RECORD_RE = new RegExp(`records/(?:${SLICE_ID_SOURCE})(?![\\d/-])`, "g");
const DOSSIER_RE = /dossier\/[\w-]+(?![\w/-])/g;

/**
 * The evidence stamp: `refs:` not preceded by a letter (`prefers:` is
 * prose), payload running to the closing paren or the end of the line —
 * covering `(refs: …)` in either paren width and the evolution tail's
 * `— refs: …`. Only slice ids are harvested from the payload: a stamp never
 * makes case names clickable.
 */
const STAMP_RE = /(?<![A-Za-z])refs:\s*([^\n)）]*)/g;
const STAMP_ID_RE = new RegExp(SLICE_ID_SOURCE, "g");

function boundaryOk(text: string, start: number): boolean {
  return start === 0 || !LEAD_BOUNDARY_RE.test(text[start - 1]);
}

/**
 * Tokenize one PLAIN-TEXT chunk into candidate references. Pure and total:
 * any string in, an ordered non-overlapping token list out. Overlaps settle
 * first-come in document order (a stamp's ids are never re-read as prose —
 * the case grammar's red line already bars digit-leading names).
 */
export function tokenizeRefText(text: string): RefToken[] {
  const out: RefToken[] = [];

  // 1. Stamps: every slice id inside a refs: payload becomes a record ref
  //    whose span is the ID's own — the stamp's punctuation stays plain.
  STAMP_RE.lastIndex = 0;
  for (let m = STAMP_RE.exec(text); m; m = STAMP_RE.exec(text)) {
    const payloadStart = m.index + m[0].length - m[1].length;
    STAMP_ID_RE.lastIndex = 0;
    for (let s = STAMP_ID_RE.exec(m[1]); s; s = STAMP_ID_RE.exec(m[1])) {
      const start = payloadStart + s.index;
      out.push({ ref: `records/${s[0]}`, start, end: start + s[0].length });
    }
  }

  // 2. The explicit non-case vocabularies.
  RECORD_RE.lastIndex = 0;
  for (let m = RECORD_RE.exec(text); m; m = RECORD_RE.exec(text)) {
    if (!boundaryOk(text, m.index)) continue;
    out.push({ ref: m[0], start: m.index, end: m.index + m[0].length });
  }
  DOSSIER_RE.lastIndex = 0;
  for (let m = DOSSIER_RE.exec(text); m; m = DOSSIER_RE.exec(text)) {
    if (!boundaryOk(text, m.index)) continue;
    if (!parseDossierRef(m[0])) continue;
    out.push({ ref: m[0], start: m.index, end: m.index + m[0].length });
  }

  // 3. Case/piece refs: the regex proposes, parseCaseRef disposes. A failing
  //    two-segment match retries as the bare case form.
  CASE_RE.lastIndex = 0;
  for (let m = CASE_RE.exec(text); m; m = CASE_RE.exec(text)) {
    if (!boundaryOk(text, m.index)) continue;
    const whole = m[0];
    if (parseCaseRef(whole)) {
      out.push({ ref: whole, start: m.index, end: m.index + whole.length });
      continue;
    }
    const slash = whole.indexOf("/", whole.indexOf("/") + 1);
    if (slash > 0) {
      const one = whole.slice(0, slash);
      if (parseCaseRef(one)) {
        out.push({ ref: one, start: m.index, end: m.index + one.length });
      }
    }
  }

  // First-come wins on overlaps; the result reads in document order.
  const sorted = out.sort((a, b) => a.start - b.start);
  return sorted.filter((t, i) => i === 0 || t.start >= sorted[i - 1].end);
}

/**
 * Every slice id a text's evidence stamps name — the WRITE-side mirror read:
 * `getRoomPapers` (archive/actions.ts) answers "which documents carry this
 * slice's stamp" by scanning for exactly the ids this harvest finds. Bare
 * ids outside stamps never count (the tokenizer's own refusal rule).
 */
export function stampSliceIds(text: string): string[] {
  const out: string[] = [];
  STAMP_RE.lastIndex = 0;
  for (let m = STAMP_RE.exec(text); m; m = STAMP_RE.exec(text)) {
    STAMP_ID_RE.lastIndex = 0;
    for (let s = STAMP_ID_RE.exec(m[1]); s; s = STAMP_ID_RE.exec(m[1])) {
      out.push(s[0]);
    }
  }
  return out;
}

/** Strip the markdown constructs prose tokenizing must not see: fenced code
 *  and inline code spans (their contents are literal, never citations). */
function stripCode(markdown: string): string {
  return markdown
    .replace(/(^|\n)(```|~~~)[\s\S]*?(\n\2(?=\n|$)|$)/g, "$1")
    .replace(/`[^`\n]*`/g, " ");
}

/**
 * A document's candidate refs for the verify pass: the deduped normalized
 * ref strings, in first-appearance order. Runs on the markdown SOURCE with
 * code stripped — the remark plugin's per-text-node tokenization is the same
 * grammar, so the verified set covers exactly what can render as a link.
 */
export function extractMarkdownRefs(markdown: string): string[] {
  const seen = new Set<string>();
  for (const token of tokenizeRefText(stripCode(markdown))) {
    seen.add(token.ref);
  }
  return [...seen];
}
