import { forkWriteBatch, mergeWriteBatch, assertBatchOpen } from "@/lib/docs/write-batch";
/**
 * Case writers + scribe — the document write path (v0.19 §A.2.3, §B.3, §B.6).
 *
 * THE CASE WRITER (the old librarian re-shaped; the production caller is
 * HQ's `archiveRound` tool, api/evolution/hq-agent.ts): invoked once per
 * closed slice, it judges FOR ITSELF whether anything is worth writing — an
 * empty run is a legal outcome (强制触发 ≠ 强制变异; axiom D: no semantic
 * gates). Tags are dead (R2): "which cases did this slice touch" is the
 * WRITER'S OWN judgment over the case manifest — writer-is-reader is
 * structural (§A.2.3): engineering assembles the survey manifest into the
 * prompt, the writer reads the current text of the cases it judges relevant
 * via the readCase tool, then returns write-intents that engineering applies
 * through the case write ops (§B.3 — open / rewriteIndex / appendTail /
 * addPiece / reviseUnderstanding) under the per-case lock. Successful full
 * reads, not manifest membership, authorize updates. It has no write tools —
 * the old "blind description" disease cannot recur.
 *
 * THE SCRIBE (书记段序 7, §A.2.2): picks up the structured one-line markers
 * the reply segment drops into the slice's agent.md and writes them into
 * cases: tasks/<名> (date-anchored), research/<名> (sediment), or the five
 * entity categories. A processed marker gets a `[doc-scribe]` record line in
 * the same agent.md so a marker is never written twice.
 *
 * THE MARKER CONTRACT (owned by this module, §A.3.1): one line in agent.md,
 *   [doc-marker] {"v":1,"id":"<turnId>-<n>","kind":"sediment|task|question",
 *     "docType":"research|entity","entityKind":"event|person|object|place|org",
 *     "target":"<existing case ref 分类/case名, optional>","title":"...",
 *     "dateAnchor":"YYYY-MM-DD (task only)","note":"...","topics":["..."]}
 * `topics` is LEGACY (the strand layer is gone) — tolerated, ignored.
 * "question" markers are NOT the scribe's — they route to the research pass
 * (flash/doc-research.ts).
 *
 * Evidence-while-writing: historical writes carry the triggering slice id;
 * _current.md carries only evidence refs successfully read in the run scope.
 *
 * Never throws at the top level: every failure degrades to a skipped item in
 * the result, so the caller is never taken down by a document write.
 */
import { tool } from "@/lib/deepseek/tools";
import { z } from "zod";
import { runSubAgent } from "@/lib/agents/sub-agent-runner";
import { buildSubAgentSystem } from "@/lib/agents/prompts";
import { projectNativeReplySemantics } from "@/lib/markdown/native-reply-semantics";
import { conversationRole, RECORD_ATTRIBUTION_RULE } from "../record-attribution";
import { DOC_HOUSE_STYLE, DOC_LANGUAGE_RULE } from "@/lib/agents/doc-style";
import { caseOpeningBody, casePieceCatalog, casePieceNavigation, renderCasePieceCatalog } from "@/lib/docs/organization";
import { assertDocumentWrite, assertTailBudget, documentSize, exceededSize, TAIL_TOTAL_LIMITS, DOCUMENT_SOFT_LIMITS, DocumentFullRefusal, DOCUMENT_BUDGET_RULE } from "@/lib/docs/write-limits";
import { isHistoryArchiveFileName, planHistoryArchive } from "@/lib/docs/history-archive";
import { formatDocumentLink } from "@/lib/documents/document-link";
import { confirmedDocumentProducts, stageDocumentProduct } from "../document-products";
import type { DialogueResearchRecord } from "../dialogue-record";
import type { ModelConfig } from "@/lib/models/registry";
import { resolveDataSource } from "@/lib/data-source/resolve";
import { getRepoConfig } from "@/lib/capabilities";
import { getGitHubReadHead } from "@/lib/github/read-view";
import {
  CASE_CATEGORIES,
  appendTail,
  caseIndexPath,
  casePiecePath,
  createCase,
  createDoc,
  isCaseCategory,
  isValidCaseName,
  isWithinWriteWindow,
  parseCaseDoc,
  parseCaseRef,
  resolveCaseRefPaths,
  rewriteBody,
  serializeCaseDoc,
  CaseWriteRefusal,
  WriteRefusal,
  DOC_WRITE_WINDOW_RULE,
  MEMORY_IS_GIT_RULE,
  sanitizeCaseSegment,
  type CaseCategory,
} from "@/lib/docs";
import {
  fsReadFile,
  fsWriteFile,
  fsListFiles,
  flushBatch,
  type WriteBatch,
} from "@/lib/episodic/io-helpers";
import { withSliceLock } from "@/lib/episodic/slice-mutex";
import { sliceIdToAgentPath } from "@/lib/episodic/manager";
import { readSlicePart, readSlicePartResolved } from "../paths";
import {
  applyRange,
  parseSliceId,
  parseTurns,
  reassembleSlice,
  renderedTurnBody,
} from "@/lib/episodic/turn-parser";
import {
  caseCurrentPath,
  isSameCaseCurrent,
  parseCaseCurrent,
  renderCaseWithCurrent,
  reviseCaseCurrent,
  serializeCaseCurrent,
  serializeCaseTail,
  serializeTailEntries,
  caseStorageRevision,
  caseCurrentFreshnessWarnings,
  type CaseCurrentBasis,
} from "@/lib/docs/case-doc";

// ─── Shared bits ───────────────────────────────────────────────────────────

/** What the writer read before writing — the slice, excerpted. */
export interface SliceExcerpt {
  focus: string;
  summary: string;
  turnsExcerpt: string;
  /** Explicit coverage/cap notice; optional for older callers' literal excerpts. */
  notice?: string;
  totalTurns?: number;
  includedTurns?: number;
}

const SLICE_EXCERPT_REFERENCE_NOTICE =
  "This is a compact excerpt, not complete slice evidence. Use readSlice with zero-based turn ranges and explicit cursor continuation for the original semantic record.";

export function sliceExcerptNotice(excerpt: SliceExcerpt): string {
  return excerpt.notice ?? SLICE_EXCERPT_REFERENCE_NOTICE;
}

/** Excerpt a slice without pretending that its bounded tail is the whole record. */
export function buildSliceExcerpt(slice: {
  slice_id?: string;
  focus?: string;
  summary?: string;
  turns: Array<{ role: string; content: string; turnId?: string; timestamp?: string }>;
}, sourceTurnIds?: readonly string[]): SliceExcerpt {
  const totalTurns = slice.turns.length;
  const selected = slice.turns.map((turn, index) => ({ turn, index }))
    .filter(({ turn }) => !sourceTurnIds || Boolean(turn.turnId && sourceTurnIds.includes(turn.turnId))).slice(-8);
  const firstIncluded = selected[0]?.index ?? 0;
  let cappedTurns = 0;
  const turnsExcerpt = selected
    .map(({ turn: t, index }) => {
      const projected = projectNativeReplySemantics(t.content, t.role)
        .replace(/\s+/g, " ")
        .trim();
      if (projected.length > 300) cappedTurns += 1;
      return JSON.stringify({
        ref: slice.slice_id ? `records/${slice.slice_id}` : undefined,
        turnIndex: index, turnId: t.turnId, timestamp: t.timestamp,
        role: conversationRole(t.role) ?? t.role,
        content: projected.slice(0, 300), contentTruncated: projected.length > 300,
      });
    })
    .join("\n");
  const coverage = sourceTurnIds ? `selected original zero-based turn indices ${selected.map(({ index }) => index).join(", ") || "(none)"} of ${totalTurns} total turns` : totalTurns === 0
    ? "no turns"
    : `zero-based turns ${firstIncluded}-${totalTurns - 1} of 0-${totalTurns - 1}`;
  const completeness = sourceTurnIds ? "INCOMPLETE: only owed source turns are represented; earlier context is not new writing material" : firstIncluded > 0
    ? `INCOMPLETE: ${firstIncluded} earlier turn(s) are omitted`
    : "all turns are represented";
  const capNotice = cappedTurns > 0
    ? `${cappedTurns} turn(s) are capped at 300 characters`
    : "no shown turn hit the 300-character cap";
  return {
    focus: slice.focus ?? "",
    summary: slice.summary ?? "",
    turnsExcerpt,
    notice:
      `Compact excerpt (${coverage}; ${completeness}; ${capNotice}). ` +
      `Focus/summary are derived archive metadata, not user speech. ${RECORD_ATTRIBUTION_RULE} ` +
      `Native generated sections are omission-marked in this derived-memory view only; the raw record is unchanged. ` +
      `Use readSlice${slice.slice_id ? ` for ${slice.slice_id}` : ""} with zero-based turn ranges and cursor continuation for complete semantic evidence.`,
    totalTurns,
    includedTurns: selected.length,
  };
}

export type SliceEvidenceRange =
  | { type: "turns"; indices: number[] }
  | { type: "last"; count: number }
  | { type: "date"; after: string };

export interface SliceEvidencePageInput {
  range?: SliceEvidenceRange;
  cursor?: number;
  maxChars?: number;
  revision?: string;
}

export interface SliceEvidencePage {
  content: string;
  start: number;
  end: number;
  totalChars: number;
  nextCursor: number | null;
  selectedTurns: number;
  totalTurns: number;
  revision: string;
  containsTurnContent: boolean;
  /** Page-local source ranges remain available even when the header was on a prior page. */
  attribution: Array<{ role: string; turnId?: string; turnIndex: number; timestamp: string; start: number; end: number }>;
}

export const SLICE_EVIDENCE_DEFAULT_PAGE_CHARS = 12_000;
export const SLICE_EVIDENCE_MAX_PAGE_CHARS = 24_000;

/** Page the semantic projection, never the stored record, with explicit continuation. */
export function readSliceEvidencePage(
  raw: string,
  input: SliceEvidencePageInput = {},
): SliceEvidencePage {
  const { frontmatter, turns } = parseTurns(raw);
  const revision = caseStorageRevision(raw);
  if ((input.cursor ?? 0) > 0 && input.revision !== revision) {
    throw new Error("source revision changed or is missing; re-read from cursor 0 before continuing");
  }
  const projected = turns.map((turn) => ({
    ...turn,
    content: projectNativeReplySemantics(
      turn.content,
      turn.role,
    ),
  }));
  const selected = input.range ? applyRange(projected, input.range) : projected;
  const selectedRaw = reassembleSlice(frontmatter, selected);
  const totalChars = selectedRaw.length;
  const start = input.cursor ?? 0;
  if (!Number.isInteger(start) || start < 0 || start > totalChars) {
    throw new Error(`cursor ${start} is outside the selected evidence length ${totalChars}`);
  }
  const maxChars = Math.min(
    SLICE_EVIDENCE_MAX_PAGE_CHARS,
    Math.max(2, Math.floor(input.maxChars ?? SLICE_EVIDENCE_DEFAULT_PAGE_CHARS)),
  );
  let end = Math.min(totalChars, start + maxChars);
  if (
    end < totalChars &&
    end > start &&
    /[\uD800-\uDBFF]/.test(selectedRaw[end - 1]!) &&
    /[\uDC00-\uDFFF]/.test(selectedRaw[end]!)
  ) {
    end -= 1;
  }
  let turnOffset = frontmatter.length;
  let containsTurnContent = false;
  const attribution: SliceEvidencePage["attribution"] = [];
  for (const turn of selected) {
    const contentStart = turnOffset + 2 + turn.header.length + 1;
    const contentEnd = contentStart + renderedTurnBody(turn).length;
    const from = Math.max(start, contentStart);
    const to = Math.min(end, contentEnd);
    if (from < to) {
      if (selectedRaw.slice(from, to).trim()) containsTurnContent = true;
      attribution.push({
        role: conversationRole(turn.role) ?? turn.role, turnId: turn.turnId,
        turnIndex: turn.index, timestamp: turn.timestamp, start: from - start, end: to - start,
      });
    }
    turnOffset = contentEnd;
  }
  return {
    content: selectedRaw.slice(start, end),
    start,
    end,
    totalChars,
    nextCursor: end < totalChars ? end : null,
    selectedTurns: selected.length,
    totalTurns: turns.length,
    revision,
    containsTurnContent,
    attribution,
  };
}

const sliceEvidenceRangeSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("turns"),
    indices: z.array(z.number().int().nonnegative()).min(1).max(50),
  }),
  z.object({ type: z.literal("last"), count: z.number().int().positive().max(50) }),
  z.object({
    type: z.literal("date"),
    after: z.string().refine((value) => !Number.isNaN(new Date(value).getTime()), {
      message: "after must be a parseable date or datetime",
    }),
  }),
]);

const sliceEvidencePageSchema = z.object({
  revision: z.string().regex(/^[0-9a-f]{64}$/).optional().describe(
    "Source revision returned by the first page; REQUIRED with any non-zero cursor",
  ),
  range: sliceEvidenceRangeSchema.optional().describe(
    "turns uses zero-based ordinal indices; last selects the newest N; date selects turns at/after a timestamp",
  ),
  cursor: z.number().int().nonnegative().optional().describe(
    "The nextCursor returned by the previous page; repeat the same range",
  ),
  maxChars: z.number().int().min(2).max(SLICE_EVIDENCE_MAX_PAGE_CHARS).optional(),
});

export type SliceRawReader = (sliceId: string, batch?: WriteBatch) => Promise<string>;

const defaultSliceRawReader: SliceRawReader = (sliceId, batch) =>
  readSlicePart(sliceId, "core", batch);

export interface SliceEvidenceToolOptions {
  batch?: WriteBatch;
  scope?: CaseReadScope;
  reader?: SliceRawReader;
}

async function executeSliceEvidenceRead(
  sliceId: string,
  args: SliceEvidencePageInput,
  options: SliceEvidenceToolOptions,
): Promise<string> {
  let raw: string;
  try {
    raw = await (options.reader ?? defaultSliceRawReader)(sliceId, options.batch);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return isAbsentReadError(error)
      ? `(slice ${sliceId} was not found; no evidence was read)`
      : `(slice ${sliceId} could not be read: ${message}; this is a read failure, not absence)`;
  }
  try {
    const page = readSliceEvidencePage(raw, args);
    if (page.containsTurnContent) {
      options.scope?.recordEvidence(`records/${sliceId}`, {
        revision: page.revision, coverage: "range",
        rangeKey: JSON.stringify(args.range ?? null),
        start: page.start, end: page.end, totalChars: page.totalChars,
      });
    }
    const continuation = page.nextCursor === null
      ? "COMPLETE: the selected evidence has been returned in full"
      : `INCOMPLETE: call readSlice with the same range, revision=${page.revision} and cursor=${page.nextCursor}`;
    return (
      `Slice ${sliceId} — original semantic evidence (native generated sections omission-marked; stored raw record unchanged).\n` +
      `Selected ${page.selectedTurns} of ${page.totalTurns} turns. Page characters [${page.start}, ${page.end}) of ${page.totalChars}.\n` +
      `Source revision: ${page.revision}.\n` +
      `Source ref: records/${sliceId}. Page-local speech ranges: ${JSON.stringify(page.attribution)}. Text outside these ranges is archive metadata/header material, not speech.\n` +
      `${RECORD_ATTRIBUTION_RULE}\n` +
      `${continuation}.\n\n${page.content}`
    );
  } catch (error) {
    return `(invalid readSlice request: ${error instanceof Error ? error.message : String(error)})`;
  }
}

/** A fixed-slice reader: the model can page/range, never choose a filesystem path. */
export function makeSliceReadTool(options: SliceEvidenceToolOptions & { sliceId: string }) {
  return tool({
    description:
      "Read this pass's original slice evidence with bounded pages. Select zero-based turns, the last N, or a date range. " +
      "Every page says COMPLETE or gives an explicit cursor; continue until complete when the evidence matters.",
    inputSchema: sliceEvidencePageSchema,
    execute: async (args: SliceEvidencePageInput) =>
      executeSliceEvidenceRead(options.sliceId, args, options),
  });
}

/** The research pass's id-based variant; ids still resolve only through slice paths. */
export function makeCrossSliceReadTool(options: SliceEvidenceToolOptions = {}) {
  return tool({
    description:
      "Read original slice evidence by slice id with bounded turn ranges and explicit cursor continuation. " +
      "Concrete facts may come only from evidence actually returned by this tool or readCase.",
    inputSchema: sliceEvidencePageSchema.extend({
      sliceId: z.string().describe("YYYY-MM-DD-HHMM"),
    }),
    execute: async ({ sliceId, ...args }: SliceEvidencePageInput & { sliceId: string }) => {
      if (!parseSliceId(sliceId)) return `(malformed slice id ${JSON.stringify(sliceId)})`;
      return executeSliceEvidenceRead(sliceId, args, options);
    },
  });
}

/** Evidence-while-writing, mechanical: the triggering slice id rides every landed body. */
function stampEvidence(body: string, sliceId: string): string {
  return `${body.trim()}\n\n(refs: ${sliceId})`;
}

/** Does this hypothesis body carry a falsification condition? (§B.6) */
export function hasFalsificationCondition(body: string): boolean {
  return body.includes("证伪") || /falsif/i.test(body);
}

/**
 * A tail line is ONE line: whitespace runs collapse so multi-line prose can
 * never reach the dated-tail serialization (a multi-line line would have its
 * extra lines dropped into preserved on re-parse, silently degrading the
 * document). `collapsed` reports whether the text actually changed.
 */
export function normalizeTailLine(line: string): { line: string; collapsed: boolean } {
  const collapsedLine = line.replace(/\s+/g, " ").trim();
  return { line: collapsedLine, collapsed: collapsedLine !== line };
}

// ─── Markers: the agent.md mailbox (pure parsing, §A.3.1 — unchanged) ───────

export const DOC_MARKER_PREFIX = "[doc-marker]";
export const SCRIBE_RECORD_PREFIX = "[doc-scribe]";
export const RESEARCH_RECORD_PREFIX = "[doc-research]";

const markerSchema = z.object({
  v: z.literal(1),
  /** Unique within the slice (convention: <turnId>-<seq>) — the dedup key. */
  id: z.string().min(1),
  kind: z.enum(["sediment", "task", "question"]),
  /** sediment only: research (default) or entity. */
  docType: z.enum(["research", "entity"]).optional(),
  /** sediment+entity only: which of the five entity kinds. */
  entityKind: z.enum(["event", "person", "object", "place", "org"]).optional(),
  /** Optional existing case reference (分类/case名) this marker updates. */
  target: z.string().optional(),
  /** The case's name (命名纪律: specific enough that a scope change means a new case). */
  title: z.string().min(1),
  /** task only: the date anchor the user stated. */
  dateAnchor: z.string().optional(),
  /** What this is about — the reply segment's one-line note. */
  note: z.string().default(""),
  /**
   * 证据·大段文字 (§C.1): the FULL pasted text, when the sedimented thing
   * is a long text the user sent. The scribe opens the case with this as the
   * 正文 and the origin stamped ("用户于 <date> 在切片 <id> 粘贴"). Absent for
   * ordinary markers — the writer drafts from the slice excerpt.
   */
  body: z.string().optional(),
  /** LEGACY (strands are gone) — tolerated, ignored by the case writers. */
  topics: z.array(z.string()).catch([]).default([]),
});

export type DocMarker = z.infer<typeof markerSchema>;

/**
 * Extract every well-formed marker line from an agent.md text. Tolerant:
 * malformed lines are skipped silently (a broken marker is visible in the
 * file itself; the mailbox never blocks the writer). Duplicate ids collapse
 * to the first occurrence.
 */
export function extractDocMarkers(agentMd: string): DocMarker[] {
  const out: DocMarker[] = [];
  const seen = new Set<string>();
  for (const line of agentMd.split("\n")) {
    const t = line.trim();
    if (!t.startsWith(DOC_MARKER_PREFIX)) continue;
    try {
      const parsed = markerSchema.safeParse(
        JSON.parse(t.slice(DOC_MARKER_PREFIX.length).trim()),
      );
      if (parsed.success && !seen.has(parsed.data.id)) {
        seen.add(parsed.data.id);
        out.push(parsed.data);
      }
    } catch {
      // malformed JSON — skip
    }
  }
  return out;
}

/**
 * The ids a writer pass already processed (its record lines in agent.md).
 * A marker with a record is never written twice.
 */
export function extractProcessedMarkerIds(agentMd: string, prefix: string): Set<string> {
  const ids = new Set<string>();
  for (const line of agentMd.split("\n")) {
    const t = line.trim();
    if (!t.startsWith(prefix)) continue;
    try {
      const rec: unknown = JSON.parse(t.slice(prefix.length).trim());
      if (rec && typeof rec === "object" && typeof (rec as { id?: unknown }).id === "string") {
        ids.add((rec as { id: string }).id);
      }
    } catch {
      // malformed record — skip
    }
  }
  return ids;
}

// ─── The case write machinery (the write ops, §B.3 + the v0.21 window) ────

/**
 * One validated write intent, in the writer's vocabulary. Engineering applies
 * it through the pure ops under the per-case lock, with a FRESH read inside
 * the lock. The guards that own TIME live here (the ops are pure and
 * clock-free):
 *
 * - `rewriteIndex` (whole-body rewrite) lands ONLY inside the write window
 *   (`now − updated ≤ window`, write-window.ts) — past the window the 正文
 *   is settled and the refusal says so, structured (CaseWriteRefusal
 *   `rewrite_window_closed`: re-read, then appendTail / addPiece).
 * - `rewriteIndex` may carry `expectedUpdated` — the `updated` stamp the
 *   caller read before drafting. After the in-lock fresh read, a disk stamp
 *   that differs means the case moved under the caller: the rewrite is
 *   refused, structured (`rewrite_conflict`). Absent the parameter, the
 *   window rule alone decides.
 * - `appendTail` grows settled history without reopening it; `addPiece`
 *   creates a NEW file and refuses same-date/title collisions; `open` creates
 *   a new case. `close` is RETIRED — sealing is the window closing, time's act.
 * - `open` refuses a `hypotheses` case whose body carries no falsification
 *   condition (§B.6) — the entry guard owns the check so every writer
 *   (field, HQ, the passes) meets the same bar.
 * - `appendTail` normalizes its line to ONE line (whitespace collapse) and
 *   reports the collapse in the outcome's warnings.
 *
 * Open and whole-index rewrites restamp `updated`; tail supplements and
 * _current.md revisions deliberately do not reopen the historical body window.
 */
export interface CaseIndexRead {
  category: CaseCategory;
  caseName: string;
  path: string;
  currentPath: string;
  content: string;
  currentContent: string | null;
  /** Full-fidelity content version: the exact index bytes read, not a timestamp. */
  revision: string;
  currentRevision?: string | null;
  /** null means unavailable, never an empty case. */
  pieceInventory?: string[] | null;
}

export interface CaseEvidenceRead {
  revision: string;
  coverage: "full" | "range";
  path?: string;
  rangeKey?: string;
  start?: number;
  end?: number;
  totalChars?: number;
}

/** Run-local receipts produced only by successful storage reads. */
export interface CaseReadScope {
  recordIndexRead(read: CaseIndexRead): void;
  getIndexRead(category: CaseCategory, caseName: string): CaseIndexRead | undefined;
  recordEvidence(ref: string, proof?: CaseEvidenceRead): void;
  hasEvidence(ref: string): boolean;
  getEvidenceReads(ref: string): CaseEvidenceRead[];
}

export function createCaseReadScope(): CaseReadScope {
  const reads = new Map<string, CaseIndexRead>();
  const evidence = new Set<string>();
  const proofs = new Map<string, CaseEvidenceRead[]>();
  return {
    recordIndexRead(read) {
      reads.set(`${read.category}/${read.caseName}`, read);
      evidence.add(`${read.category}/${read.caseName}`);
      proofs.set(`${read.category}/${read.caseName}`, [{ revision: read.revision, coverage: "full", path: read.path }]);
    },
    getIndexRead(category, caseName) {
      return reads.get(`${category}/${caseName}`);
    },
    recordEvidence(ref, proof) {
      const normalized = normalizeEvidenceRef(ref);
      if (normalized) {
        evidence.add(normalized);
        if (proof) {
          const previous = proofs.get(normalized) ?? [];
          proofs.set(normalized, [...previous.filter((entry) => entry.revision === proof.revision), proof]);
        }
      }
    },
    hasEvidence(ref) {
      const normalized = normalizeEvidenceRef(ref);
      return normalized !== null && evidence.has(normalized);
    },
    getEvidenceReads(ref) {
      const normalized = normalizeEvidenceRef(ref);
      return normalized ? [...(proofs.get(normalized) ?? [])] : [];
    },
  };
}

export function requireCaseIndexRead(
  scope: CaseReadScope,
  category: CaseCategory,
  caseName: string,
): CaseIndexRead {
  const read = scope.getIndexRead(category, caseName);
  if (!read) {
    throw new Error(
      `case ${category}/${caseName} has no successful full index read in this run — ` +
      "call readCase first; manifest membership and model-supplied receipts are not proof",
    );
  }
  return read;
}

function normalizeEvidenceRef(ref: string): string | null {
  const text = ref.trim();
  if (!text || /[\r\n]/.test(text)) return null;
  const recordId = text.startsWith("records/") ? text.slice("records/".length) : text;
  if (parseSliceId(recordId) && (text === recordId || text.startsWith("records/"))) {
    return `records/${recordId}`;
  }
  const parsed = parseCaseRef(text);
  if (!parsed) return null;
  if (parsed.kind === "case") return `${parsed.category}/${parsed.caseName}`;
  if (parsed.kind === "piece") {
    return `${parsed.category}/${parsed.caseName}/${parsed.pieceFileName.replace(/\.md$/, "")}`;
  }
  return `legacy/${parsed.name}`;
}

function isAbsentReadError(error: unknown): boolean {
  const code = error && typeof error === "object" && "code" in error
    ? (error as { code?: unknown }).code
    : undefined;
  if (code === "ENOENT") return true;
  const message = error instanceof Error ? error.message : String(error);
  return /^(File not found|Directory not found)/.test(message) || /\bENOENT\b/.test(message);
}

async function readOptionalCaseFile(
  path: string,
  batch: WriteBatch | undefined,
  fresh: boolean,
): Promise<string | null> {
  try {
    return await fsReadFile(path, batch, { fresh });
  } catch (error) {
    if (isAbsentReadError(error)) return null;
    throw error;
  }
}

/** Read the complete index plus its current view; only success becomes a receipt. */
export async function readCaseIndexForScope(input: {
  category: CaseCategory;
  caseName: string;
  batch?: WriteBatch;
  scope?: CaseReadScope;
  fresh?: boolean;
}): Promise<CaseIndexRead> {
  const path = caseIndexPath(input.category, input.caseName);
  const currentPath = caseCurrentPath(input.category, input.caseName);
  const content = await fsReadFile(path, input.batch, { fresh: input.fresh === true });
  const currentContent = await readOptionalCaseFile(
    currentPath,
    input.batch,
    input.fresh === true,
  );
  const read: CaseIndexRead = {
    category: input.category,
    caseName: input.caseName,
    path,
    currentPath,
    content,
    currentContent,
    revision: caseStorageRevision(content),
    currentRevision: currentContent === null ? null : caseStorageRevision(currentContent),
    pieceInventory: await readCasePieceInventory(input.category, input.caseName, input.batch),
  };
  input.scope?.recordIndexRead(read);
  return read;
}

/** Expose discovery separately from the receipts kept by the writer. */
function renderWriterCaseRead(read: CaseIndexRead, scope?: CaseReadScope): string {
  const entries = casePieceCatalog({ category: read.category, caseName: read.caseName, paths: read.pieceInventory ?? null });
  for (const entry of entries ?? []) {
    entry.read = scope?.getEvidenceReads(entry.ref).some((proof) => proof.coverage === "full") === true;
  }
  const warnings = read.currentContent === null ? [] : caseCurrentFreshnessWarnings(
    parseCaseCurrent(read.currentContent), currentReadBasis(read, scope),
  );
  return `${renderCasePieceCatalog(entries)}\n\n${renderCaseWithCurrent(read.content, read.currentContent, { freshnessWarnings: warnings })}`;
}

/** Tree-backed on GitHub; no per-piece content fetches. */
async function readCasePieceInventory(category: CaseCategory, caseName: string, batch?: WriteBatch): Promise<string[] | null> {
  const directory = caseIndexPath(category, caseName).replace(/\/index\.md$/, "");
  let paths: string[];
  try {
    paths = (await fsListFiles(directory)).filter((entry) => entry.type === "file")
      .map((entry) => `${directory}/${entry.name}`);
  } catch (error) {
    if (isAbsentReadError(error)) paths = [];
    else return null;
  }
  const isPiece = (path: string) => !isHistoryArchiveFileName(path) && /^\d{4}-\d{2}-\d{2}-.+\.md$/.test(path.slice(directory.length + 1));
  const pieces = new Set(paths.filter(isPiece));
  for (const [path, content] of batch?.entries ?? []) {
    if (!path.startsWith(`${directory}/`) || path.slice(directory.length + 1).includes("/") || !isPiece(path)) continue;
    if (content === null) pieces.delete(path); else pieces.add(path);
  }
  return [...pieces].sort();
}

function currentReadBasis(read: CaseIndexRead, scope?: CaseReadScope): CaseCurrentBasis {
  return {
    indexRevision: read.revision,
    pieces: (read.pieceInventory ?? []).map((path) => {
      const ref = path.replace(/^memory\//, "").replace(/\.md$/, "");
      const proof = scope?.getEvidenceReads(ref).find((entry) => entry.coverage === "full");
      return { path, revision: proof?.revision ?? null };
    }),
  };
}

export type CaseWriteIntent =
  | { action: "reorganize"; category: CaseCategory; caseName: string; body: string; evidence: string[] }
  | { action: "open"; category: CaseCategory; caseName: string; body: string }
  | {
      action: "rewriteIndex";
      category: CaseCategory;
      caseName: string;
      body: string;
      expectedUpdated?: string;
      /** Exact index bytes read before drafting; scoped model writes always use it. */
      expectedRevision?: string;
    }
  | {
      action: "appendTail";
      category: CaseCategory;
      caseName: string;
      line: string;
      expectedRevision?: string;
    }
  | {
      action: "addPiece";
      category: CaseCategory;
      caseName: string;
      title: string;
      body: string;
      expectedRevision?: string;
    }
  | {
      action: "reviseUnderstanding";
      category: CaseCategory;
      caseName: string;
      body: string;
      evidence: string[];
      expectedRevision?: string;
    };

export interface CaseWriteOutcome {
  /** The repo-relative path written. */
  path: string;
  /** True when a new file was created (open / addPiece / first current view). */
  created: boolean;
  /** True when an identical retry required no write. */
  noop?: boolean;
  /** Non-fatal write-time adjustments the caller may surface — e.g. a tail
   *  line whose line breaks were collapsed to keep it one line. */
  warnings?: string[];
}

const pendingCaseBatchBases = new WeakMap<WriteBatch, Promise<void>>();

/** Pin before fresh comparisons; flush must never rebase validated old bytes onto a newer HEAD. */
async function ensureCaseBatchBasis(batch?: WriteBatch): Promise<void> {
  if (resolveDataSource() !== "github") return;
  if (!batch) {
    throw new WriteRefusal("commit_failed", "GitHub case writes require an explicit batch with a guarded HEAD basis; queue and flush the batch instead of writing directly");
  }
  if (batch.baseHeadSha !== undefined) {
    if (!batch.baseHeadSha.trim()) throw new WriteRefusal("commit_failed", "The case write batch has an empty HEAD basis");
    return;
  }
  const existing = pendingCaseBatchBases.get(batch);
  if (existing) return existing;
  const pending = (async () => {
    const { repo, owner } = getRepoConfig();
    const head = await getGitHubReadHead(repo, owner, { fresh: true });
    if (!head.headSha?.trim()) throw new WriteRefusal("commit_failed", "The GitHub HEAD basis could not be resolved; no case write was queued");
    // Another subsystem may have pinned the shared batch while this read was in flight.
    if (batch.baseHeadSha === undefined) batch.baseHeadSha = head.headSha;
  })();
  pendingCaseBatchBases.set(batch, pending);
  try { await pending; } finally { pendingCaseBatchBases.delete(batch); }
}

/**
 * Apply one write intent: per-case lock (`doc:<分类>/<case名>`, §A.3.4), a
 * FRESH read of the case's index.md inside the lock, exact-content/read-scope
 * guards, the time guards, then the pure op and batch-aware write. Full-body
 * writes restamp `updated`; supplements/current views do not. Violations throw;
 * the caller records the refusal (structured code, or a plain contract Error).
 */
const queuedCaseBatches = new WeakMap<WriteBatch, Promise<void>>();
export async function applyCaseWriteIntent(
  intent: CaseWriteIntent, date: string, batch?: WriteBatch, readScope?: CaseReadScope,
): Promise<CaseWriteOutcome> {
  const execute = async () => {
  if (batch) assertBatchOpen(batch);
  await ensureCaseBatchBasis(batch);
  const pending = forkWriteBatch(batch);
  const outcome = await applyCaseWriteIntentStaged(intent, date, pending, readScope);
  const written = pending.entries.get(outcome.path);
  if (!outcome.noop && typeof written === "string" && exceededSize(documentSize(written), DOCUMENT_SOFT_LIMITS).length) outcome.warnings = [...(outcome.warnings ?? []), "Above the reading-size advisory (4,000 code points / 12 KiB / 100 lines). Keep only new conclusions here; split by reading purpose when useful, not by a daily quota."];
  if (batch) mergeWriteBatch(batch, pending);
  else await flushBatch(pending, `case ${intent.action} ${intent.category}/${intent.caseName}`);
  return outcome;
  };
  if (!batch) return execute();
  const result = (queuedCaseBatches.get(batch) ?? Promise.resolve()).then(execute);
  const tail = result.then(() => undefined, () => undefined);
  queuedCaseBatches.set(batch, tail);
  void tail.then(() => { if (queuedCaseBatches.get(batch) === tail) queuedCaseBatches.delete(batch); });
  return result;
}


async function applyCaseWriteIntentStaged(
  intent: CaseWriteIntent,
  date: string,
  batch?: WriteBatch,
  readScope?: CaseReadScope,
): Promise<CaseWriteOutcome> {
  const { category, caseName } = intent;
  if (!isCaseCategory(category)) {
    throw new WriteRefusal(
      "invalid_category",
      `unknown category: ${JSON.stringify(category)} — pick one of: people / events / things / places / orgs / research / hypotheses / tasks / self.`,
    );
  }
  if (!isValidCaseName(caseName)) {
    throw new Error(`illegal case name: ${JSON.stringify(caseName)}`);
  }
  const identity = `${category}/${caseName}`;
  const indexPath = caseIndexPath(category, caseName);

  return withSliceLock(`doc:${identity}`, async () => {
    await ensureCaseBatchBasis(batch);
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const scopedRead = intent.action === "open" || !readScope
      ? undefined
      : requireCaseIndexRead(readScope, category, caseName);
    const expectedRevision = scopedRead?.revision ??
      ("expectedRevision" in intent ? intent.expectedRevision : undefined);
    const currentRaw = await readOptionalCaseFile(indexPath, batch, true);
    const current = currentRaw === null
      ? null
      : parseCaseDoc(currentRaw, { category, caseName, fileName: "index.md" });

    if (intent.action !== "open" && expectedRevision !== undefined &&
        (currentRaw === null || caseStorageRevision(currentRaw) !== expectedRevision)) {
      throw new CaseWriteRefusal(
        "rewrite_conflict",
        `${intent.action} refused: ${identity} changed since its successful full index read. ` +
        "Read the current index with readCase and base the write on that fresh content; never force the old basis.",
      );
    }

    switch (intent.action) {
      case "reorganize": {
        if (!current || currentRaw === null || !scopedRead || !readScope) throw new WriteRefusal("rewrite_conflict", "reorganize requires a fresh full target read");
        if (!intent.evidence.length || intent.evidence.some((ref) => !readScope.hasEvidence(ref))) throw new WriteRefusal("rewrite_conflict", "reorganize requires evidence actually read in this run");
        const tail = current.tail.map((line) => `${line.date}：${line.text}`).join("\n");
        if (!exceededSize(documentSize(currentRaw)).length && !exceededSize(documentSize(tail), TAIL_TOTAL_LIMITS).length) throw new Error("reorganize is only for over-budget documents/tails; use the ordinary write window otherwise");
        const archive = planHistoryArchive({ category, caseName, source: "index.md", sourceRaw: currentRaw, date, updated: nowIso, kind: "source-snapshot", previousHead: current.historyHead });
        const link = formatDocumentLink(archive.headRef);
        const body = `${intent.body.trim()}\n\nHistorical source (preserved, not a new conclusion): [archive](${link})`;
        const next = serializeCaseDoc({ ...current, body, tail: [], preserved: "", historyHead: archive.headRef });
        const beforeSize = documentSize(currentRaw), afterSize = documentSize(next);
        if (!Object.keys(beforeSize).every((key) => afterSize[key as keyof typeof afterSize] <= beforeSize[key as keyof typeof beforeSize]) || next === currentRaw) throw new Error("reorganize must reduce storage without growing another metric");
        assertDocumentWrite(indexPath, next, currentRaw, true);
        for (const entry of archive.entries) await fsWriteFile(entry.path, entry.content, batch);
        batch!.maintenance ??= new Map();
        batch!.maintenance.set(indexPath, { sourceRevision: caseStorageRevision(currentRaw), archiveHeadRef: archive.headRef });
        await fsWriteFile(indexPath, next, batch);
        return { path: indexPath, created: false };
      }
      case "open": {
        if (current) {
          throw new WriteRefusal(
            "already_exists",
            `case ${identity} already exists — re-read it (readCase) and use rewriteIndex (inside the write window) / appendTail / addPiece instead of open.`,
          );
        }
        if (category === "hypotheses" && !hasFalsificationCondition(intent.body)) {
          throw new WriteRefusal(
            "falsification_missing",
            `hypotheses case refused: ${identity} carries no falsification condition — ` +
              "state it in the body as 'falsify if: …' / a 证伪 condition, then retry the open.",
          );
        }
        const doc = createCase({ category, caseName, opened: date, body: intent.body });
        await fsWriteFile(indexPath, serializeCaseDoc({ ...doc, updated: nowIso, bodyUpdated: nowIso }), batch);
        return { path: indexPath, created: true };
      }
      case "rewriteIndex": {
        if (!current) {
          throw new WriteRefusal(
            "not_found_on_update",
            `case ${identity} does not exist — open it first (action: open) with the full body.`,
          );
        }
        if (intent.expectedUpdated !== undefined) {
          const expected = intent.expectedUpdated.trim().replace(/^['"]|['"]$/g, "");
          if (current.updated !== expected) {
            throw new CaseWriteRefusal(
              "rewrite_conflict",
              `rewriteIndex refused: ${identity} moved since you read it ` +
                `(updated on disk: ${current.updated || "(none)"}; you based the rewrite on: ${expected || "(none)"}). ` +
                "Re-read the current text, then append a dated supplement (appendTail) or add a piece (addPiece) instead.",
            );
          }
        }
        if (!isWithinWriteWindow(current.bodyUpdated, nowMs)) {
          throw new CaseWriteRefusal(
            "rewrite_window_closed",
            `rewriteIndex refused: ${identity} is outside its write window ` +
              `(last full-body write ${current.updated || "unknown"}). The body is settled — ` +
              "re-read it, then append a dated correction/supplement (appendTail), open a new piece (addPiece), or revise _current.md.",
          );
        }
        const next = rewriteBody(current, intent.body);
        await fsWriteFile(indexPath, serializeCaseDoc({ ...next, updated: nowIso, bodyUpdated: nowIso }), batch);
        return { path: indexPath, created: false };
      }
      case "appendTail": {
        if (!current) {
          throw new WriteRefusal(
            "not_found_on_update",
            `case ${identity} does not exist — open it first (action: open) with the full body.`,
          );
        }
        const { line, collapsed } = normalizeTailLine(intent.line);
        if (!line) {
          throw new Error(`appendTail refused: ${identity} — the line is empty once flattened to one line`);
        }
        const conclusion = (text: string) => text.replace(/\s*\(refs?:[^)]*\)\s*$/i, "").trim();
        if (current.tail.some((tail) => conclusion(tail.text) === conclusion(line))) return { path: indexPath, created: false, noop: true };
        const next = appendTail(current, { date, text: line });
        assertTailBudget(indexPath, serializeTailEntries([{ date, text: line }]) + "\n", serializeCaseTail(next.tail) + "\n");
        assertDocumentWrite(indexPath, serializeCaseDoc(next), currentRaw);
        // A supplement never restamps the body window: settled history stays settled.
        await fsWriteFile(indexPath, serializeCaseDoc(next), batch);
        return {
          path: indexPath,
          created: false,
          ...(collapsed
            ? { warnings: [`tail line for ${identity} contained line breaks — collapsed to one line`] }
            : {}),
        };
      }
      case "addPiece": {
        if (!current) {
          throw new WriteRefusal(
            "not_found_on_update",
            `case ${identity} does not exist — open it first (action: open) with the full body.`,
          );
        }
        const doc = createDoc({ category, caseName, date, title: intent.title, body: intent.body });
        if (isHistoryArchiveFileName(doc.fileName)) throw new Error("History archive names are reserved for verified lossless archival");
        const piecePath = casePiecePath(category, caseName, doc.fileName);
        // Exact-content retries do not need another file under a different date/title.
        for (const candidate of await readCasePieceInventory(category, caseName, batch) ?? []) {
          if (candidate === piecePath) continue;
          const raw = await readOptionalCaseFile(candidate, batch, true);
          if (raw === null) continue;
          const existing = parseCaseDoc(raw, { category, caseName, fileName: candidate.split("/").at(-1)! });
          if (existing.body === doc.body && !existing.tail.length && !existing.preserved) return { path: candidate, created: false, noop: true };
        }
        const existingRaw = await readOptionalCaseFile(piecePath, batch, true);
        if (existingRaw !== null) {
          const existing = parseCaseDoc(existingRaw, {
            category,
            caseName,
            fileName: doc.fileName,
          });
          const same = existing.opened === doc.opened &&
            existing.closed === doc.closed &&
            existing.body === doc.body &&
            existing.preserved === doc.preserved &&
            JSON.stringify(existing.tail) === JSON.stringify(doc.tail);
          // Reuse an identical historical product without retrofitting its
          // old navigation or claiming the piece was newly written.
          if (same) return { path: piecePath, created: false, noop: true };
          if (!same) throw new WriteRefusal(
            "already_exists",
            `piece ${piecePath} already exists with different content; it was not overwritten. ` +
            "Choose a new piece title or read the existing piece and cite it in a dated tail supplement.",
          );
        }
        const navigation = casePieceNavigation({ category, caseName, date, title: intent.title });
        const linked = current.body.includes(navigation.line) || current.tail.some((tail) => tail.text.includes(navigation.line));
        // Stage this pair before merging into the caller's existing batch. A
        // failed second queue must not leave a piece without its navigation.
        const pending = forkWriteBatch(batch);
        await fsWriteFile(piecePath, serializeCaseDoc({ ...doc, updated: nowIso, bodyUpdated: nowIso }), pending);
        let catalogOnly = false;
        if (!linked) {
          const next = appendTail(current, { date, text: navigation.line });
          try {
            assertTailBudget(indexPath, serializeTailEntries([{ date, text: navigation.line }]) + "\n", serializeCaseTail(next.tail) + "\n");
            assertDocumentWrite(indexPath, serializeCaseDoc(next), currentRaw);
            await fsWriteFile(indexPath, serializeCaseDoc(next), pending);
          } catch (error) {
            if (!(error instanceof DocumentFullRefusal)) throw error;
            catalogOnly = true;
          }
        }
        if (batch) {
          mergeWriteBatch(batch, pending);
        } else {
          await flushBatch(pending, `addPiece ${identity}`);
        }
        return { path: piecePath, created: true, ...(catalogOnly ? { warnings: ["The index is full; this piece is discoverable in the case's live piece catalog. No index append was made."] } : {}) };
      }
      case "reviseUnderstanding": {
        if (!current) {
          throw new WriteRefusal(
            "not_found_on_update",
            `case ${identity} does not exist — open it first (action: open) with the full body.`,
          );
        }
        if (!readScope || !scopedRead) {
          throw new Error(
            `reviseUnderstanding refused: ${identity} requires a run-local read scope and a successful full index read`,
          );
        }
        const normalized = intent.evidence.map(normalizeEvidenceRef);
        const unread = intent.evidence.filter((ref, index) =>
          normalized[index] === null || !readScope.hasEvidence(ref)
        );
        if (intent.evidence.length === 0 || unread.length > 0) {
          throw new Error(
            `reviseUnderstanding refused: ${identity} has unread or invalid evidence refs: ` +
            `${unread.join(", ") || "(none supplied)"}. Read each records/... or case ref with readSlice/readCase first; user text is not a receipt.`,
          );
        }
        const evidence = normalized.filter((ref): ref is string => ref !== null);
        const previousRaw = await readOptionalCaseFile(scopedRead.currentPath, batch, true);
        const previousRevision = previousRaw === null ? null : caseStorageRevision(previousRaw);
        const expectedCurrentRevision = scopedRead.currentRevision === undefined
          ? scopedRead.currentContent === null ? null : caseStorageRevision(scopedRead.currentContent)
          : scopedRead.currentRevision;
        if (previousRevision !== expectedCurrentRevision) {
          throw new CaseWriteRefusal(
            "rewrite_conflict",
            `reviseUnderstanding refused: ${identity}/_current.md changed since it was read. ` +
            "Read the case again so the previous current view is preserved as history before revising it.",
          );
        }
        const previous = previousRaw === null ? null : parseCaseCurrent(previousRaw);
        const inventory = await readCasePieceInventory(category, caseName, batch);
        if (inventory === null || scopedRead.pieceInventory == null) {
          throw new Error("reviseUnderstanding refused: case piece inventory is unavailable; read the case again before updating its current basis");
        }
        if (JSON.stringify(inventory) !== JSON.stringify(scopedRead.pieceInventory)) {
          throw new CaseWriteRefusal("rewrite_conflict", "case piece inventory changed; read the case again before revising current understanding");
        }
        const nextInput = { asOf: date, evidence, body: intent.body, basis: currentReadBasis(scopedRead, readScope) };
        if (previous && isSameCaseCurrent(previous, nextInput)) {
          return { path: scopedRead.currentPath, created: false, noop: true };
        }
        const next = reviseCaseCurrent(previous, nextInput);
        if (previous && previousRaw !== null && (previous.body !== next.body || previous.history || exceededSize(documentSize(previousRaw)).length)) {
          const legacy = Boolean(previous.history) || exceededSize(documentSize(previousRaw)).length > 0;
          const sourceRaw = legacy ? previousRaw : serializeCaseCurrent({ ...previous, history: "" });
          const archive = planHistoryArchive({ category, caseName, source: "_current.md", sourceRaw, date, updated: nowIso,
            kind: legacy ? "source-snapshot" : "current-revision", previousHead: previous.historyHead });
          next.history = ""; next.historyHead = archive.headRef;
          assertDocumentWrite(scopedRead.currentPath, serializeCaseCurrent(next), previousRaw, legacy);
          for (const entry of archive.entries) await fsWriteFile(entry.path, entry.content, batch);
          if (legacy) {
            batch!.maintenance ??= new Map();
            batch!.maintenance.set(scopedRead.currentPath, { sourceRevision: caseStorageRevision(previousRaw), archiveHeadRef: archive.headRef });
          }
        }
        await fsWriteFile(scopedRead.currentPath, serializeCaseCurrent(next), batch);
        return { path: scopedRead.currentPath, created: previousRaw === null };
      }
    }
  });
}

export const currentUnderstandingSchema = z.object({
  body: z.string().min(1).describe("Free-prose current understanding, with uncertainty and competing explanations labeled"),
  evidence: z.array(z.string().min(1)).min(1).max(20).describe(
    "records/YYYY-MM-DD-HHMM or case refs actually returned by readSlice/readCase in this run",
  ),
});

export type CurrentUnderstandingReport = z.infer<typeof currentUnderstandingSchema>;

/** Apply an optional report field, refreshing the basis after a primary index write. */
export async function applyCaseCurrentUnderstanding(input: {
  category: CaseCategory;
  caseName: string;
  current: CurrentUnderstandingReport;
  date: string;
  batch?: WriteBatch;
  scope: CaseReadScope;
  refreshRead?: boolean;
}): Promise<CaseWriteOutcome> {
  if (!isCaseCategory(input.category) || !isValidCaseName(input.caseName)) {
    throw new Error("reviseUnderstanding requires a canonical case identity before any storage access");
  }
  await ensureCaseBatchBasis(input.batch);
  if (input.refreshRead) {
    await readCaseIndexForScope({
      category: input.category,
      caseName: input.caseName,
      batch: input.batch,
      scope: input.scope,
      fresh: true,
    });
  }
  return applyCaseWriteIntent(
    {
      action: "reviseUnderstanding",
      category: input.category,
      caseName: input.caseName,
      body: input.current.body,
      evidence: input.current.evidence,
    },
    input.date,
    input.batch,
    input.scope,
  );
}

/**
 * The readCase read-tool every case writer gets: two-segment reference →
 * the current full text, or a visible dead-link line. Writer-is-reader is
 * structural — a writer reads a case before naming it in a write intent.
 * With the round's batch, the read sees this round's QUEUED writes first
 * (read-your-writes) — a case opened earlier this round reads back, and a
 * case queued for deletion reports itself as gone.
 */
export function makeCaseReadTool(batch?: WriteBatch, scope?: CaseReadScope) {
  return tool({
    description:
      "Read a case by 'category/caseName' (full index.md) or 'category/caseName/pieceTitle'. " +
      "Lists exact piece refs with this run's read status, then _current.md and the unchanged full historical index. A listed piece is not a read receipt; read relevant pieces before reusing them. " +
      "Only a successful full new-root index read is an update receipt; dead links and read failures are not.",
    inputSchema: z.object({ ref: z.string() }),
    execute: async ({ ref }: { ref: string }) => {
      const parsed = parseCaseRef(ref);
      if (!parsed) return `(unparseable ref "${ref}" — expected <category>/<caseName>[/<pieceTitle>])`;
      for (const path of resolveCaseRefPaths(parsed)) {
        try {
          if (parsed.kind === "case" && path === caseIndexPath(parsed.category, parsed.caseName)) {
            const read = await readCaseIndexForScope({
              category: parsed.category,
              caseName: parsed.caseName,
              batch,
              scope,
            });
            return renderWriterCaseRead(read, scope);
          }
          const content = await fsReadFile(path, batch);
          if (isHistoryArchiveFileName(path)) return `HISTORICAL SOURCE — preserved earlier writing, not a new active conclusion or automatic evidence receipt.\n\n${content}`;
          if (parsed.kind === "case") {
            scope?.recordEvidence(`${parsed.category}/${parsed.caseName}`);
          } else if (parsed.kind === "piece") {
            scope?.recordEvidence(
              `${parsed.category}/${parsed.caseName}/${parsed.pieceFileName.replace(/\.md$/, "")}`,
              { revision: caseStorageRevision(content), coverage: "full", path },
            );
          } else {
            scope?.recordEvidence(`legacy/${parsed.name}`);
          }
          return content;
        } catch (e) {
          if (e instanceof Error && e.message.includes("deleted in this batch")) {
            return `(deleted in this round: ${ref} was queued for deletion — treat it as gone; do not cite or update it.)`;
          }
          if (!isAbsentReadError(e)) {
            return `(read failure for ${ref} at ${path}: ${e instanceof Error ? e.message : String(e)}; this is not absence and is not a read receipt)`;
          }
        }
      }
      return `(dead link: ${ref} — found under neither the new nor the legacy root; no successful read was recorded.)`;
    },
  });
}

/** The set of existing case identities (`分类/case名`) in a survey manifest. */
export function caseIdentsOfManifest(tree: Record<string, string[]>): Set<string> {
  const idents = new Set<string>();
  for (const [top, paths] of Object.entries(tree)) {
    if (!isCaseCategory(top)) continue;
    for (const p of paths) {
      const segs = p.split("/");
      if (segs.length >= 2 && segs[1]) idents.add(`${top}/${segs[1]}`);
    }
  }
  return idents;
}

/**
 * The set of case identities (`分类/case名`) this round's batch has queued
 * (writes, not deletes). The manifest is a round-START snapshot; a case
 * opened earlier in the same round exists in the queue before it exists on
 * disk — the writer's readCase sees it, so the updateIndex/appendTail/addPiece
 * gate must see it too (v0.37 §5, S4 fix).
 */
export function caseIdentsOfBatch(batch?: WriteBatch): Set<string> {
  const idents = new Set<string>();
  if (!batch) return idents;
  for (const [path, content] of batch.entries) {
    if (content === null) continue; // a queued delete is not an existing case
    const segs = path.split("/");
    // memory/<cat>/<case>/index.md or memory/<cat>/<case>/<piece>.md
    if (
      segs.length === 4 &&
      segs[0] === "memory" &&
      isCaseCategory(segs[1]!) &&
      segs[2] &&
      segs[3]!.endsWith(".md")
    ) {
      idents.add(`${segs[1]}/${segs[2]}`);
    }
  }
  return idents;
}

/** Render the manifest for a writer prompt: grouped paths, compactly. */
export function renderManifest(tree: Record<string, string[]>): string {
  const blocks = Object.entries(tree)
    .map(([top, paths]) => `### ${top}/\n${paths.filter((path) => !isHistoryArchiveFileName(path)).join("\n")}`)
    .join("\n\n");
  return blocks || "(empty manifest — no cases in memory yet)";
}

// ─── The case-writer pass (driven by HQ's archiveRound tool) ──────────

const caseWriterSchema = z.object({
  cases: z
    .array(
      z.object({
        action: z
          .enum(["skip", "open", "updateIndex", "appendTail", "addPiece", "reviseUnderstanding"])
          .describe(
            "skip: nothing worth writing (a legal answer; may still carry currentUnderstanding). " +
            "open: create a NEW case. updateIndex: rewrite an existing in-window index. " +
            "appendTail: ONE dated supplement that never reopens the settled body. " +
            "addPiece: a dated piece. reviseUnderstanding: change only _current.md (requires currentUnderstanding).",
          ),
        category: z.enum(CASE_CATEGORIES),
        caseName: z.string().describe("The case name — legal: no 4-digit lead, no separators/traversal/edge whitespace."),
        /** open/updateIndex/addPiece: the historical body (updateIndex = the WHOLE new body). */
        body: z.string().optional(),
        /** appendTail only. */
        line: z.string().optional(),
        /** addPiece only — the piece title (date is stamped mechanically). */
        title: z.string().optional(),
        /** Optional independent current view; may accompany any historical action or skip. */
        currentUnderstanding: currentUnderstandingSchema.optional(),
      }),
    )
    .max(20),
  reasoning: z.string().describe("1-2 sentences for the developer log, incl. why cases were skipped."),
});

const CASE_WRITER_SYSTEM = buildSubAgentSystem(`You are the case writer of a personal memory system (v0.19). Memory is a tree of CASES — one directory per case under a closed category (people/ events/ things/ places/ orgs/ research/ hypotheses/ tasks/ self/), each with an index.md (what it is, where it stands) and dated pieces.

${MEMORY_IS_GIT_RULE}

A conversation slice just closed. You have a compact excerpt plus readSlice for its original semantic evidence, and the case manifest for discovery. readSlice is bound to this slice: use zero-based turn ranges and follow every continuation cursor when a turning point or long message matters. Judge WHICH cases this slice touched, but call readCase successfully on every existing target BEFORE naming it in a write. Manifest membership is not a read receipt. You return write-intents; engineering validates and applies them.

## Task

Per case you judge touched:
- A new durable home → open (body = its opening overview; a focused piece gets its own distinct body).
- An existing in-window index → updateIndex with the whole new historical body.
- A settled index → appendTail for a short correction/link, or addPiece for a question worth revisiting independently. Read relevant existing pieces before adding another. A piece and its index navigation land together; neither reopens historical prose.
- Revise the independent current view → reviseUnderstanding with currentUnderstanding { body, evidence }. You may also attach currentUnderstanding to another action or skip. This writes free-prose _current.md, never the frozen index. Its as-of date is mechanical. Changed prose preserves its previous view; metadata-only refreshes do not duplicate history.
- Nothing worth writing → skip (an empty run is legal).

## Rules

1. Ground facts in evidence actually returned by readSlice/readCase. Interpretations, questions, and competing explanations are allowed when labeled; do not invent evidence.
2. currentUnderstanding.evidence must name only records/... or case refs you actually read in this run. It works for every category, not only people; use free prose, not a trait template.
3. ${DOC_LANGUAGE_RULE} Dates and mechanical evidence stamps on historical writes are not your bookkeeping. Cite evidence refs explicitly for a current view.
4. Names are permanent: content beyond a case's scope → open a NEW case, never stretch a name.
5. ${DOC_WRITE_WINDOW_RULE} ${DOCUMENT_BUDGET_RULE} Tail supplements and current-view revisions never reopen a settled index.

## Output

Call \`caseWriterOutput\` with one decision per case + a short reasoning note.

${DOC_HOUSE_STYLE}`);

export interface CaseWriterManifest {
  truncated: boolean;
  tree: Record<string, string[]>;
}

export interface LibrarianPassInput {
  sourceTurnIds?: string[];
  researchProducts?: readonly DialogueResearchRecord[];
  model: ModelConfig;
  closedSliceId: string;
  excerpt: SliceExcerpt;
  /**
   * The survey manifest — the writer reads it to judge what this slice
   * touched. Optional at the seam: a caller that has not wired the manifest
   * yet gets an empty tree (the writer then knows only what readCase tells
   * it — degraded but functional).
   */
  manifest?: CaseWriterManifest;
  /** User-local date (YYYY-MM-DD) stamping every write. */
  date: string;
  batch?: WriteBatch;
  /** @deprecated R3a: tags/strands are dead — the writer judges from the manifest. Ignored. */
  strands?: unknown;
  /** @deprecated R3a: strand merges died with the strand layer. Ignored. */
  merges?: unknown;
}

export interface LibrarianPassResult {
  /** @deprecated R3a: always [] (merge fallout died with the strand layer). */
  voided: string[];
  llmRan: boolean;
  written: string[];
  skipped: Array<{ name: string; reason: string }>;
}

/**
 * The case-writer pass (production caller: HQ's `archiveRound` tool).
 * The writer judges over the manifest +
 * its own readCase reads which cases the closed slice touched; engineering
 * applies the returned intents through the case write ops under the per-case lock.
 * Never throws.
 */
export async function runLibrarianPass(
  input: LibrarianPassInput,
): Promise<LibrarianPassResult> {
  const { model, closedSliceId, excerpt, date, batch } = input;
  const manifest = input.manifest ?? { truncated: false, tree: {} };
  const skipped: Array<{ name: string; reason: string }> = [];
  const scope = createCaseReadScope();
  // Manifest + batch are used only to reject an accidental open of an existing
  // case. Every update separately requires a successful read in this scope.
  const existing = new Set([
    ...caseIdentsOfManifest(manifest.tree),
    ...caseIdentsOfBatch(batch),
  ]);

  const prompt = `## Just-closed slice ${closedSliceId}

focus: ${excerpt.focus || "(none)"}
summary: ${excerpt.summary || "(none)"}

${sliceExcerptNotice(excerpt)}

${excerpt.turnsExcerpt || "(no conversation excerpt)"}

${input.researchProducts?.length ? `## 思考流 final result references\nThese are bounded candidate deltas from the exact result versions shared with 表达流. They are not user words, published speech, or your own read receipts. Read the original sources and target cases before reusing anything; preserve the proposal, uncertainty, and entity scope. No new document is owed just because a work produced a result.\n${JSON.stringify(input.researchProducts)}` : ""}

## Case manifest (paths are discovery only, never read receipts; readCase every existing target)

${renderManifest(manifest.tree)}
${await confirmedDocumentProducts([{ sliceId: closedSliceId, turnIds: input.sourceTurnIds ?? [] }], batch)}
${manifest.truncated ? "\n(the manifest may be truncated — a missing case shows as a readCase dead link)\n" : ""}
Report one decision per case as instructed.`;

  const result = await runSubAgent({
    role: "recall",
    model,
    system: CASE_WRITER_SYSTEM,
    prompt,
    maxSteps: 50,
    tools: {
      readCase: makeCaseReadTool(batch, scope),
      readSlice: makeSliceReadTool({ sliceId: closedSliceId, batch, scope }),
      caseWriterOutput: tool({
        description: "Report the per-case write decisions.",
        inputSchema: caseWriterSchema,
      }),
    },
    toolChoice: "required",
    reportToolName: "caseWriterOutput",
    reportSchema: caseWriterSchema,
    progress: { toolName: "librarian" },
  });
  if (!result.ok || !result.report) {
    return {
      voided: [],
      llmRan: true,
      written: [],
      skipped: [...skipped, { name: "*", reason: result.error ?? "no case-writer report" }],
    };
  }

  const written: string[] = [];
  for (const op of result.report.cases) {
    if (op.action === "skip" && !op.currentUnderstanding) continue;
    const caseName = sanitizeCaseSegment(op.caseName);
    const identity = `${op.category}/${caseName}`;
    if (op.action === "open" && existing.has(identity)) {
      skipped.push({ name: identity, reason: "case already exists — readCase it, then updateIndex / appendTail / addPiece / reviseUnderstanding" });
      continue;
    }
    let primary: CaseWriteIntent | null = null;
    try {
      switch (op.action) {
        case "open":
          if (!op.body?.trim()) throw new Error("open requires a body (the index.md body)");
          primary = { action: "open", category: op.category, caseName, body: stampEvidence(op.body, closedSliceId) };
          break;
        case "updateIndex":
          if (!op.body?.trim()) throw new Error("updateIndex requires a body (the WHOLE new body)");
          primary = { action: "rewriteIndex", category: op.category, caseName, body: stampEvidence(op.body, closedSliceId) };
          break;
        case "appendTail":
          if (!op.line?.trim()) throw new Error("appendTail requires a line");
          primary = { action: "appendTail", category: op.category, caseName, line: `${op.line.trim()} (refs: ${closedSliceId})` };
          break;
        case "addPiece":
          if (!op.title?.trim() || !op.body?.trim()) {
            throw new Error("addPiece requires a title and a body");
          }
          primary = { action: "addPiece", category: op.category, caseName, title: sanitizeCaseSegment(op.title), body: stampEvidence(op.body, closedSliceId) };
          break;
        case "reviseUnderstanding":
          if (!op.currentUnderstanding) {
            throw new Error("reviseUnderstanding requires currentUnderstanding { body, evidence }");
          }
          break;
        case "skip":
          break;
      }
      if (primary) {
        const applied = await applyCaseWriteIntent(primary, date, batch, scope);
        if (batch && input.sourceTurnIds?.length) await stageDocumentProduct(batch, { sliceId: closedSliceId, turnIds: input.sourceTurnIds }, applied.path);
        if (!applied.noop) written.push(applied.path.replace(/^memory\//, ""));
      }
    } catch (e) {
      skipped.push({ name: identity, reason: e instanceof Error ? e.message : String(e) });
      continue;
    }
    if (op.currentUnderstanding) {
      try {
        const applied = await applyCaseCurrentUnderstanding({
          category: op.category,
          caseName,
          current: op.currentUnderstanding,
          date,
          batch,
          scope,
          refreshRead: primary !== null,
        });
        if (!applied.noop) written.push(applied.path.replace(/^memory\//, ""));
      } catch (e) {
        skipped.push({ name: `${identity}/_current.md`, reason: e instanceof Error ? e.message : String(e) });
      }
    }
  }

  return { voided: [], llmRan: true, written, skipped };
}

// ─── The scribe pass (书记段序 7) ──────────────────────────────────────────

const scribeSchema = z.object({
  entries: z
    .array(
      z.object({
        id: z.string().describe("The marker id this entry answers."),
        action: z.enum(["open", "rewriteIndex", "appendTail", "addPiece", "reviseUnderstanding", "covered", "skip"]).optional().describe(
          "Choose by reading purpose. covered finishes a marker using a fully read coveredRef; skip leaves it pending. Legacy body-only reports cannot append to a settled case.",
        ),
        body: z.string().optional().describe("Authored prose for open, rewriteIndex or addPiece; never a compressed tail essay."),
        line: z.string().optional().describe("appendTail: one short correction or navigation line."),
        title: z.string().optional().describe("addPiece: the focused reading question, without a date prefix."),
        overviewBody: z.string().optional().describe("addPiece on a NEW case: a distinct opening overview; body belongs only to the piece."),
        coveredRef: z.string().optional().describe("covered: exact case/piece ref fully read in this run that already covers this marker."),
        reason: z.string().optional().describe("covered: explain what that read document already covers; skip: explain why no write is warranted now."),
        currentUnderstanding: currentUnderstandingSchema.optional(),
      }),
    )
    .max(20),
  reasoning: z.string().describe("1-2 sentences for the developer log."),
});

const SCRIBE_SYSTEM = buildSubAgentSystem(`You are the scribe of a personal memory system. A conversation slice left MARKERS — one-line notes the reply segment dropped when it judged something worth sedimenting (something to keep, a task the user stated). Your job: write each marker into its CASE.

${MEMORY_IS_GIT_RULE}

You are shown: a compact slice excerpt, and per marker the marker itself plus the full current index.md, any _current.md, and an inventory of dated pieces. The successful index preloads are your case read receipts; listed pieces remain UNREAD. Use readCase to inspect relevant pieces before reusing them or adding another. readSlice is bound to this slice for any earlier turn, long message, or turning point the excerpt omitted; use ranges and continuation explicitly.

## Task

One decision per marker, chosen by what a future reader needs:
- covered: a document actually read already covers it; supply coveredRef and reason. This completes the marker without rewriting the document. A title in the inventory is not coverage.
- skip: no useful write now; give a reason. This leaves the marker pending, as does omitting it.
- open / rewriteIndex: a new case's opening prose or a whole in-window revision, in body.
- appendTail: one short correction or navigation in line, never a multi-paragraph argument.
- addPiece: a focused document in body with a bare title. If the case is new, supply a distinct overviewBody. The piece and its index navigation land together.
- reviseUnderstanding: currentUnderstanding { body, evidence }, without duplicating it in a historical tail. This changes only _current.md.
Other write actions may also carry currentUnderstanding. Pasted source material must go in addPiece, preserving its original line breaks; engineering appends that source after your interpretation. Do not reproduce it in your authored body.

## Rules

1. Ground facts in the marker, the preloaded case text, and evidence actually returned by readSlice. Do not invent evidence; label interpretation, counterevidence, questions, and unknowns honestly.
2. currentUnderstanding.evidence may cite only the preloaded target case, pieces actually read through readCase, or records/... read through readSlice in this run. Any category may have a free-prose current view.
3. ${DOC_LANGUAGE_RULE} Dates and mechanical evidence stamps on historical writes are not your bookkeeping; cite current-view evidence explicitly.
4. Never contradict shown existing text silently — preserve contrary evidence and label your interpretation.
5. ${DOC_WRITE_WINDOW_RULE} ${DOCUMENT_BUDGET_RULE} Tail supplements and current-view revisions never reopen a settled index.

## Output

Call \`scribeOutput\` with your decisions + a short reasoning note. A verified covered outcome completes a marker without a document write; skipped or refused decisions stay for a later pass.

${DOC_HOUSE_STYLE}`);

/** The v0.15 singular entityKind → the v0.19 category (§B.6). */
const ENTITY_CATEGORY: Record<string, CaseCategory> = {
  event: "events",
  person: "people",
  object: "things",
  place: "places",
  org: "orgs",
};

interface ScribeTarget {
  marker: DocMarker;
  category: CaseCategory;
  caseName: string;
  existed: boolean;
  currentText: string | null;
  displayText: string | null;
}

/**
 * Resolve a marker to its target case. Returns null (+reason) when the
 * marker cannot name a legal case — a scribe never writes an illegal name
 * (the slice-id namespace red line included).
 */
function resolveScribeTarget(
  marker: DocMarker,
): { category: CaseCategory; caseName: string } | { error: string } {
  const validate = (
    category: CaseCategory,
    rawName: string,
  ): { category: CaseCategory; caseName: string } | { error: string } => {
    // Markers carry model-written names; normalize before the red-line check
    // (2026-10-12 discipline) so the portable variant gets written instead of
    // the marker being skipped for a character Windows cannot check out.
    const caseName = sanitizeCaseSegment(rawName.trim());
    if (!caseName || !isValidCaseName(caseName)) {
      return { error: `illegal case name: ${JSON.stringify(rawName)}` };
    }
    return { category, caseName };
  };

  if (marker.kind === "task") return validate("tasks", marker.title);
  if (marker.kind !== "sediment") {
    return { error: `marker kind ${marker.kind} is not the scribe's` };
  }
  if (marker.docType === "entity") {
    if (!marker.entityKind) return { error: "entity sediment requires entityKind" };
    return validate(ENTITY_CATEGORY[marker.entityKind] ?? "things", marker.title);
  }
  if (marker.target) {
    const ref = parseCaseRef(marker.target);
    if (ref && ref.kind !== "legacy") {
      return validate(ref.category, ref.caseName);
    }
    return { error: `illegal target case: ${JSON.stringify(marker.target)}` };
  }
  return validate("research", marker.title);
}

export interface ScribePassInput {
  sourceTurnIds?: string[];
  model: ModelConfig;
  /** The slice whose agent.md is the mailbox (closed slice at a boundary, else the active one). */
  sliceId: string;
  excerpt: SliceExcerpt;
  /** User-local date (YYYY-MM-DD) stamping every write. */
  date: string;
  batch?: WriteBatch;
  /** @deprecated R3a: strands are dead — 名录 died with the topic homes. Ignored. */
  strands?: unknown;
}

export interface ScribePassResult {
  ran: boolean;
  written: string[];
  skipped: Array<{ id: string; reason: string }>;
}

/** Coverage must name a real full read, still at that version when accepted. */
async function requireCoveredDocument(ref: string, scope: CaseReadScope, batch: WriteBatch): Promise<string> {
  const parsed = parseCaseRef(ref);
  const normalized = normalizeEvidenceRef(ref);
  if (!normalized || !parsed || parsed.kind === "legacy") throw new Error("covered requires a canonical case or piece ref");
  const proof = scope.getEvidenceReads(normalized).find((entry) => entry.coverage === "full" && entry.path);
  if (!proof?.path) throw new Error(`covered requires a successful full readCase of ${normalized}; a listed title is not coverage`);
  const raw = await readOptionalCaseFile(proof.path, batch, true);
  if (raw === null || caseStorageRevision(raw) !== proof.revision) {
    throw new Error(`covered refused: ${normalized} changed since it was read; re-read and decide again`);
  }
  if (parsed.kind === "case") {
    const read = requireCaseIndexRead(scope, parsed.category, parsed.caseName);
    const current = await readOptionalCaseFile(read.currentPath, batch, true);
    if ((current === null ? null : caseStorageRevision(current)) !== read.currentRevision) {
      throw new Error(`covered refused: ${normalized}/_current.md changed since it was read`);
    }
  }
  return normalized;
}

/**
 * The scribe pass: read the slice's agent.md, pick up unprocessed
 * sediment/task markers, write their cases (read-before-write under the
 * per-case lock, via the case write ops), and record each processed marker back
 * into the same agent.md. Never throws.
 */
export async function runScribePass(input: ScribePassInput): Promise<ScribePassResult> {
  const { model, sliceId, excerpt, date, batch: parentBatch } = input;
  const batch = forkWriteBatch(parentBatch);
  const skipped: Array<{ id: string; reason: string }> = [];
  const scope = createCaseReadScope();

  let agentMd: string;
  try {
    // Dual-root read (v0.19 R2): the mailbox of a slice created before the
    // root move lives under the legacy slices root.
    agentMd = await readSlicePart(sliceId, "agent", batch);
  } catch {
    return { ran: false, written: [], skipped }; // no agent.md yet — nothing to pick up
  }

  const processed = extractProcessedMarkerIds(agentMd, SCRIBE_RECORD_PREFIX);
  const todo = extractDocMarkers(agentMd).filter(
    (m) => (m.kind === "sediment" || m.kind === "task") && !processed.has(m.id),
  );
  if (todo.length === 0) return { ran: false, written: [], skipped };

  // Resolve targets + pre-read the current cases (writer-is-reader).
  const targets: ScribeTarget[] = [];
  for (const marker of todo) {
    const resolved = resolveScribeTarget(marker);
    if ("error" in resolved) {
      skipped.push({ id: marker.id, reason: resolved.error });
      continue;
    }
    let currentText: string | null = null;
    let displayText: string | null = null;
    try {
      const read = await readCaseIndexForScope({
        category: resolved.category,
        caseName: resolved.caseName,
        batch,
        scope,
        fresh: true,
      });
      currentText = read.content;
      displayText = renderWriterCaseRead(read, scope);
    } catch (error) {
      if (!isAbsentReadError(error)) {
        skipped.push({
          id: marker.id,
          reason: `target read failed (not absence): ${error instanceof Error ? error.message : String(error)}`,
        });
        continue;
      }
    }
    targets.push({
      marker,
      category: resolved.category,
      caseName: resolved.caseName,
      existed: currentText !== null,
      currentText,
      displayText,
    });
  }
  if (targets.length === 0) return { ran: false, written: [], skipped };

  const markerBlocks = targets
    .map(({ marker, category, caseName, existed, displayText }) => {
      const head =
        `### marker ${marker.id} (kind=${marker.kind}${marker.docType ? `/${marker.docType}` : ""}` +
        `${marker.entityKind ? `/${marker.entityKind}` : ""})\n` +
        `title: ${marker.title}\nnote: ${marker.note || "(none)"}` +
        `${marker.dateAnchor ? `\ndateAnchor: ${marker.dateAnchor}` : ""}\n` +
        `${marker.body?.trim() ? "sourceMaterial: preserved separately; use addPiece or verified covered, never a tail\n" : ""}` +
        `target case: ${category}/${caseName} (${existed ? "exists — full index and current view below" : "to be opened"})`;
      return displayText ? `${head}\n\n${displayText.trim()}` : head;
    })
    .join("\n\n");

  const prompt = `## Slice ${sliceId}

focus: ${excerpt.focus || "(none)"}
summary: ${excerpt.summary || "(none)"}

${excerpt.turnsExcerpt || "(no conversation excerpt)"}

${sliceExcerptNotice(excerpt)}

${await confirmedDocumentProducts([{ sliceId, turnIds: input.sourceTurnIds ?? [] }], batch)}

## Markers to write (targets read before writing)

${markerBlocks}

Report one entry per marker as instructed.`;

  const result = await runSubAgent({
    role: "recall",
    model,
    system: SCRIBE_SYSTEM,
    prompt,
    maxSteps: 50,
    tools: {
      readSlice: makeSliceReadTool({ sliceId, batch, scope }),
      readCase: makeCaseReadTool(batch, scope),
      scribeOutput: tool({
        description: "Report the per-marker case entries.",
        inputSchema: scribeSchema,
      }),
    },
    toolChoice: "required",
    reportToolName: "scribeOutput",
    reportSchema: scribeSchema,
    progress: { toolName: "doc-scribe" },
  });
  if (!result.ok || !result.report) {
    return {
      ran: true,
      written: [],
      skipped: [...skipped, { id: "*", reason: result.error ?? "no scribe report" }],
    };
  }

  const byMarker = new Map(targets.map((t) => [t.marker.id, t]));
  const written: string[] = [];
  const recordLines: string[] = [];
  const accepted = new Set<string>();

  for (const entry of result.report.entries) {
    const target = byMarker.get(entry.id);
    if (!target || accepted.has(entry.id)) {
      skipped.push({ id: entry.id, reason: "report answers an unknown marker" });
      continue;
    }
    if (entry.action === "skip") {
      skipped.push({ id: entry.id, reason: entry.reason?.trim() || "no write warranted now" });
      continue;
    }
    const body = entry.body?.trim() ?? "";
    const { marker, category, caseName } = target;
    // The task's date anchor is a mechanical fact — it rides the entry
    // whether the prose remembers it or not.
    const anchorLine =
      marker.kind === "task" && marker.dateAnchor
        ? `日期锚：${marker.dateAnchor}\n\n`
        : "";
    // 证据·大段文字 (§C.1): a marker carrying the full pasted text opens its
    // case with the TEXT as the evidence — origin stamped, verbatim. The
    // model's prose frames it above the original.
    const pastedBlock = marker.body?.trim()
      ? `\n\n—— 原文 ——\n原始材料（${date}，切片 ${sliceId}；归属以原始记录为准）：\n\n${marker.body}\n\n—— 原文结束 ——`
      : "";
    const stamped = stampEvidence(anchorLine + body + pastedBlock, sliceId);
    const pending = forkWriteBatch(batch);
    const entryWritten: string[] = [];
    let productRef = `${category}/${caseName}`;
    try {
      await ensureCaseBatchBasis(batch);
      pending.baseHeadSha = batch.baseHeadSha;
      if (entry.action === "covered") {
        if (!entry.coveredRef || !entry.reason?.trim()) throw new Error("covered requires coveredRef and a reason grounded in that document");
        productRef = await requireCoveredDocument(entry.coveredRef, scope, pending);
      } else {
        let action = entry.action;
        if (!action) {
          if (!target.existed) action = "open";
          else if (isWithinWriteWindow(parseCaseDoc(target.currentText ?? "", { category, caseName, fileName: "index.md" }).bodyUpdated, Date.now())) action = "rewriteIndex";
          else throw new Error("Legacy body-only result cannot append to a settled case. Replan with appendTail + a short line, addPiece + title/body, reviseUnderstanding, or covered + a fully read ref.");
        }
        if (pastedBlock && action !== "addPiece") throw new Error("Pasted source material requires addPiece so its wording and line breaks remain intact; provide title and overviewBody for a new case");
        let intent: CaseWriteIntent | null = null;
        if (action === "reviseUnderstanding") {
          if (!entry.currentUnderstanding) throw new Error("reviseUnderstanding requires currentUnderstanding");
        } else if (action === "appendTail") {
          const line = entry.line?.trim();
          if (!line || /[\r\n]/.test(line)) throw new Error("appendTail requires one short line; put multi-line material in addPiece instead");
          intent = { action, category, caseName, line: `${anchorLine.replace(/\s+/g, " ")}${line} (refs: ${sliceId})` };
        } else {
          if (!body) throw new Error(`${action} requires body`);
          if (action === "addPiece") {
            const title = sanitizeCaseSegment(entry.title?.trim() ?? "");
            if (!title) throw new Error("addPiece requires a focused title");
            if (!target.existed) {
              const indexBody = caseOpeningBody({ category, caseName, date, body, pieceTitle: title, overviewBody: entry.overviewBody });
              const opened = await applyCaseWriteIntent({ action: "open", category, caseName, body: indexBody }, date, pending);
              entryWritten.push(opened.path.replace(/^memory\//, ""));
              await readCaseIndexForScope({ category, caseName, batch: pending, scope, fresh: true });
            }
            intent = { action, category, caseName, title, body: stamped };
          } else {
            intent = { action, category, caseName, body: stamped };
          }
        }
        if (intent) {
          const applied = await applyCaseWriteIntent(intent, date, pending, target.existed || action === "addPiece" ? scope : undefined);
          if (!applied.noop) entryWritten.push(applied.path.replace(/^memory\//, ""));
          productRef = intent.action === "addPiece" ? applied.path.replace(/^memory\//, "").replace(/\.md$/, "") : `${category}/${caseName}`;
        }
        if (entry.currentUnderstanding) {
          const applied = await applyCaseCurrentUnderstanding({ category, caseName, current: entry.currentUnderstanding, date, batch: pending, scope, refreshRead: intent !== null });
          if (!applied.noop) entryWritten.push(applied.path.replace(/^memory\//, ""));
        }
      }
      if (input.sourceTurnIds?.length) for (const path of entryWritten) await stageDocumentProduct(pending, { sliceId, turnIds: input.sourceTurnIds }, `memory/${path}`);
      mergeWriteBatch(batch, pending);
      written.push(...entryWritten);
    } catch (e) {
      skipped.push({ id: entry.id, reason: e instanceof Error ? e.message : String(e) });
      continue;
    }
    accepted.add(entry.id);
    recordLines.push(
      `${SCRIBE_RECORD_PREFIX} ${JSON.stringify({ id: entry.id, doc: productRef, outcome: entry.action === "covered" ? "covered" : "written" })}`,
    );
  }

  // The mailbox bookkeeping: processed markers get a record line in the SAME
  // agent.md, so the next pass (any stream) never double-writes them.
  if (recordLines.length > 0) {
    try {
      // Dual-root read (the slice may predate the root move), and the record
      // append goes back to the root the mailbox was actually read from —
      // splitting markers (legacy) from records (new) would re-process every
      // marker on the next pass.
      const resolved = await readSlicePartResolved(sliceId, "agent", batch).catch(() => null);
      const fresh = resolved?.content ?? "";
      const next = fresh.trimEnd()
        ? `${fresh.trimEnd()}\n\n${recordLines.join("\n")}\n`
        : `${recordLines.join("\n")}\n`;
      await fsWriteFile(resolved?.path ?? sliceIdToAgentPath(sliceId), next, batch);
      if (parentBatch) {
        mergeWriteBatch(parentBatch, batch);
      } else {
        await flushBatch(batch, `scribe ${sliceId}`);
      }
    } catch (error) {
      return { ran: true, written: [], skipped: [...skipped, { id: "*", reason: `scribe publication failed: ${error instanceof Error ? error.message : String(error)}` }] };
    }
  }

  return { ran: true, written, skipped };
}
