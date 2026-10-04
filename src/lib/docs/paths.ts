/**
 * Memory-root path constants and two-root resolution (v0.19 §B.1, §B.6, §D.1).
 *
 * The top-level tree is FIXED forever — the subdirectories of `memory/` ARE
 * the closed category enumeration (filesystem = enumeration, same axiom as
 * the doc-type set):
 *
 *   memory/
 *     people/ events/ things/ places/ orgs/
 *     research/ hypotheses/ tasks/ self/     ← case categories (R1)
 *     records/                               ← conversation records (special; another lane)
 *     config/                                ← engineering state, NOT documents; no secrets
 *
 * A case = one directory: `index.md` (the one mandatory document) + dated
 * piece files + optional `attachments/`. No nesting.
 *
 * Two-root rule (§D.1): reads check the new root first, then fall back to
 * the LEGACY roots (`memory/docs/`, `memory/episodic/strands/`, …) — the
 * compat table lives HERE, in this one module. Writes go to the new root
 * only (enforced by the ops in `case-doc.ts`, never here).
 */
import { isValidCaseName, isValidPieceFileName } from "./case-naming";

// ─── The closed category set (§B.6) ────────────────────────────────────────

/** The nine case categories — the only directories cases may live in. */
export const CASE_CATEGORIES = [
  "people",
  "events",
  "things",
  "places",
  "orgs",
  "research",
  "hypotheses",
  "tasks",
  "self",
] as const;

export type CaseCategory = (typeof CASE_CATEGORIES)[number];

export function isCaseCategory(segment: string): segment is CaseCategory {
  return (CASE_CATEGORIES as readonly string[]).includes(segment);
}

// ─── Roots ─────────────────────────────────────────────────────────────────

export const MEMORY_ROOT_DIR = "memory";

/**
 * Legacy roots, checked AFTER the new root on reads (§D.1 双根). Only
 * `memory/docs/` (the v0.15 doc kinds) and `memory/episodic/strands/` (the
 * old strand-entity layer) hold documents addressable by the compat refs;
 * the rest are listed so the read-fallback surface is enumerated in one
 * place.
 */
export const LEGACY_DOC_ROOTS = [
  "memory/docs",
  "memory/episodic/strands",
] as const;

/** The legacy v0.15 kind directories under `memory/docs/` (for piece/name fallback). */
export const LEGACY_DOC_KINDS = [
  "event",
  "person",
  "object",
  "place",
  "org",
  "research",
  "hypothesis",
  "task",
  "topic",
] as const;

// ─── New-root path builders ────────────────────────────────────────────────

/**
 * The one enforcement choke for case paths: every builder validates its
 * name components through the red-line validators and throws on illegal
 * names. Writers assemble paths ONLY through these builders, so an illegal
 * case name can never reach the filesystem.
 */
function assertCaseName(caseName: string): void {
  if (!isValidCaseName(caseName)) {
    throw new Error(`Illegal case name: ${JSON.stringify(caseName)}`);
  }
}

/** `memory/<分类>/<case名>/` — the case directory (identity = 分类/case名). */
export function caseDirPath(category: CaseCategory, caseName: string): string {
  assertCaseName(caseName);
  return `${MEMORY_ROOT_DIR}/${category}/${caseName}`;
}

/** `memory/<分类>/<case名>/index.md` — the case's core document. */
export function caseIndexPath(category: CaseCategory, caseName: string): string {
  return `${caseDirPath(category, caseName)}/index.md`;
}

/** `memory/<分类>/<case名>/<篇名>.md` — one dated piece inside the case. */
export function casePiecePath(
  category: CaseCategory,
  caseName: string,
  pieceFileName: string,
): string {
  assertCaseName(caseName);
  if (!isValidPieceFileName(pieceFileName)) {
    throw new Error(`Illegal piece file name: ${JSON.stringify(pieceFileName)}`);
  }
  return `${caseDirPath(category, caseName)}/${pieceFileName}`;
}

/** `memory/<分类>/<case名>/attachments/` — optional; absent = none. */
export function caseAttachmentsPath(category: CaseCategory, caseName: string): string {
  return `${caseDirPath(category, caseName)}/attachments`;
}
