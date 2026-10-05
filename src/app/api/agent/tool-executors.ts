/**
 * Tool executors for the shared WorkflowAgent �?standalone "use step" functions.
 *
 * Each executor is an independent durable step: automatically retried on
 * failure, persisted, and visible in the workflow dashboard. Context (repo,
 * owner, useGithub, sliceId) flows through WorkflowAgent's
 * `toolsContext` mechanism rather than JavaScript closures, so it stays
 * serializable across workflow/step boundaries.
 *
 * Used by the chat turn workflow — the tool
 * definitions that bind these executors live in ./tools.ts.
 */

import { streamText, type UIMessageChunk } from "ai";
import { getWritable } from "workflow";
import { getHookByToken, resumeHook, start } from "workflow/api";
// Side effect: keep the step-bundle copy of StepBoundaryLanguageModel
// evaluated in the step runtime so the Workflow 5 SWC plugin's inlined
// serialization-class registration for it runs before any doStreamStep
// message is handled (see src/lib/models/step-boundary-model.ts).
import "@/lib/models/step-boundary-model";
import { readFile } from "@/lib/tools/readFile";
import { listFiles } from "@/lib/tools/listFiles";
import {
  readFileLocal,
  listFilesLocal,
} from "@/lib/tools/local-fs";
import {
  readFileDemo,
  listFilesDemo,
} from "@/lib/demo/demo-fs";

import { searchViaFlash, SEARCH_TIMEOUT_MS, type WebSearchResult } from "@/lib/search/flash-search";
import { isPrivateHost, extractText, fetchWithGuard, readBodyCapped, FETCH_BODY_MAX_BYTES } from "@/lib/search/fetch-utils";
import { describeImage } from "@/lib/vision/describe-image";
import { formatImageMetadata } from "@/lib/vision/image-meta";
import { isAIConfigured } from "@/lib/capabilities";
import {
  checkDocRework,
  recordDocRead,
  logDocReworkSignal,
} from "@/lib/episodic/rework-signal";
import {
  HQ_TOKEN,
  hqRun,
  type HQBriefPayload,
} from "@/app/api/evolution/hq-run";
import { recordHQDispatch } from "@/app/api/evolution/hq-status-store";
import { questionRun } from "@/app/api/evolution/question-run";
import { readSelfSop } from "@/lib/evolution/store";

import { extractSliceIds } from "@/lib/docs/docs-query";
import { readCaseAttachment } from "@/lib/tools/attachments";
import {
  parseCaseRef,
  resolveCaseRefPaths,
  parseCaseDoc,
  normalizeCaseRefText,
  caseIndexPath,
  isValidCaseName,
  CASE_CATEGORY_LIST,
  type CaseRef,
} from "@/lib/docs";
import {
  DOC_MARKER_PREFIX,
  extractDocMarkers,
  applyCaseWriteIntent,
  type DocMarker,
} from "@/lib/episodic/flash/librarian";
import { fsReadFile, fsWriteFile } from "@/lib/episodic/io-helpers";
import { sliceIdToAgentPath } from "@/lib/episodic/manager";
import {
  CURRENT_PREVIOUSLY_PATH,
  slicePartPathCandidates,
  indexPathCandidates,
  RECORDS_ROOT,
  LEGACY_SLICES_ROOT,
  type SlicePart,
} from "@/lib/episodic";
import { getOctokit } from "@/lib/github/client";
import { getRepoConfig } from "@/lib/capabilities";
import { getDefaultBranch } from "@/lib/tools/batch-write";
import { migrateToV3, isCardFormat } from "@/lib/episodic/previously-format";
import {
  annotateSliceWithLocalTime,
  sliceLocalBanner,
} from "@/lib/episodic/time-localize";
import { buildDateAnchors } from "@/lib/time/relative";
import { formatLocalTime } from "@/lib/turn-priming";
import { loadUserConfig } from "@/lib/config/loader";
import { DEFAULTS } from "@/lib/config/defaults";
import {
  splitTurns,
  splitParagraphs,
  segmentSearch,
  textLines,
  searchResultToString,
} from "@/lib/retrieval/doc-segments";
import {
  getBridgeCommand,
  getBridgeTimeoutMs,
  runBridge,
  splitBridgeCommand,
  BRIDGE_PROTOCOL_VERSION,
  type BridgeRunResult,
} from "@/lib/bridge";
import { resolveMainModelFromConfig } from "@/lib/models/resolve";
import { resolveSubAgentModel } from "@/lib/agents/sub-agent-runner";
import { createModel } from "@/lib/models/provider";
import { normalizeReasoningEffort } from "@/lib/models/effort-injector";
import type { ModelConfig } from "@/lib/models/registry";
import { withStepTimeout } from "@/lib/chat/step-timeout";
import { isTransientError, triageErrorMessage } from "@/lib/chat/tool-triage";
import {
  describeRoom,
  formatRoomDescription,
} from "@/lib/game/describe-room";
import {
  shouldEmitProgress,
  type ProgressWriteState,
} from "@/lib/chat/progress-throttle";
import {
  parseSliceId,
  parseTurns,
  applyRange,
  reassembleSlice,
  type ParsedTurn,
} from "@/lib/episodic/turn-parser";

// ─── Shared tool contexts ────────────────────────────────────────────────

/**
 * Context each chat tool receives from WorkflowAgent's toolsContext mechanism.
 * Kept serializable so it survives workflow step boundaries.
 */
export interface ToolContext {
  /** GitHub repo name (or "local" when running without GITHUB_TOKEN). */
  repo: string;
  /** GitHub repo owner (or "local" when running without GITHUB_TOKEN). */
  owner: string;
  /** Whether GitHub token is configured. Off �?local filesystem. */
  useGithub: boolean;
  /** Whether demo mode is active (remote benchmark data, read-only). */
  useDemo: boolean;
  /** The current time-slice id. */
  sliceId: string;
  /** Recent conversation turns (last exchange + current user msg). */
  recentTurns: Array<{ role: string; content: string }>;
  /**
   * The turn's assembled system prompt (see turn-workflow.ts). thinkDeep reads
   * it to reuse the main agent's exact prompt prefix, so sub-agent calls hit
   * the provider's prompt cache warmed by the main agent's first step.
   */
  baseSystemPrompt?: string;
  /**
   * The turn's resolved MAIN model — the same config injected for the main
   * agent. All sub-agents (thinkDeep, recall) use it directly so each call
   * skips the per-step `resolveMainModelFromConfig()` GitHub round-trip.
   */
  mainModel?: ModelConfig;
  /**
   * The user's IANA timezone (e.g. "Asia/Shanghai") — read tools use it to
   * pre-render local-time annotations so the agent never converts UTC itself.
   */
  timezone?: string;
  /** The turn's start instant (UTC ISO) — anchors local-time rendering. */
  startedAtIso?: string;
  /** UI locale ("zh" | "en") — relative-time annotations follow it. */
  locale?: string;
  /**
   * Image attachments extracted from the current user message when the main
   * model lacks vision. Each entry is a data URL. These ride the workflow step
   * boundary so viewImage can resolve `attachment:N`; they are capped to 4
   * images and client-compressed to 1568px to keep the payload bounded.
   */
  imageAttachments?: string[];
}

/**
 * Shorthand for the options object each execute function receives.
 *
 * The AI SDK's `ToolExecutionOptions` provides `{ toolCallId, messages,
 * abortSignal, context, ... }`; we narrow it to the fields our executors use.
 * `toolCallId` is the client-side routing key for `data-tool-progress` chunks
 * (merged into the matching tool card in buildStream).
 */
type ExecuteOpts<C> = {
  context: C;
  toolCallId: string;
};

/**
 * Best-effort live progress write to the run stream (`data-tool-progress`),
 * routed client-side by `toolCallId` into the matching tool card. One write per
 * call — tools that want continuous streaming throttle on their own (thinkDeep)
 * and await the write when the status must settle BEFORE the tool result is
 * ordered (webSearch emits a final "found N" status). A stream failure
 * must never fail the tool, so write errors are swallowed and the lock released
 * after each write (an unreleased lock keeps the step's HTTP request alive).
 */
function emitToolProgress(
  toolCallId: string,
  toolName: string,
  text: string,
  stage?: string,
): Promise<void> {
  try {
    const writer = getWritable<UIMessageChunk>().getWriter();
    return writer
      .write({
        type: "data-tool-progress",
        id: `tool-${toolCallId}`,
        data: { toolCallId, toolName, text, stage },
      })
      .then(() => writer.releaseLock())
      .catch(() => {});
  } catch {
    // getWritable() can throw outside a step context — never fail the tool.
    return Promise.resolve();
  }
}

// ─── Concept tool executors ────────────────────────────────

/**
 * Deterministic domain outcomes ("file not found", etc.) must reach the MODEL
 * as tool results, not throw. A thrown error causes workflow retries on errors
 * that can never succeed.
 */
const DOMAIN_ERROR_RE =
  /^(File not found|Directory not found|Access denied)|is (a directory, not a file|not a regular file)|too large/;

function domainError(e: unknown): string | null {
  return e instanceof Error && DOMAIN_ERROR_RE.test(e.message)
    ? e.message
    : null;
}

/**
 * Backend-dispatched raw read (demo / GitHub / local) — the dispatch every
 * slice read below shares.
 */
async function readRawBackend(ctx: ToolContext, path: string): Promise<string> {
  if (ctx.useDemo) return readFileDemo(path);
  if (ctx.useGithub) return readFile(path, ctx.repo, ctx.owner);
  return readFileLocal(path);
}

/**
 * Dual-root slice-part read (v0.19 R2): the new records root first, the
 * legacy slices root on a miss — slices created before the root move stay
 * readable.
 */
async function readSliceRawDual(
  ctx: ToolContext,
  sliceId: string,
  part: SlicePart,
): Promise<string> {
  const [primary, fallback] = slicePartPathCandidates(sliceId, part);
  try {
    return await readRawBackend(ctx, primary);
  } catch {
    return readRawBackend(ctx, fallback);
  }
}


// ── readSlice — read a time slice's core conversation ─────────────────

/** Range filter for readSlice. Extends the classic turn filters (turns / last /
 *  date) with the shared Document Segment Read protocol: keyword search
 *  (`search`, hits degrade to the full slice) and line ranges (`lines`). */
export type ReadSliceRange = {
  type: "turns" | "last" | "date" | "search" | "lines";
  indices?: number[];
  count?: number;
  after?: string;
  keywords?: string[];
  context?: number;
  start?: number;
  end?: number;
};

export async function readSliceExecute(
  { sliceId, range }: { sliceId: string; range?: ReadSliceRange },
  { context: ctx }: ExecuteOpts<ToolContext>,
): Promise<string> {
  "use step";
  const parsed = parseSliceId(sliceId);
  if (!parsed) {
    return "ERROR: Invalid slice ID. Expected format: YYYY-MM-DD-HHMM (e.g. 2026-07-24-1500).";
  }
  try {
    const raw = await readSliceRawDual(ctx, sliceId, "core");

    // Apply range filter if requested
    let content: string;
    if (range) {
      // Keyword search — the Document Segment Read protocol. Matches return
      // only the relevant turns; a miss degrades to the full slice with a note.
      if (range.type === "search") {
        const keywords = range.keywords ?? [];
        const context = range.context ?? 1;
        const segments = splitTurns(raw);
        const hits = segmentSearch(segments, keywords, context, context);
        content = searchResultToString(sliceId, keywords, hits, raw);
      } else if (range.type === "lines") {
        // Line range — read the file like a code file, 1-indexed inclusive.
        const { content: lineContent, clamped } = textLines(raw, range.start ?? 1, range.end ?? 1);
        if (lineContent === "" && (range.start ?? 1) > (range.end ?? 1)) {
          return `ERROR: Invalid line range ${range.start}-${range.end} in ${sliceId}.`;
        }
        const header = `Lines ${range.start}-${range.end} of ${sliceId}${clamped ? " (clamped)" : ""}:\n\n`;
        content = lineContent === "" ? `${header}(empty range)` : header + lineContent;
      } else {
        // Classic turn filters.
        const { frontmatter, turns } = parseTurns(raw);
        const filtered = applyRange(turns, range as { type: "turns" | "last" | "date" });
        content =
          filtered.length === 0
            ? `${frontmatter}\n\n_(No turns matched the requested range.)_`
            : reassembleSlice(frontmatter, filtered);
      }
    } else {
      content = raw;
    }

    // Pre-render the user's local time so the agent never converts UTC itself.
    const result = ctx.timezone
      ? annotateSliceWithLocalTime(content, ctx.timezone, sliceId)
      : content;

    // doc_rework probe (design v0.15 §4.4): the read slice is one a readDoc
    // earlier this conversation referenced — the document was not credited
    // for the fact it carried. Logged as an audit line on the slice's
    // agent.md (v0.19 R4/R5: the fitness bucket it used to feed is retired).
    const docReworkFile = checkDocRework(ctx.sliceId, sliceId);
    if (docReworkFile) {
      await logDocReworkSignal(ctx.sliceId, sliceId, docReworkFile);
    }

    return result;
  } catch (e) {
    const msg = domainError(e);
    if (msg === null) throw e;
    return `ERROR: ${msg}. This time slice does not exist.`;
  }
}

// ── readAgentTimeline �?read the agent's cognition for a slice ──────────

export async function readAgentTimelineExecute(
  { sliceId }: { sliceId: string },
  { context: ctx }: ExecuteOpts<ToolContext>,
): Promise<string> {
  "use step";
  const parsed = parseSliceId(sliceId);
  if (!parsed) {
    return "ERROR: Invalid slice ID. Expected format: YYYY-MM-DD-HHMM.";
  }
  try {
    return await readSliceRawDual(ctx, sliceId, "agent");
  } catch (e) {
    const msg = domainError(e);
    if (msg === null) throw e;
    return `ERROR: ${msg}. Agent timeline not available for this slice.`;
  }
}

// ── readPreviously �?read the 前情提要 for a slice ─────────────────────

export async function readPreviouslyExecute(
  { sliceId }: { sliceId?: string },
  { context: ctx }: ExecuteOpts<ToolContext>,
): Promise<string> {
  "use step";

  // No sliceId → the LIVE card (current-previously.md), the one the current
  // conversation actually runs on (v0.7 real-time card). A per-slice arg reads
  // that slice's historical snapshot.
  if (!sliceId) {
    const raw = ctx.useDemo
      ? await readFileDemo(CURRENT_PREVIOUSLY_PATH)
      : ctx.useGithub
        ? await readFile(CURRENT_PREVIOUSLY_PATH, ctx.repo, ctx.owner)
        : await readFileLocal(CURRENT_PREVIOUSLY_PATH);
    return raw.trim() ? (isCardFormat(raw) ? raw : migrateToV3(raw, "current")) : raw;
  }

  const sid = sliceId;
  const parsed = parseSliceId(sid);
  if (!parsed) {
    return "ERROR: Invalid slice ID. Expected format: YYYY-MM-DD-HHMM.";
  }
  try {
    // Dual-root read (v0.19 R2). Legacy (v1/v2) files are migrated on the
    // fly; the v4 user card is read as-is. Never exposes the old
    // 长期记忆/短期记忆 headers.
    const raw = await readSliceRawDual(ctx, sid, "previously");
    const content = raw.trim() ? migrateToV3(raw, sid) : raw;
    if (!ctx.timezone || content === "") return content;
    // Prepend the user-local time banner so the model knows when the snapshot
    // was taken without converting the UTC Updated stamp itself.
    return `${sliceLocalBanner(sid, ctx.timezone)}\n\n${content}`;
  } catch (e) {
    const msg = domainError(e);
    if (msg === null) throw e;
    return `ERROR: ${msg}. previously.md not available for this slice.`;
  }
}

// ─── Case-tree readers (v0.19 §A.2.1 — the reply segment's read surface) ──

/**
 * listTree — list the memory tree ONCE, grouped by top-level category
 * (v0.19 §A.2.1). A TRANSITIONAL PLACEHOLDER: a dedicated retrieval tool
 * will replace it later (user decision). Purely mechanical: no LLM, no
 * ranking, no relevance score — the paths themselves (category / case name /
 * date all live on the path) are the index.
 *
 * - GitHub: ONE recursive Git Trees API call returns every path under the
 *   repo (the same pattern as timeline/enumerate.ts, widened to the whole
 *   `memory/` tree); the API's own `truncated` flag passes through.
 * - Local / demo: a recursive walk through the listFiles layer.
 *
 * `config/` is filtered out mechanically (engineering state, not documents).
 * records/ collapses to slice directories (YYYY/MM/DD/HHMM) — the three
 * files inside a record are fixed machinery, the slice dir is its identity.
 */
export interface ListTreeResult {
  /** True when the GitHub tree API truncated the listing (list may be incomplete). */
  truncated: boolean;
  /** Paths relative to `memory/`, grouped by top-level category, each ascending. */
  tree: Record<string, string[]>;
}

export async function listTreeExecute(
  _input: Record<string, never>,
  { context: ctx }: ExecuteOpts<ToolContext>,
): Promise<ListTreeResult> {
  "use step";
  if (ctx.useGithub) return listTreeGitHub(ctx);
  return listTreeWalk(ctx);
}

async function listTreeGitHub(ctx: ToolContext): Promise<ListTreeResult> {
  const { owner, repo } = { owner: ctx.owner, repo: ctx.repo };
  const octokit = getOctokit();
  const branch = await getDefaultBranch();
  const { data: ref } = await octokit.rest.git.getRef({
    owner,
    repo,
    ref: `heads/${branch}`,
  });
  const { data: tree } = await octokit.rest.git.getTree({
    owner,
    repo,
    tree_sha: ref.object.sha,
    recursive: "1",
  });

  const paths: string[] = [];
  for (const item of tree.tree ?? []) {
    if (item.type !== "blob") continue;
    const p = item.path ?? "";
    if (!p.startsWith("memory/")) continue;
    const rel = p.slice("memory/".length);
    if (rel === "" || rel.startsWith("config/")) continue; // config/ = engineering state
    // The pre-v0.19 settings file is the same engineering state under an old
    // name — still on disk as the loader's read fallback, never a case.
    if (rel === "user/config.json") continue;
    paths.push(rel);
  }
  return { truncated: tree.truncated === true, tree: groupTreePaths(paths) };
}

async function listTreeWalk(ctx: ToolContext): Promise<ListTreeResult> {
  const paths: string[] = [];
  const listDir = (path: string) =>
    ctx.useDemo ? listFilesDemo(path) : listFilesLocal(path);

  async function walk(dir: string): Promise<void> {
    let entries: Array<{ name: string; type: string }>;
    try {
      entries = await listDir(dir);
    } catch {
      return; // missing dir — a fresh memory root, fine
    }
    for (const e of entries) {
      const p = `${dir}/${e.name}`;
      if (e.type === "dir") {
        await walk(p);
      } else if (
        p.startsWith("memory/") &&
        !p.startsWith("memory/config/") &&
        p !== "memory/user/config.json" // legacy settings — same state (see listTreeRepo)
      ) {
        paths.push(p.slice("memory/".length));
      }
    }
  }
  await walk("memory");
  return { truncated: false, tree: groupTreePaths(paths) };
}

/**
 * Group flat memory-relative paths by their top-level category. records/
 * collapses to slice dirs (`YYYY/MM/DD/HHMM`); every other path is kept
 * verbatim. Group order: the nine case categories canonically, then records,
 * then anything else (legacy leftovers) alphabetically. Paths ascending.
 */
function groupTreePaths(paths: string[]): Record<string, string[]> {
  const groups = new Map<string, Set<string>>();
  for (const rel of paths) {
    const top = rel.split("/")[0] ?? rel;
    if (!groups.has(top)) groups.set(top, new Set());
    if (top === "records") {
      const segs = rel.split("/");
      // records/YYYY/MM/DD/HHMM/<file> → the slice dir is the record's identity
      groups.get(top)!.add(segs.slice(0, 5).join("/"));
    } else {
      groups.get(top)!.add(rel);
    }
  }
  const order = (a: string, b: string): number => {
    const rank = (k: string): number => {
      const i = CASE_CATEGORY_LIST.indexOf(k as (typeof CASE_CATEGORY_LIST)[number]);
      return i >= 0 ? i : k === "records" ? 100 : 101;
    };
    return rank(a) - rank(b) || a.localeCompare(b);
  };
  const tree: Record<string, string[]> = {};
  for (const key of [...groups.keys()].sort(order)) {
    tree[key] = [...groups.get(key)!].sort((a, b) => a.localeCompare(b));
  }
  return tree;
}

/** Successful two-segment readDoc result — the whole file, header parsed. */
export interface ReadCaseDocSuccess {
  /** The identity that was read (as parsed). */
  ref: CaseRef;
  /** The resolved repo-relative path. */
  path: string;
  /** Birth date (piece: from the name, same-source rule). */
  opened: string;
  /** Last-write stamp (ISO, UTC) — the write window's anchor and the
   *  reader's freshness material; a pre-window file resolves to its birth. */
  updated: string;
  /** RETIRED (v0.21) — a historical seal date on old files, inert: kept so
   *  the reader sees what the file says, never consulted for state. */
  closed: string | null;
  /** The full raw file text — case docs are small files, read whole. */
  content: string;
  /** Tolerant-parse problems; never fatal. */
  warnings: string[];
}

/** Dead link / illegal reference — a visible error result, never thrown. */
export interface ReadCaseDocFailure {
  error: string;
}

/**
 * readDoc — point-read a case document by TWO-SEGMENT reference
 * (v0.19 §B.2): `分类/case名` → the case's `index.md`; `分类/case名/篇名`
 * → one dated piece. Resolution runs through case-refs.ts (parse → ordered
 * candidates, new root first, legacy fallback roots after, §D.1 双根). A
 * reference that resolves nowhere is a DEAD LINK — a visible error result,
 * never thrown, never blocking.
 *
 * On success the executor records the document + the slice ids its text
 * references (recordDocRead) so the doc_rework probe can later classify
 * readSlice calls against it. Best-effort, never fails the read.
 */
export async function readDocExecute(
  { ref }: { ref: string },
  { context: ctx }: ExecuteOpts<ToolContext>,
): Promise<ReadCaseDocSuccess | ReadCaseDocFailure> {
  "use step";
  const parsed = parseCaseRef(ref);
  if (!parsed) {
    return {
      error:
        `无法解析的引用 "${ref}"——引用应是 分类/case名` +
        `（如 research/手机调研）或 分类/case名/篇名。`,
    };
  }

  const readText = (path: string): Promise<string> =>
    ctx.useDemo
      ? readFileDemo(path)
      : ctx.useGithub
        ? readFile(path, ctx.repo, ctx.owner)
        : readFileLocal(path);

  const candidates = resolveCaseRefPaths(parsed);
  for (const path of candidates) {
    let raw: string;
    try {
      raw = await readText(path);
    } catch {
      continue; // not at this candidate — try the next
    }
    const location =
      parsed.kind === "piece"
        ? { category: parsed.category, caseName: parsed.caseName, fileName: parsed.pieceFileName }
        : parsed.kind === "case"
          ? { category: parsed.category, caseName: parsed.caseName, fileName: "index.md" }
          : // legacy root fallback: a bare pre-case name — read as a name-only doc
            { category: "research" as const, caseName: parsed.name, fileName: `${parsed.name}.md` };
    const doc = parseCaseDoc(raw, location);
    const result: ReadCaseDocSuccess = {
      ref: parsed,
      path,
      opened: doc.opened,
      updated: doc.updated,
      closed: doc.closed,
      content: raw,
      warnings: doc.warnings,
    };
    recordDocRead(ctx.sliceId, path, extractSliceIds(raw));
    return result;
  }

  return {
    error:
      `死链：没有任何文档叫 "${normalizeCaseRefText(ref)}"` +
      `（已查新根与旧根）。用 listTree 看现有清单。`,
  };
}

// ─── noteForSediment — the sediment mailbox producer (v0.15 design §3.1/§4.3) ──

/**
 * The reply segment's ONLY write to memory. The main agent is read-only on
 * memory by design — v0.15 §4.3 designates the reply segment as "只读 + 记账":
 * this tool is the 记账. It appends ONE structured `[doc-marker]` line to the
 * CURRENT slice's agent.md (the inter-stream mailbox, §3.1); the actual
 * document write still happens at slice close, in the scribe/librarian passes
 * that consume these markers. It never touches core.md (the evidence record)
 * and never writes a document itself.
 */
export interface NoteForSedimentInput {
  /** sediment = worth keeping as a document; task = a date-anchored to-do the
   *  user stated; question = a thread the background research pass should
   *  pick up. */
  kind: "sediment" | "task" | "question";
  /** The document's title — specific enough that a scope change would mean a
   *  NEW document (命名纪律, design §2.1). */
  title: string;
  /** One line on what this is about. */
  note?: string;
  /** sediment only: research (default) or entity. */
  docType?: "research" | "entity";
  /** sediment+entity only: which of the five entity kinds. */
  entityKind?: "event" | "person" | "object" | "place" | "org";
  /** sediment only: an EXISTING document file name to append to. */
  target?: string;
  /** task only: the date anchor the user stated (YYYY-MM-DD). */
  dateAnchor?: string;
  /** Topic strands (strands.json keys) this belongs to. */
  topics?: string[];
  /**
   * 证据·大段文字 (§C.1): the FULL pasted text when the sedimented thing is
   * a long text — the scribe opens the case with this verbatim, origin
   * stamped. Conservative: absent for ordinary markers.
   */
  body?: string;
}

export type NoteForSedimentResult =
  | { ok: true; marker: DocMarker; path: string; duplicate?: boolean }
  | { ok: false; reason: string };

/**
 * Append ONE validated [doc-marker] line to the current slice's agent.md
 * mailbox — the shared tail of the marker producers (noteForSediment,
 * startLongTask). The producer validates by ROUND-TRIPPING the constructed
 * line through the consumer's own `extractDocMarkers`, so the two sides can
 * never drift apart. Idempotent on the marker id: an already-present id is
 * never appended twice (workflow step retries re-run the executor).
 */
async function appendDocMarker(
  ctx: ToolContext,
  marker: DocMarker,
): Promise<NoteForSedimentResult> {
  const line = `${DOC_MARKER_PREFIX} ${JSON.stringify(marker)}`;
  const parsed = extractDocMarkers(line);
  if (parsed.length !== 1 || parsed[0].id !== marker.id) {
    return {
      ok: false,
      reason: "marker failed the [doc-marker] contract check (librarian parser rejected it).",
    };
  }

  const agentPath = sliceIdToAgentPath(ctx.sliceId);
  let existing = "";
  try {
    // fresh: read-modify-append — a cached base would silently drop markers
    // other steps landed in between (io-helpers contract). Dual-root (v0.19
    // R2): the mailbox of a slice created before the root move lives under
    // the legacy slices root; the append below always writes the new root.
    const [primary, fallback] = slicePartPathCandidates(ctx.sliceId, "agent");
    try {
      existing = await fsReadFile(primary, undefined, { fresh: true });
    } catch {
      existing = await fsReadFile(fallback, undefined, { fresh: true });
    }
  } catch {
    // no agent.md yet — this line opens it
  }
  if (extractDocMarkers(existing).some((m) => m.id === marker.id)) {
    return { ok: true, marker: parsed[0], path: agentPath, duplicate: true };
  }
  const next = existing.trimEnd()
    ? `${existing.trimEnd()}\n\n${line}\n`
    : `${line}\n`;
  await fsWriteFile(agentPath, next);
  return { ok: true, marker: parsed[0], path: agentPath };
}

/**
 * noteForSediment — drop a `[doc-marker]` line into the current slice's
 * agent.md. The marker contract ([doc-marker] {"v":1,...}) is owned and
 * consumed by librarian.ts; the append itself lives in appendDocMarker above.
 * The marker id is `<sliceId>-<toolCallId>` — stable across workflow step
 * retries.
 */
export async function noteForSedimentExecute(
  input: NoteForSedimentInput,
  { context: ctx, toolCallId }: ExecuteOpts<ToolContext>,
): Promise<NoteForSedimentResult> {
  "use step";
  if (ctx.useDemo) {
    return {
      ok: false,
      reason: "Demo mode runs on read-only benchmark data — markers are not recorded.",
    };
  }
  const title = input.title.trim();
  if (!title) return { ok: false, reason: "title must not be empty." };
  if (input.kind === "sediment" && input.docType === "entity" && !input.entityKind) {
    return {
      ok: false,
      reason:
        "an entity sediment needs entityKind (event | person | object | place | org).",
    };
  }
  const anchor = input.dateAnchor?.trim();
  if (anchor && !/^\d{4}-\d{2}-\d{2}$/.test(anchor)) {
    return {
      ok: false,
      reason: `dateAnchor must be YYYY-MM-DD, got ${JSON.stringify(anchor)}.`,
    };
  }

  const marker: DocMarker = {
    v: 1,
    id: `${ctx.sliceId}-${toolCallId}`,
    kind: input.kind,
    title,
    note: input.note?.trim() ?? "",
    topics: input.topics ?? [],
    ...(input.docType ? { docType: input.docType } : {}),
    ...(input.entityKind ? { entityKind: input.entityKind } : {}),
    ...(input.target?.trim() ? { target: input.target.trim() } : {}),
    ...(anchor ? { dateAnchor: anchor } : {}),
    ...(input.body?.trim() ? { body: input.body } : {}),
  };
  return appendDocMarker(ctx, marker);
}

// ─── writeCase — the reply segment's ONE bounded write (v0.20 §2.2) ────────

export type WriteCaseResult =
  | { ok: true; action: "open" | "addPiece"; path: string }
  | { ok: false; reason: string };

/** User-local YYYY-MM-DD (the write-date convention background runs use). */
function userLocalDate(timezone: string | undefined): string {
  const now = new Date();
  const tz = timezone?.trim() ? timezone : "UTC";
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(now);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    if (get("year") && get("month") && get("day")) {
      return `${get("year")}-${get("month")}-${get("day")}`;
    }
  } catch {
    // unknown IANA name — fall back to the UTC date
  }
  return now.toISOString().slice(0, 10);
}

/**
 * writeCase — open a research case (or add a dated piece to an existing
 * one) IN THE MIDDLE of the reply, so a research turn can write the
 * document FIRST and then answer FROM it (v0.20 §2.1 选案 (a)).
 *
 * Bounded exactly as §2.2 prescribes:
 * - 分类界: category is hard-coded to `research/` — the input has NO
 *   category parameter, so no free path to any other category exists;
 * - 操作界: only `open` and `addPiece` reach `applyCaseWriteIntent`
 *   (rewriteIndex / appendTail / close are never issued);
 * - 冲突界: the shared `applyCaseWriteIntent` entry — per-case lock
 *   `doc:research/<case名>`, fresh read inside the lock — so a concurrent
 *   background run on the same case serializes visibly instead of
 *   interleaving bytes.
 *
 * What the caller passes is EXACTLY what lands — no machine fields are
 * stamped in (v0.21: the case→slice link is semantic, so a piece that wants
 * to say where it came from says so in prose). records get zero write-back.
 */
export async function writeCaseExecute(
  input: { category?: string; caseName: string; body: string; pieceTitle?: string },
  { context: ctx }: ExecuteOpts<ToolContext>,
): Promise<WriteCaseResult> {
  "use step";
  if (ctx.useDemo) {
    return {
      ok: false,
      reason: "Demo mode runs on read-only benchmark data — cases are not written.",
    };
  }
  const category = input.category?.trim() || "research";
  if (category !== "research" && category !== "tasks") {
    return {
      ok: false,
      reason:
        `category ${JSON.stringify(input.category)} is not writable from here — ` +
        `allowed: "research" (an investigation) or "tasks" (a commitment).`,
    };
  }
  const caseName = input.caseName?.trim() ?? "";
  if (!caseName) return { ok: false, reason: "caseName must not be empty." };
  if (!isValidCaseName(caseName)) {
    return {
      ok: false,
      reason:
        `illegal case name ${JSON.stringify(caseName)} — no path separators / ` +
        `traversal / surrounding whitespace; a dated name needs a real date ` +
        `with a title not starting with four digits.`,
    };
  }
  const body = input.body?.trim() ?? "";
  if (!body) {
    return { ok: false, reason: "body must not be empty — write the WHOLE content." };
  }
  const pieceTitle = input.pieceTitle?.trim() ?? "";

  const date = userLocalDate(ctx.timezone);
  const indexPath = caseIndexPath(category, caseName);

  // Probe for existence OUTSIDE the lock (fresh read); the in-lock checks
  // inside applyCaseWriteIntent are the backstop for the open race.
  let exists = false;
  try {
    await fsReadFile(indexPath, undefined, { fresh: true });
    exists = true;
  } catch {
    exists = false;
  }

  if (!exists) {
    try {
      const applied = await applyCaseWriteIntent(
        { action: "open", category, caseName, body },
        date,
      );
      return { ok: true, action: "open", path: applied.path };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!msg.includes("already exists")) {
        return { ok: false, reason: `open refused: ${msg}` };
      }
      exists = true; // raced — another writer opened it; fall through
    }
  }

  if (!pieceTitle) {
    return {
      ok: false,
      reason:
        `case ${category}/${caseName} already exists and no pieceTitle was ` +
        `given. This tool never rewrites an index: pass pieceTitle to ADD a ` +
        `dated piece to this case, or pick a different caseName for a new case.`,
    };
  }
  try {
    const applied = await applyCaseWriteIntent(
      { action: "addPiece", category, caseName, title: pieceTitle, body },
      date,
    );
    return { ok: true, action: "addPiece", path: applied.path };
  } catch (e) {
    return { ok: false, reason: `addPiece refused: ${e instanceof Error ? e.message : String(e)}` };
  }
}


// ─── reportToHQ — the field's one-way report to HQ (v0.21 §4) ──────────────

export type ReportToHQResult =
  | { ok: true; delivered: "resumed" | "started"; runId: string }
  | { ok: false; reason: string };

/**
 * Start a fresh HQ run carrying this brief as its first payload. Shared by
 * the "no HQ alive" and "resume raced with HQ exit" fallbacks.
 */
async function startHQRun(payload: HQBriefPayload): Promise<ReportToHQResult> {
  try {
    const run = await start(hqRun, [payload]);
    return { ok: true, delivered: "started", runId: run.runId };
  } catch (e) {
    return {
      ok: false,
      reason: `HQ could not be reached: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/**
 * Deliver the brief to HQ (private helper — the step below stays thin).
 * Step order (§4): the advisory `getHookByToken` first; a live hook →
 * `resumeHook` (durable `hook_received` first, then the wake). Any failure
 * — hook absent (HookNotFoundError), or a race where HQ exited right after
 * the advisory — falls back to `start(hqRun, [payload])`. A resumeHook
 * failure can leave the event durable while the wake failed; re-delivering
 * to a fresh run only appends a duplicate `hook_received`, which HQ absorbs
 * writer-is-reader style (§11 ③).
 */
async function deliverHQBrief(payload: HQBriefPayload): Promise<ReportToHQResult> {
  try {
    // Advisory only (SDK): a hit does not guarantee the hook survives until
    // resumeHook — the race is closed by the fallback below.
    await getHookByToken(HQ_TOKEN);
  } catch {
    return startHQRun(payload);
  }
  try {
    const resumed = await resumeHook(HQ_TOKEN, payload);
    return { ok: true, delivered: "resumed", runId: resumed.runId };
  } catch (e) {
    console.warn(
      "[reportToHQ] resumeHook failed — starting a fresh HQ run:",
      e instanceof Error ? e.message : e,
    );
    return startHQRun(payload);
  }
}

/**
 * reportToHQ — hand the scene over to HQ (§4). The payload is ONE piece of
 * prose (`brief`: what the field sees + its own observations — no
 * expectations, no instructions) plus the mechanically-attached
 * `replyToken` (`field:<sliceId>:<startedAtIso>`, same formula the turn
 * workflow uses for its end-of-turn callback hook — the model never writes
 * it). The result only says DELIVERED or not — it promises nothing about
 * what HQ does, and HQ may or may not speak back later.
 *
 * A confirmed delivery also lands in the hq.json status pointer
 * (hq-status-store.ts) — the companion pod's "last dispatch" line. The
 * record is best-effort (the store swallows its own errors) and never
 * changes what this tool answers.
 */
export async function reportToHQExecute(
  input: { brief: string },
  { context: ctx }: ExecuteOpts<ToolContext>,
): Promise<ReportToHQResult> {
  "use step";
  const brief = input.brief?.trim() ?? "";
  if (!brief) return { ok: false, reason: "brief must not be empty." };
  const payload: HQBriefPayload = {
    brief,
    replyToken: `field:${ctx.sliceId}:${ctx.startedAtIso ?? ""}`,
  };
  const result = await deliverHQBrief(payload);
  if (result.ok) await recordHQDispatch(brief);
  return result;
}


// ─── startLongTask — the conversation's sub-stream, dispatched on the spot ──

export type StartLongTaskResult =
  | { ok: true; runId: string }
  | { ok: false; reason: string };

/**
 * startLongTask — hand a piece of long work the USER explicitly asked for
 * ("去查一下 X") to the conversation's sub-stream: the question run
 * (v0.21 §2 — the trigger moved from the slice-close marker scan to the
 * field dispatching mid-conversation, on the LIVE slice).
 *
 * The agenda still travels through the FROZEN mailbox contract (§A.3.1 — no
 * new channel): this executor first appends ONE question marker to the
 * current slice's agent.md (the doc-research pass's agenda IS the markers),
 * then starts the run fire-and-forget. The run has no mouth: findings land
 * in research/ hypotheses/ cases, and the completion statement rides the
 * tasks/ notice case that a LATER turn's reply segment reads (§A.3.3) — the
 * result here only says the run was dispatched.
 *
 * Idempotency (at-least-once + writer-is-reader): the marker id
 * (`<sliceId>-<toolCallId>`) dedups the append across step retries; a
 * duplicated RUN is absorbed by the pass's own processed-marker record.
 */
export async function startLongTaskExecute(
  input: { task: string; note?: string },
  { context: ctx, toolCallId }: ExecuteOpts<ToolContext>,
): Promise<StartLongTaskResult> {
  "use step";
  if (ctx.useDemo) {
    return {
      ok: false,
      reason:
        "Demo mode runs on read-only benchmark data — long tasks are not dispatched.",
    };
  }
  const task = input.task?.trim() ?? "";
  if (!task) return { ok: false, reason: "task must not be empty." };

  const posted = await appendDocMarker(ctx, {
    v: 1,
    id: `${ctx.sliceId}-${toolCallId}`,
    kind: "question",
    title: task,
    note: input.note?.trim() ?? "",
    topics: [],
  });
  if (!posted.ok) return { ok: false, reason: posted.reason };

  try {
    // Same start config the retired close-scan trigger used (steps.ts).
    const run = await start(
      questionRun,
      [{ sliceId: ctx.sliceId, date: userLocalDate(ctx.timezone) }],
      { region: "hkg1" },
    );
    return { ok: true, runId: run.runId };
  } catch (e) {
    // The marker is already on disk — the question stays in the record; but
    // with the close-scan route retired nothing re-fires the run, so the
    // refusal must be visible to the model NOW.
    return {
      ok: false,
      reason:
        `the question is recorded in the mailbox but the sub-stream could not ` +
        `be started: ${e instanceof Error ? e.message : String(e)} — ` +
        `tell the user the dispatch failed.`,
    };
  }
}


// ─── Chat-only executors ─────────────────────────────────────────────────

/**
 * webSearch �?delegates to the Flash search adapter (see lib/search/). The
 * context is accepted for tool-set uniformity but unused: search needs no
 * repo identity. A missing API key is a deterministic config problem �?
 * returned as data; transient search failures throw and get the step retries.
 */
export async function webSearchExecute(
  { query, mode }: { query: string; mode?: "standard" | "scout" },
  { toolCallId }: ExecuteOpts<ToolContext>,
): Promise<WebSearchResult | { error: string }> {
  "use step";
  // Status subtitle streams for the whole execution; awaited so it is ordered
  // before the result.
  await emitToolProgress(toolCallId, "webSearch", "Searching the web…", "running");

  // webSearch is a DEEPSEEK-ONLY infra call (see lib/search/flash-search.ts
  // @security note). Gate on the key itself, not the generic isAIConfigured():
  // a deployment with ANTHROPIC_API_KEY but no DEEPSEEK_API_KEY would pass the
  // generic check and then fail deep inside the adapter.
  if (!process.env.DEEPSEEK_API_KEY) {
    return {
      error:
        "Web search requires a DEEPSEEK_API_KEY. It runs as a separate DeepSeek " +
        "infrastructure call independent of the chat model you selected. Add " +
        "DEEPSEEK_API_KEY to enable it, or swap in your own search adapter.",
    };
  }

  // Soft safety net — backstop on top of the runner's own budget inside
  // searchViaFlash. searchViaFlash errors (transient search failures)
  // still throw and get step retries — only a timeout returns an error result.
  //
  // v0.19 R5 (§C.2): the researcher's SOP (self/search/index.md) is loaded by
  // the sub-agent runner itself at spawn — full text into the system prompt.
  let timed: Awaited<ReturnType<typeof withStepTimeout<WebSearchResult>>>;
  try {
    timed = await withStepTimeout(
      () =>
        searchViaFlash(
          query,
          { toolCallId, toolName: "webSearch" },
          { scout: mode === "scout" },
        ),
      SEARCH_TIMEOUT_MS,
    );
  } catch (err) {
    // Triage: deterministic failures (schema validation, config, domain) become
    // a model-readable tool result so the workflow does NOT retry them. Only
    // genuinely transient errors re-throw for the step's auto-retry.
    if (isTransientError(err)) throw err;
    console.warn(
      "[WebSearch] triaged failure:",
      err instanceof Error ? err.message : err,
    );
    return { error: triageErrorMessage(err, "webSearch") };
  }

  if (!timed.ok || timed.result === undefined) {
    return {
      error: timed.ok
        ? "Web search returned no result"
        : `Web search timed out after ${timed.elapsedMs}ms`,
    };
  }

  // Settle the subtitle on the outcome before the tool result lands, so the
  // typewriter box ends on "Found N sources" instead of the stale "Searching…".
  const result = timed.result;
  await emitToolProgress(
    toolCallId,
    "webSearch",
    `Found ${result.sources.length} source${result.sources.length === 1 ? "" : "s"}`,
    "done",
  );
  return result;
}

// ── webFetch — fetch a specific page's text content ────────────────────

const WEB_FETCH_TIMEOUT_MS = 30_000;
const WEB_FETCH_MAX_CHARS = 15_000;

/**
 * webFetch — read a specific URL's page text, server-side.
 *
 * The web complement of readSlice: the main agent points at one item (a URL
 * instead of a slice id) and gets its raw content back for the model to
 * digest. Used when the user pastes a link, or when a webSearch recommendation
 * suggests a page is worth reading. Returns the extracted prose (scripts and
 * styles stripped), truncated to keep context bounded.
 *
 * Optional `range` applies the shared Document Segment Read protocol: keyword
 * search (matches → relevant paragraphs; miss → full text + note) or line
 * ranges (1-indexed, like reading a code file).
 *
 * Security: only http(s) schemes and non-private hostnames are fetchable.
 * The Vercel sandbox is the real boundary; this validation is defense-in-depth.
 */
export type WebFetchRange = {
  type: "search" | "lines";
  keywords?: string[];
  context?: number;
  start?: number;
  end?: number;
};

export async function webFetchExecute(
  { url, range }: { url: string; range?: WebFetchRange },
  _opts: ExecuteOpts<ToolContext>,
): Promise<string> {
  "use step";
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "ERROR: Invalid URL. Pass a full absolute URL, e.g. 'https://example.com/article'.";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "ERROR: Unsupported URL protocol. Only http:// and https:// are allowed.";
  }
  if (isPrivateHost(parsed.hostname)) {
    return "ERROR: Cannot fetch local or private network addresses.";
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WEB_FETCH_TIMEOUT_MS);
  try {
    const res = await fetchWithGuard(parsed.toString(), {
      signal: controller.signal,
    });
    if (!res.ok) {
      return `ERROR: HTTP ${res.status} ${res.statusText}`;
    }
    const { text, truncated } = await readBodyCapped(res);
    let extracted = extractText(text);
    if (truncated) {
      // The byte cap fired (see readBodyCapped) — tell the model the page
      // continues past what it can see, in the same note style as the 15K
      // character fallback below.
      extracted += `\n\n(Fetched page truncated at ${Math.round(FETCH_BODY_MAX_BYTES / 1024 / 1024)} MB)`;
    }

    // Document Segment Read protocol — applied before truncation so a matched
    // subset or line range is returned in full, not capped by the 15K fallback.
    // A keyword MISS still caps at the same 15K: a miss on a huge page must
    // not flood the context with the full text.
    if (range) {
      if (range.type === "search") {
        const keywords = range.keywords ?? [];
        const context = range.context ?? 1;
        const hits = segmentSearch(splitParagraphs(extracted), keywords, context, context);
        return searchResultToString(parsed.hostname + parsed.pathname, keywords, hits, extracted, WEB_FETCH_MAX_CHARS);
      }
      if (range.type === "lines") {
        const { content, clamped } = textLines(extracted, range.start ?? 1, range.end ?? 1);
        if (content === "" && (range.start ?? 1) > (range.end ?? 1)) {
          return `ERROR: Invalid line range ${range.start}-${range.end} for ${parsed.hostname}.`;
        }
        const header = `Lines ${range.start}-${range.end} of ${parsed.hostname}${clamped ? " (clamped)" : ""}:\n\n`;
        return content === "" ? `${header}(empty range)` : header + content;
      }
    }

    if (extracted.length > WEB_FETCH_MAX_CHARS) {
      return (
        extracted.slice(0, WEB_FETCH_MAX_CHARS) +
        `\n\n(Truncated at ${WEB_FETCH_MAX_CHARS} characters)`
      );
    }
    return extracted;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return `ERROR: Could not fetch URL: ${msg}`;
  } finally {
    clearTimeout(timer);
  }
}

// ── viewImage — one-shot image-to-text for non-vision main models ────────

/**
 * viewImage — describe an image the user attached (when the main model cannot
 * see it natively) or an image found during research.
 *
 * `source` is either an http(s) URL or `attachment:N` referring to the Nth
 * image attachment extracted from the current turn. The actual vision call is a
 * one-shot infrastructure call to `describe-image.ts`'s `VISION_MODEL_ID` via
 * `describeImage`. If the vision model is unavailable the tool does not fail:
 * it returns a degraded metadata-only result (dimensions, format, size) that
 * says so explicitly.
 */
export async function viewImageExecute(
  { source, question }: { source: string; question?: string },
  { context: ctx, toolCallId }: ExecuteOpts<ToolContext>,
): Promise<string> {
  "use step";
  await emitToolProgress(toolCallId, "viewImage", "Looking at image…", "running");

  let imageInput: { data: string; mediaType: string } | { url: string };
  if (source.startsWith("attachment:")) {
    const idx = Number(source.slice("attachment:".length));
    const attachments = ctx.imageAttachments ?? [];
    if (Number.isNaN(idx) || idx < 0 || idx >= attachments.length) {
      return `ERROR: Invalid attachment index "${source}". This turn has ${attachments.length} image attachment${attachments.length === 1 ? "" : "s"}.`;
    }
    const dataUrl = attachments[idx];
    if (!dataUrl) {
      return `ERROR: Attachment ${idx} is empty.`;
    }
    const match = /^data:([^;]+);base64,/.exec(dataUrl);
    imageInput = {
      data: dataUrl,
      mediaType: match?.[1] ?? "image/png",
    };
  } else if (source.startsWith("doc:")) {
    // A case attachment (v0.19 §C.1): doc:<分类>/<case名>/<附件名> — the
    // unit identity a document cites. Bytes come back through the binary
    // read path; a dead name is a visible error, never a throw.
    const refText = source.slice("doc:".length);
    const segments = refText.split("/");
    const category = segments[0] ?? "";
    const caseName = segments[1] ?? "";
    const fileName = segments.slice(2).join("/");
    if (segments.length !== 3 || !caseName || !fileName) {
      return `ERROR: Invalid doc attachment source "${source}". Expected "doc:<分类>/<case名>/<附件名>", e.g. "doc:research/手机调研/2026-09-05-photo.jpg".`;
    }
    let attachment: { data: Buffer; mediaType: string };
    try {
      attachment = await readCaseAttachment({
        category: category as Parameters<typeof readCaseAttachment>[0]["category"],
        caseName,
        fileName,
      });
    } catch (e) {
      return `ERROR: ${e instanceof Error ? e.message : String(e)}`;
    }
    imageInput = {
      data: `data:${attachment.mediaType};base64,${attachment.data.toString("base64")}`,
      mediaType: attachment.mediaType,
    };
  } else {
    imageInput = { url: source };
  }

  const result = await describeImage({
    image: imageInput,
    question,
    locale: ctx.locale,
  });

  await emitToolProgress(
    toolCallId,
    "viewImage",
    result.ok
      ? result.degraded
        ? "Metadata only — vision model unavailable"
        : "Looked at image"
      : "Could not view image",
    result.ok ? "done" : "running",
  );
  if (!result.ok) return result.error;
  // Degraded descriptions already embed the metadata and the DEGRADED marker;
  // real descriptions get metadata appended so the agent always sees it.
  if (result.degraded) return result.description;
  return `${result.description}\n\n[image: ${formatImageMetadata(result.metadata)}]`;
}

// ── delegateTask — subscription bridge dispatch (client mode only) ───────
//
// The bridge env contract, command splitter, and spawn helper live in
// src/lib/bridge.ts (shared with the bridge main model, see
// src/lib/models/bridge-model.ts).

export type DelegateTaskResult = BridgeRunResult;

/**
 * delegateTask — hand a self-contained task to the local subscription bridge
 * (client mode only; the tool itself is registered conditionally in
 * ./tools.ts). The kernel owns only the dispatch half: the bridge command
 * (PREVIOUSLY_BRIDGE_CMD, default `previously bridge-exec`) is
 * operator-controlled env — never tool input — and receives `{ task, context }`
 * as JSON on stdin; its stdout is the result. The bridge adapters live in the
 * client repo (doc/design/v0.9-client.md).
 */
export async function delegateTaskExecute(
  { task, context }: { task: string; context?: string },
  { toolCallId }: ExecuteOpts<ToolContext>,
): Promise<DelegateTaskResult> {
  "use step";
  await emitToolProgress(toolCallId, "delegateTask", "Delegating to the local bridge…", "running");

  const cmd = getBridgeCommand();
  const result = await runBridge(
    splitBridgeCommand(cmd),
    JSON.stringify({
      task,
      context: context ?? null,
      protocol: BRIDGE_PROTOCOL_VERSION,
    }),
    getBridgeTimeoutMs(),
  );

  await emitToolProgress(
    toolCallId,
    "delegateTask",
    result.status === "ok" ? "Bridge returned a result" : `Bridge failed: ${result.reason}`,
    "done",
  );
  // Protocol-2 activity events are display data for the kernel UI — strip
  // them so they don't bloat the model-facing tool result.
  if (result.status === "ok" && result.events) {
    const { events: _events, ...rest } = result;
    return rest;
  }
  return result;
}

// ── currentTime — the "watch check" for a precise now ────────────────────

/**
 * currentTime — a fresh clock read. The system prompt's slice-head snapshot is
 * frozen at the slice's start (prefix-cache freeze), so it can be tens of
 * minutes old mid-slice; this tool is the model's way to ask "what time is it
 * REALLY now". Zero-input, read-only, and byte-stable per call — it appends to
 * the message tail, so it never breaks the prefix cache.
 *
 * Returns rich text (no disk reads): the user's local time + UTC, this slice's
 * start / elapsed / remaining-to-cap (the start instant is parsed from the
 * slice id itself — YYYY-MM-DD-HHMM is a UTC label), and a refreshed
 * date-anchor table. The turn count is deliberately omitted: deriving it would
 * require reading the slice file, which is not worth the I/O for a clock check.
 */
export async function currentTimeExecute(
  _input: Record<string, never>,
  { context: ctx }: ExecuteOpts<ToolContext>,
): Promise<string> {
  "use step";
  const now = new Date();
  const nowIso = now.toISOString();
  const tz = ctx.timezone ?? "UTC";
  const t = formatLocalTime(nowIso, tz);
  const offset = t.offset ? `, ${t.offset}` : "";

  const lines: string[] = [
    `Now: ${t.local} (${t.zone}${offset})`,
    `UTC: ${t.utc}`,
  ];

  // Slice progress — the slice id encodes its UTC start (minute granularity),
  // so this needs no disk read.
  const parsed = parseSliceId(ctx.sliceId);
  if (parsed) {
    const startIso = `${parsed.y}-${parsed.m}-${parsed.d}T${parsed.hm.slice(0, 2)}:${parsed.hm.slice(2)}:00.000Z`;
    const startMs = Date.parse(startIso);
    if (!Number.isNaN(startMs)) {
      let capMinutes = DEFAULTS.slicing.maxSliceMinutes;
      try {
        capMinutes = (await loadUserConfig()).slicing.maxSliceMinutes;
      } catch {
        // Config unreadable — fall back to the shipped default cap.
      }
      const elapsedMin = Math.max(
        0,
        Math.floor((now.getTime() - startMs) / 60_000),
      );
      const st = formatLocalTime(startIso, tz);
      lines.push(
        "",
        `This slice (${ctx.sliceId}):`,
        `- Started: ${st.local} (${st.zone}) · UTC ${startIso}`,
      );
      const remaining = capMinutes - elapsedMin;
      lines.push(
        remaining > 0
          ? `- Running for ${elapsedMin} min — ${remaining} min left of the ${capMinutes}-minute cap, then this slice auto-closes.`
          : `- Running for ${elapsedMin} min — past the ${capMinutes}-minute cap; this slice closes on the next turn boundary.`,
      );
    }
  }

  // Fresh date anchors — the same reference table as the slice-head snapshot,
  // recomputed against NOW instead of the slice start.
  const anchors = buildDateAnchors(nowIso, tz, ctx.locale);
  if (anchors.length > 0) {
    lines.push("", "Date anchors:", ...anchors.map((a) => `- ${a}`));
  }

  return lines.join("\n");
}

// ── describeRoom — the game room's computed outline (v0.11 §13) ────────

/**
 * describeRoom — what the hotel room of a slice CONTAINS, computed from the
 * world seed by the game's own pure chain (lib/game/describe-room.ts —
 * space-recipe → room-plan → room-modules/room-templates → room-doors →
 * kits, the same modules the renderer builds from). Deterministic: same
 * slice, same outline. No I/O, so it is the cheapest "what is around the
 * user" answer there is.
 *
 * The rendered text is localized by the turn's locale (zh/en). Invalid slice
 * ids are a domain error — returned, never thrown.
 */
export async function describeRoomExecute(
  {
    sliceId,
    strandDoors,
    corridorSide,
  }: { sliceId?: string; strandDoors?: number; corridorSide?: "north" | "south" },
  { context: ctx }: ExecuteOpts<ToolContext>,
): Promise<string> {
  "use step";
  const sid = sliceId ?? ctx.sliceId;
  if (!parseSliceId(sid)) {
    return "ERROR: Invalid slice ID. Expected format: YYYY-MM-DD-HHMM (e.g. 2026-07-24-1500).";
  }
  const desc = describeRoom(sid, {
    ...(strandDoors !== undefined ? { strandDoors } : {}),
    ...(corridorSide ? { corridorSide } : {}),
  });
  return formatRoomDescription(desc, ctx.locale === "zh" ? "zh" : "en");
}

/**
 * thinkDeep — a reasoning fragment (think-only sub-agent).
 *
 * Runs ONE bounded reasoning fragment as a single synchronous `streamText`
 * call INSIDE this step, using the user's MAIN model at the requested thinking
 * intensity. The sub-agent is think-only: NO tools, NO search — it reasons over
 * the information the main agent embedded in the question and writes its
 * conclusion. The conclusion + reasoning trail flow back as the tool result,
 * and the WorkflowAgent loop integrates them naturally on the next step.
 *
 * TIME-based truncation, NOT token-based: there is deliberately NO
 * `maxOutputTokens` here. A hard token cap is invisible to the model — it can't
 * pace itself within it, and with thinking enabled the reasoning silently eats
 * the shared budget, leaving an empty/truncated report (the old 3500-token
 * behavior). Instead the step is bounded by wall-clock and the SDK's native
 * timeout hook:
 *
 *   - `streamText({ timeout })` is the PRIMARY hook: the SDK runs
 *     `AbortSignal.timeout()` (available here — this is real Node in a
 *     `"use step"`, unlike the deterministic workflow body) and ABORTS the
 *     stream cleanly at the deadline, surfacing as `AbortError`. The value is
 *     adaptive: `STEP_TOTAL_MS` minus the prologue already elapsed, so the step
 *     returns right around STEP_TOTAL_MS regardless of setup overhead — safely
 *     under the 300s platform wall.
 *   - `withStepTimeout` is the backstop: if the SDK abort somehow doesn't
 *     surface, it still returns a structured result before the wall, so the
 *     step NEVER dies silently.
 *
 * BOTH output channels are captured live via `onChunk`: `text-delta` (the
 * written answer) and `reasoning-delta` (the thinking trail). On timeout the
 * main agent receives the partial answer AND the full reasoning so far — the
 * sub-agent's thinking is never lost, even if it is interrupted mid-thought.
 *
 * Why think-only? A sub-agent with tools re-runs the search the main
 * agent already did, and an unbounded tool-loop + thinking guarantees it
 * exhausts the wall before writing (the v2 empty-report bug). Think-only
 * fragments are single-invocation, bounded by construction, and cannot cascade.
 *
 * Provider options are built inline here — this module must NOT import from
 * ./agent.ts, which pulls `@ai-sdk/workflow` into the step bundle.
 */
/**
 * Total target for the whole thinkDeep step — the maximum safely usable under
 * the 300s platform wall. The SDK abort + catch + return path needs a few
 * hundred ms, and cold-start (unmeasurable from inside the handler) silently
 * eats into the wall, so we cannot target the full 300s. 295s leaves ~4s of
 * margin on the primary path; the backstop fires 3s later at ~298s with ~2s to
 * return — past that the platform kill would win the race.
 */
const STEP_TOTAL_MS = 295_000;

/** Guidance the main agent reads when a reasoning fragment is interrupted. */
const SUB_AGENT_TIMEOUT_NOTE =
  "The reasoning fragment was interrupted before finishing. The `answer` holds " +
  "the partial conclusion and `reasoning` the thinking trail it already produced " +
  "— work with them (noting the uncertainty). If you need more, gather the " +
  "missing information yourself (webSearch/recall), embed it, and dispatch a " +
  "finer fragment. Do not re-dispatch the same question unchanged — a fragment " +
  "that timed out will likely time out again.";

/** Structured result a thinkDeep reasoning fragment returns to the main agent. */
export interface ThinkDeepResult {
  ok: boolean;
  /** completed = answer is whole; timeout = answer is partial (may be empty); error = nothing usable. */
  status: "completed" | "timeout" | "error";
  /** The fragment's conclusion — full, or partial when interrupted. */
  answer?: string;
  /** The fragment's thinking trail — always captured; returned on completion AND timeout. */
  reasoning?: string;
  /** Human-readable failure / interruption reason. */
  error?: string;
  /** For `timeout`: what the main agent can do next. Absent otherwise. */
  note?: string;
}

/** Detect the SDK `timeout` abort — the SDK's `AbortSignal.timeout()` surfaces as name "AbortError". */
function isTimeoutAbort(err: unknown): boolean {
  return (
    err !== null &&
    typeof err === "object" &&
    "name" in err &&
    (err as { name?: unknown }).name === "AbortError"
  );
}
/**
 * The think-only task assignment, appended AFTER the caller's full system
 * prompt (when available) so sub-agents share the main agent's exact prefix —
 * the provider's prompt cache, warmed by the main agent's first step, is hit by
 * every sub-agent call in the same turn. When no baseSystemPrompt flows through
 * the context, SUB_AGENT_SYSTEM_PROMPT stands alone.
 */
const SUB_AGENT_FRAGMENT_MODE = `Your ONLY job is to reason through the sub-question below to a clear conclusion,
then write that conclusion. You are THINK-ONLY: you have no search, no memory
tools — every fact you need is already embedded in the question. Do not ask for
information; reason with what you are given and state plainly anything you lack.

Writing discipline (critical):
- A hard deadline will cut you off. Write your conclusion AS YOU GO — every
  sentence you emit is preserved and returned to the caller. Do not save all
  writing for the end.
- Keep it short and decisive. This is one fragment of a larger reasoning, not
  a report — a few paragraphs at most.
- If you reach a conclusion, state it clearly at the end ("Conclusion: …").
- If the question cannot be answered from the given information, say exactly
  what is missing and why.

Answer in the language of the question.`;

/** Standalone system prompt when the turn supplies no baseSystemPrompt. */
const SUB_AGENT_SYSTEM_PROMPT = `You are the same agent as the caller, working on ONE small reasoning fragment.

${SUB_AGENT_FRAGMENT_MODE}`;

/** System prompt for a think-only fragment — base prompt prefix + fragment task. */
function buildSubAgentSystemPrompt(baseSystemPrompt: string | undefined): string {
  if (!baseSystemPrompt) return SUB_AGENT_SYSTEM_PROMPT;
  return `${baseSystemPrompt}\n\n## Reasoning fragment mode\n\n${SUB_AGENT_FRAGMENT_MODE}`;
}

/** One fragment as the model supplies it in the batch call. */
export interface ThinkDeepFragmentInput {
  question: string;
  effort?: "low" | "medium" | "high";
}

/** One fragment's structured result, tagged with its question. */
export interface ThinkDeepFragmentResult extends ThinkDeepResult {
  question: string;
}

/**
 * thinkDeep — ONE reasoning fragment, dispatched as its own sub-agent call.
 *
 * The model decomposes a hard turn into independent questions and issues one
 * call per question, so every fragment reads as an independent sub-agent with
 * its own progress line and result card. The turn's main model and the
 * assembled system prompt arrive through the tools context — the same unified
 * construction the main agent uses — so sub-agents never re-resolve config or
 * rebuild context on their own.
 */
export async function thinkDeepExecute(
  { question, effort = "low" }: {
    question: string;
    effort?: "low" | "medium" | "high";
  },
  { context: ctx, toolCallId }: ExecuteOpts<ToolContext>,
): Promise<ThinkDeepFragmentResult> {
  "use step";

  if (!isAIConfigured()) {
    return {
      question,
      ok: false,
      status: "error",
      error:
        "AI is not configured (no API key). Set DEEPSEEK_API_KEY or another provider key.",
    };
  }

  // The turn's main model flows through the tools context (shared with the
  // main agent — no per-call config resolution / GitHub round-trip). Falls
  // back to resolving it only when the context lacks it.
  const modelConfig = ctx.mainModel ?? (await resolveMainModelFromConfig());

  // Step start — the fragment's adaptive SDK timeout is measured from here so
  // the step returns around STEP_TOTAL_MS no matter how long setup took.
  const stepStartMs = Date.now();

  // Single fragment (index 0 of 1) → streams WITHOUT the [i/N] prefix.
  return runThinkDeepFragment(
    { question, effort },
    0,
    1,
    {
      modelConfig,
      baseSystemPrompt: ctx.baseSystemPrompt,
      toolCallId,
      stepStartMs,
    },
  );
}

/**
 * Run ONE think-only reasoning fragment — a single bounded `streamText` call
 * (main model, thinking on) over exactly the facts embedded in its question.
 * Called once per thinkDeep call (index 0 of total 1), so its progress lines
 * carry no `[i/N]` prefix.
 */
async function runThinkDeepFragment(
  fragment: ThinkDeepFragmentInput,
  index: number,
  total: number,
  opts: {
    modelConfig: ModelConfig;
    baseSystemPrompt?: string;
    toolCallId: string;
    stepStartMs: number;
  },
): Promise<ThinkDeepFragmentResult> {
  const { question, effort = "low" } = fragment;
  const { modelConfig, baseSystemPrompt, toolCallId, stepStartMs } = opts;

  const prefix = total > 1 ? `[${index + 1}/${total}] ` : "";

  // Thinking is always requested for a reasoning fragment; the injector owns
  // the provider-specific effort mapping.
  const providerOptions = normalizeReasoningEffort(
    modelConfig.sdk,
    modelConfig.id,
    true,
    effort,
  );
  // self/ SOP spawn loading (v0.19 §C.2): the thinkdeep SOP rides the SYSTEM
  // prompt in FULL (this fragment runner predates the shared runSubAgent, so
  // it loads directly). Absent/unreadable → no block, never a failed spawn.
  const sop = await readSelfSop("thinkdeep").catch(() => null);
  const baseSystem = buildSubAgentSystemPrompt(baseSystemPrompt);
  const system = sop?.trim()
    ? `${baseSystem}\n\n## Your SOP (self/thinkdeep/index.md — follow it unless it conflicts with the question)\n\n${sop.trim()}`
    : baseSystem;
  const dateAnchor = new Date().toISOString().slice(0, 10);

  const userPrompt = [
    `Today is ${dateAnchor}.`,
    "",
    "# Reasoning fragment",
    "",
    "Reason through the sub-question below to a clear conclusion. Write your",
    "conclusion as you go — a hard deadline will cut you off, and every sentence",
    "you emit is preserved and returned to the caller.",
    "",
    `Sub-question: ${question.trim()}`,
    "",
    "You have no tools and no search. Reason with what is given; state plainly",
    "anything you lack.",
  ]
    .filter(Boolean)
    .join("\n");

  // Adaptive SDK timeout — the PRIMARY hook: `streamText({ timeout })` runs
  // `AbortSignal.timeout()` (available in real Node) and ABORTS the stream
  // cleanly at the deadline, surfacing as AbortError. Measured from step start
  // so every fragment in the batch shares the same wall.
  const streamTimeoutMs = Math.max(
    30_000,
    STEP_TOTAL_MS - (Date.now() - stepStartMs),
  );

  // Accumulated by onChunk — the written answer (text-delta) and the thinking
  // trail (reasoning-delta). Both are returned on completion AND interruption.
  let answer = "";
  let reasoning = "";

  // Live progress → the shared `data-tool-progress` channel. The sub-agent's
  // reasoning and answer stream token-by-token; we forward the CURRENT line
  // (text after the last newline) so the client shows a growing single line
  // that resets at line boundaries — the same flowing behavior as the thinking
  // phase. A single reused writer keeps the step reliable: creating a fresh
  // `getWritable()` pipeline per write failed silently on long fragments. The
  // client merges these chunks by (type, id = tool-<toolCallId>) into one part,
  // so the write cadence here is decoupled from delivery — the client just
  // replaces that part's data on each arrival.
  //
  // Writes are THROTTLED (see progress-throttle.ts): the getWritable() pump
  // drains only ~55-60 chunks/sec, and writing every token fire-and-forget
  // backed up a queue whose tail (the whole answer) arrived ~49s after the
  // turn rendered. Stage changes and line resets force-send immediately so the
  // thinking → answer transition and the per-line re-render stay visible.
  let progressWriter: WritableStreamDefaultWriter<UIMessageChunk> | null = null;
  let progressState: ProgressWriteState = {
    lastWriteMs: 0,
    lastLine: "",
    lastStage: undefined,
    sentAny: false,
  };

  const emitLine = (line: string, stage: "thinking" | "writing") => {
    if (!progressWriter) {
      try {
        progressWriter = getWritable<UIMessageChunk>().getWriter();
      } catch {
        return;
      }
    }
    void progressWriter
      .write({
        type: "data-tool-progress",
        id: `tool-${toolCallId}`,
        data: { toolCallId, toolName: "thinkDeep", text: prefix + line, stage },
      })
      .catch(() => {});
  };

  const writeProgress = () => {
    const source = answer || reasoning;
    if (!source) return;
    const now = Date.now();
    const line = source.slice(source.lastIndexOf("\n") + 1);
    const stage: "thinking" | "writing" = answer ? "writing" : "thinking";
    if (!shouldEmitProgress(progressState, { line, stage }, now)) return;
    progressState = { lastWriteMs: now, lastLine: line, lastStage: stage, sentAny: true };
    emitLine(line, stage);
  };

  // Push the final line at step end so the box settles on the real last line
  // (the last throttled write may have been a few lines behind).
  const flushProgress = () => {
    const source = answer || reasoning;
    if (!source) return;
    const line = source.slice(source.lastIndexOf("\n") + 1);
    const stage: "thinking" | "writing" = answer ? "writing" : "thinking";
    if (
      progressState.sentAny &&
      line === progressState.lastLine &&
      stage === progressState.lastStage
    ) {
      return;
    }
    progressState = {
      lastWriteMs: Date.now(),
      lastLine: line,
      lastStage: stage,
      sentAny: true,
    };
    emitLine(line, stage);
  };

  try {
    const result = await withStepTimeout(
      async () => {
        try {
          // streamText (not generateText) so onChunk can capture BOTH channels
          // progressively — never lost, even mid-thought.
          const stream = await streamText({
            model: createModel(modelConfig),
            system,
            prompt: userPrompt,
            providerOptions,
            // The SDK timeout hook — aborts the stream cleanly at the deadline.
            timeout: streamTimeoutMs,
            onChunk({ chunk }) {
              if (chunk.type === "text-delta") {
                answer += chunk.text;
                // Stream the live reasoning/answer line to the client.
                writeProgress();
              } else if (chunk.type === "reasoning-delta") {
                reasoning += chunk.text;
                writeProgress();
              }
            },
          });
          // Provider warnings (unsupported settings, silent downgrades such as
          // dropped image parts) never throw — log them so a quiet degradation
          // is visible in the server log. Promise-only in the SDK, so attach
          // without touching the control flow.
          void Promise.resolve(stream.warnings).then((w) => {
            if (w?.length) {
              console.warn(
                `[thinkDeep] model=${modelConfig.id} stream warnings:`,
                w,
              );
            }
          });
          return await stream.text;
        } finally {
          // Push the final progress line, then release the writer so the step's
          // HTTP request can terminate (an unreleased lock keeps it alive until
          // timeout).
          try {
            flushProgress();
            progressWriter?.releaseLock();
          } catch {
            /* ignore */
          }
        }
      },
      // Backstop (fires ~3s after the SDK abort): if the abort somehow doesn't
      // surface, withStepTimeout still returns a structured result before the
      // wall — the step never dies silently. This must stay strictly under 300s
      // (plus return overhead) or the platform kill would beat it.
      streamTimeoutMs + 3_000,
      () => answer || undefined,
    );

    if (!result.ok) {
      // Backstop fired (the SDK timeout didn't surface) — same structured return.
      return {
        question,
        ok: false,
        status: "timeout",
        error: `Reasoning fragment did not finish within ${Math.round(result.elapsedMs / 1000)}s and was interrupted.`,
        answer,
        reasoning,
        note: SUB_AGENT_TIMEOUT_NOTE,
      };
    }

    return {
      question,
      ok: true,
      status: "completed",
      answer: result.result ?? "",
      reasoning,
    };
  } catch (err) {
    if (isTimeoutAbort(err)) {
      // The SDK timeout hook aborted the stream — return the partial conclusion
      // and the thinking trail.
      return {
        question,
        ok: false,
        status: "timeout",
        error: `Reasoning fragment did not finish within ${Math.round(streamTimeoutMs / 1000)}s and was interrupted.`,
        answer,
        reasoning,
        note: SUB_AGENT_TIMEOUT_NOTE,
      };
    }
    return {
      question,
      ok: false,
      status: "error",
      error: err instanceof Error ? err.message : "Sub-agent failed",
      answer: "",
      reasoning: "",
    };
  }
}

