/**
 * Two-segment case references (v0.19 §B.2) + two-root resolution (§D.1).
 *
 * A reference names a document by IDENTITY, never by path:
 *
 *   分类/case名            → that case's `index.md`
 *   分类/case名/篇名        → a specific piece (`篇名` with or without `.md`)
 *
 * records keep citing slices by slice id — untouched here. A reference that
 * resolves nowhere is a DEAD LINK: `parseCaseRef` returns null for illegal
 * names (visible, never blocking — axiom A/B), and `resolveCaseRefPaths`
 * orders candidates new-root-first so a reader (or glob) checks the new
 * root before the legacy fallback roots.
 *
 * Legacy citation forms are tolerated (§D.1): `《名》` marks, stray `.md`
 * suffixes, and old-style path prefixes all strip down to a usable
 * reference — a bare legacy doc name (`用户手机`, `2026-09-05-手机购买调研`)
 * resolves against the OLD roots (`memory/docs/<kind>/`, `memory/episodic/
 * strands/`), which is where pre-case documents still live until they are
 * rewritten.
 */
import {
  CASE_CATEGORIES,
  LEGACY_DOC_KINDS,
  LEGACY_DOC_ROOTS,
  caseIndexPath,
  casePiecePath,
  isCaseCategory,
  type CaseCategory,
} from "./paths";
import { isValidCaseName, isValidPieceFileName } from "./case-naming";

export type CaseRef =
  | { kind: "case"; category: CaseCategory; caseName: string }
  | { kind: "piece"; category: CaseCategory; caseName: string; pieceFileName: string }
  /** A pre-case document name with no category — resolved under the legacy roots. */
  | { kind: "legacy"; name: string };

/**
 * Strip the tolerable decorations off a citation: surrounding whitespace,
 * 《》 book-title marks, a leading/trailing slash, and one `.md` suffix.
 * Returns the bare reference text (which may still contain `/` separators).
 */
export function normalizeCaseRefText(ref: string): string {
  if (typeof ref !== "string") return "";
  let s = ref.normalize("NFKC").trim();
  s = s.replace(/[《》]/g, "").trim();
  s = s.replace(/^[\\/]+/, "").replace(/[\\/]+$/, "");
  if (s.endsWith(".md")) s = s.slice(0, -".md".length);
  return s.trim();
}

/**
 * Parse arbitrary reference text into a structured CaseRef, validating
 * every name component against the red-line validators. Returns null when
 * nothing usable remains or a name component is illegal — the caller
 * surfaces that as a visible dead link, never an exception.
 *
 *   research/手机调研                → case
 *   research/手机调研/2026-09-08-报价篇 → piece
 *   用户手机                          → legacy (old topic home)
 *   2026-09-05-手机购买调研           → legacy (old dated doc)
 *   memory/docs/topic/用户手机        → legacy (path prefix stripped)
 */
export function parseCaseRef(ref: string): CaseRef | null {
  const s = normalizeCaseRefText(ref);
  if (!s || s === "." || s === "..") return null;
  const segments = s.split("/").filter((seg) => seg !== "");

  if (segments.length === 0) return null;

  if (isCaseCategory(segments[0])) {
    const category = segments[0];
    const caseName = segments[1];
    if (!isValidCaseName(caseName)) return null;
    if (segments.length === 2) return { kind: "case", category, caseName };
    const piece = segments[2];
    if (segments.length === 3 && isValidPieceFileName(`${piece}.md`)) {
      return { kind: "piece", category, caseName, pieceFileName: `${piece}.md` };
    }
    return null;
  }

  // Not category-led: a legacy reference. Take the last segment as the name
  // (path prefixes like `memory/docs/topic/` strip away). It is legal when
  // it passes EITHER validator: an old topic-style name (red line applies)
  // or an old dated doc name `<日期>-<标题>` (born date-leading by
  // construction — its title passed the red line in the old system).
  const name = segments[segments.length - 1];
  if (isValidCaseName(name)) return { kind: "legacy", name };
  if (isValidPieceFileName(`${name}.md`)) return { kind: "legacy", name };
  return null;
}

/**
 * The ordered candidate paths for a reference: the NEW root first, then the
 * legacy fallback roots (§D.1 读双查). The caller checks them in order (or
 * globs for the file name) — an empty result is impossible here; a ref that
 * parses always yields at least one candidate, and a ref that resolves
 * against none of them is a dead link discovered at read time.
 */
export function resolveCaseRefPaths(ref: CaseRef): string[] {
  if (ref.kind === "case") {
    return [
      caseIndexPath(ref.category, ref.caseName),
      ...LEGACY_DOC_ROOTS.map((root) => `${root}/${ref.caseName}.md`),
    ];
  }
  if (ref.kind === "piece") {
    return [
      casePiecePath(ref.category, ref.caseName, ref.pieceFileName),
      ...LEGACY_DOC_KINDS.map((kind) => `memory/docs/${kind}/${ref.pieceFileName}`),
    ];
  }
  // legacy name: old topic homes / old dated docs / old strand entities
  return [
    ...LEGACY_DOC_KINDS.map((kind) => `memory/docs/${kind}/${ref.name}.md`),
    `memory/episodic/strands/${ref.name}.md`,
  ];
}

/** The nine case categories, re-exported for input validation at call sites. */
export const CASE_CATEGORY_LIST: readonly CaseCategory[] = CASE_CATEGORIES;
