/**
 * Document-system notation (v0.15 design §2) — barrel export.
 *
 * Pure functions only: no I/O, no LLM, no module state. Identity is the
 * file name; the type set is closed; machine state is three frontmatter
 * fields plus a three-value status set. See CLAUDE.md in this directory
 * for the contract the writers/readers lane builds on.
 */
export {
  DOC_KINDS,
  DATED_DOC_KINDS,
  DOC_STATUSES,
  type DocKind,
  type DocStatus,
  type DocFrontmatter,
  type DocEntry,
  type DocAsOf,
  type ParsedDoc,
  type DocSection,
} from "./types";
export {
  SLICE_ID_PATTERN,
  isValidDate,
  startsWithFourDigits,
  isValidDocFileName,
  parseDocFileName,
  buildDocFileName,
  type ParsedDocFileName,
} from "./naming";
export {
  parseDoc,
  serializeDoc,
  createDocSkeleton,
  appendEntry,
  rewriteAsOf,
  markStatus,
} from "./document";
export { normalizeDocRef, docPathCandidates } from "./references";
// ─── Case model (v0.19 R1) — the new notation layer. The legacy exports
// above stay in service until the writers switch over (R3/R4). ───
export {
  CASE_CATEGORIES,
  isCaseCategory,
  caseDirPath,
  caseIndexPath,
  casePiecePath,
  caseAttachmentsPath,
  MEMORY_ROOT_DIR,
  LEGACY_DOC_ROOTS,
  LEGACY_DOC_KINDS,
  type CaseCategory,
} from "./paths";
export {
  isValidCaseName,
  isValidPieceFileName,
  parsePieceFileName,
  buildPieceFileName,
  type ParsedPieceName,
} from "./case-naming";
export {
  parseCaseDoc,
  serializeCaseDoc,
  createCase,
  createDoc,
  rewriteBody,
  appendTail,
  type CaseDoc,
  type TailLine,
  type CaseDocLocation,
} from "./case-doc";
export {
  DOC_WRITE_WINDOW_MINUTES,
  DOC_WRITE_WINDOW_MS,
  DOC_WRITE_WINDOW_RULE,
  isWithinWriteWindow,
  CaseWriteRefusal,
  type CaseWriteRefusalCode,
} from "./write-window";
export {
  normalizeCaseRefText,
  parseCaseRef,
  resolveCaseRefPaths,
  CASE_CATEGORY_LIST,
  type CaseRef,
} from "./case-refs";
