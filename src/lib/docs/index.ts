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
