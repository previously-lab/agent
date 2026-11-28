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

import { streamText } from "@/lib/deepseek/generate";
import type { ModelMessage } from "@/lib/deepseek/types";
import { type UIMessageChunk } from "@/lib/chat/protocol";
import type { CurrentView } from "@/lib/chat/current-view";
import { getWritable } from "workflow";
import type { DialogueCheckpoint, DialogueOfferContext, DialogueOfferStage, DialogueParentWritable, DialogueSemanticEvent, OfferReplyResult } from "@/lib/dialogue/transport";
import { dialogueOfferId, dialogueSemanticEventSchema, DIALOGUE_OFFER_RESULT, parseOfferReplyResult } from "@/lib/dialogue/transport";
import { parseNativeSections } from "@/lib/markdown/native-sections";
import { WORK_RELATIONS, WORK_RESPONSE_MODES, type WorkRelation, type WorkResponseMode, type WorkUpdateEvent, type WorkUpdateResult, type WorkSnapshot } from "@/lib/dialogue/work-contract";
import { start } from "workflow/api";
// Side effect: keep the step-bundle copy of StepBoundaryLanguageModel
// evaluated in the step runtime so the Workflow 5 SWC plugin's inlined
// serialization-class registration for it runs before any doStreamStep
// message is handled (see src/lib/models/step-boundary-model.ts).

import { readFile, readTextFromCompleteTree, getRepoTreeSnapshot, type RepoTreeSnapshot } from "@/lib/tools/readFile";
import { listFiles } from "@/lib/tools/listFiles";
import { gitHubCaseActivityDates } from "@/lib/github/case-activity";
import {
  readFileLocal,
  walkPathsLocal,
} from "@/lib/tools/local-fs";
import {
  readFileDemo,
  listFilesDemo,
} from "@/lib/demo/demo-fs";

import { searchViaFlash, type WebSearchResult } from "@/lib/search/flash-search";
import { deepseekWebSearch, deepseekWebFetch } from "@/lib/search/deepseek-web";
import type { WebFetchInput } from "@/lib/search/web-input";
import { describeImage } from "@/lib/vision/describe-image";
import { formatImageMetadata } from "@/lib/vision/image-meta";
import { isAIConfigured } from "@/lib/capabilities";
import { hasDeepSeekCredential } from "@/lib/deepseek/credentials";
import {
  checkDocRework,
  logDocReworkSignal,
  recordDocRead,
  extractSliceIds,
} from "@/lib/episodic/rework-signal";
import { questionRun } from "@/app/api/evolution/question-run";
import { readSelfSopSnapshot } from "@/lib/evolution/store";
import {
  TaskLedgerError,
  taskRefForCase,
  type TaskEvidence,
  type TaskQuery,
} from "@/lib/tasks/contracts";
import { queryTasks } from "@/lib/tasks/ledger";
import {
  readTaskLedger,
  updateTaskFromUserFeedback,
} from "@/lib/tasks/store";
import { registerTaskWithDocument } from "@/lib/tasks/registration";
import { fieldCreateTaskSchema, fieldUpdateTaskSchema, type FieldCreateTaskInput, type FieldUpdateTaskInput } from "@/lib/chat/task-input";
import { listPendingTaskResults } from "@/lib/tasks/selector";
import type {
  ReportTaskFollowupInput,
  ReportTaskFollowupResult,
} from "@/lib/chat/task-followups";
import { stableTaskOperationId } from "@/lib/chat/task-identity";
import {
  createCaseReadEnvelope,
} from "@/lib/chat/case-read-receipt";
import { reconstructCaseReadScope } from "@/lib/agents/case-read-proof";
import { collectThinkingReads, createThinkingReadReceipt, wrapThinkingRead, type ThinkingRead } from "@/lib/agents/thinking-read-receipt";
import { caseStorageRevision, parseCaseCurrent } from "@/lib/docs/case-doc";
import { isHistoryArchiveFileName } from "@/lib/docs/history-archive";
import { archiveCaseDocument } from "@/lib/docs/archive-case";
import { parseCanonicalDocumentRef } from "@/lib/documents/document-link";
import { replaceMainCraftBlock } from "@/lib/chat/craft-prompt";
import {
  readSkillLedger,
  readSkillSource,
} from "@/lib/evolution/skill-store";
import { renderRoleSkillGuidance } from "@/lib/evolution/skill-policy";
import { runScenarioRecall, type ScenarioRecallResult } from "@/lib/agents/scenario-recall";
import {
  createConversationRecordReadRedirect,
  directPublicRecordRef,
  scenarioRecallRequestSchema,
  singleRecordForVerification,
  withoutConversationEntryContent,
  type ConversationRecordReadRedirect,
  type PublicRecordReadResult,
  type ScenarioRecallRequest,
} from "@/lib/chat/scenario-recall-contract";

import { readCaseAttachment } from "@/lib/tools/attachments";
import {
  caseIndexPath,
  isValidCaseName,
  sanitizeCaseSegment,
  isCaseCategory,
  isUserModelCase,
} from "@/lib/docs";
import {
  recallRecent,
  recallFind,
  recallSearch,
  recallRead,
  recallSince,
  readChangesSince,
  renderRecallResult,
  renderRecallReadResult,
  renderRecallSinceResult,
  isRecallCategory,
  type RecallBackend,
  type RecallCategory,
  type RecallResult,
  type RecallReadRange,
  type RecallReadResult,
} from "@/lib/memory/facade";
import {
  findMemoryPaths, listMemoryDirectory, recallListInputSchema, recallPathFindInputSchema,
  type DirectoryResult, type RecallListInput, type RecallPathFindInput,
} from "@/lib/memory/navigation";
import { readTextPage } from "@/lib/retrieval/text-page";
import { loadMemoryNavigationPaths } from "@/lib/memory/navigation-inventory";
import { recallSearchQuerySchema } from "@/lib/memory/search-query";
import {
  DOC_MARKER_PREFIX,
  extractDocMarkers,
  applyCaseWriteIntent,
  type DocMarker,
} from "@/lib/episodic/flash/librarian";
import {
  createBatch,
  flushBatch,
  fsReadFile,
  fsWriteFile,
} from "@/lib/episodic/io-helpers";
import { withSliceLock } from "@/lib/episodic/slice-mutex";
import { sliceIdToAgentPath } from "@/lib/episodic/manager";
import { slicePartPath } from "@/lib/episodic";
import { buildDateAnchors } from "@/lib/time/relative";
import { formatLocalTime } from "@/lib/turn-priming";
import { loadUserConfig } from "@/lib/config/loader";
import { DEFAULTS } from "@/lib/config/defaults";

import { resolveMainModelFromConfig } from "@/lib/models/resolve";
import { resolveSubAgentModel } from "@/lib/agents/sub-agent-runner";
import { FIXED_MODEL, type ModelConfig } from "@/lib/models/registry";
import { isTransientError, triageErrorMessage } from "@/lib/chat/tool-triage";
import { parseSliceId } from "@/lib/episodic/turn-parser";
import {
  describeRoom,
  formatRoomDescription,
} from "@/lib/game/describe-room";
import {
  shouldEmitProgress,
  type ProgressWriteState,
} from "@/lib/chat/progress-throttle";

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
  /** The current conversation's persistence slice id. */
  sliceId: string;
  /** The user turn this executor answers, including an episode bubble's own id. */
  turnId: string;
  /** Run-local evidence scope; continuations retain the original value. */
  readScopeId: string;
  thinkingFlow?: boolean;
  /** Exact current user text, never a continuation nudge or generated UI state. */
  currentUserText: string;
  /** The validated room/card the reader is looking at; visual context only. */
  view?: CurrentView;
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
   * agent. Sub-agents (thinkDeep) use it directly so each call
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
  /** Server-owned native dialogue offer context; never supplied by the browser. */
  dialogueOffer?: import("@/lib/dialogue/transport").DialogueOfferContext;
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
  messages?: ModelMessage[];
  abortSignal?: AbortSignal;
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

// ─── Shared read helpers ───────────────────────────────────────────────────

// ─── Memory navigation and reads ─────────────────────────────────────────
// Directory tools return paths and refs, with no document text. The recall
// facade handles text search, recent activity, and content reads by ref.

/** Build the facade's read backend from the tool context's storage flags. */
function createRecallBackend(ctx: ToolContext): RecallBackend {
  // One read-only tool invocation spans enumeration, ranking and opening the
  // result. Even a truncated-tree directory walk must stay on its commit.
  let snapshot: Promise<RepoTreeSnapshot> | undefined;
  const getSnapshot = () => snapshot ??= getRepoTreeSnapshot(ctx.repo, ctx.owner).catch(error => {
    snapshot = undefined;
    throw error;
  });
  return {
    async caseActivityDates(nodes) {
      if (!ctx.useGithub || ctx.useDemo) return undefined;
      return gitHubCaseActivityDates((await getSnapshot()).tree, nodes, ctx.repo, ctx.owner);
    },
    async readFile(path) {
      if (ctx.useDemo) return readFileDemo(path);
      if (!ctx.useGithub) return readFileLocal(path);
      const { tree, ref } = await getSnapshot();
      return tree.truncated
        ? readFile(path, ctx.repo, ctx.owner, { ref })
        : readTextFromCompleteTree(tree, path, ctx.repo, ctx.owner);
    },
    listMemoryFiles: async (scope): Promise<string[]> => {
      const root = scope ? `memory/${scope.category}` : "memory";
      if (!ctx.useGithub && !ctx.useDemo) {
        // Dirent traversal skips symlinks. Prune by UTC date prefix before visiting
        // month/day directories; attachments and other slice subdirectories never open.
        if (scope?.category === "records") {
          return walkPathsLocal(root, {
            maxDepth: 5, requireRealRoot: true,
            descend: path => {
              const parts = path.slice(root.length + 1).split("/");
              const expected = [4, 2, 2, 4];
              const segment = parts[parts.length - 1]!;
              if (segment.length !== expected[parts.length - 1] || !/^\d+$/.test(segment)) return false;
              const prefix = parts.slice(0, 3).join("-");
              return (!scope.after || prefix >= scope.after.slice(0, prefix.length)) &&
                (!scope.before || prefix <= scope.before.slice(0, prefix.length));
            },
          });
        }
        return walkPathsLocal(root, { maxDepth: scope ? 1 : Infinity, requireRealRoot: true });
      }
      const github = ctx.useGithub && !ctx.useDemo ? await getSnapshot() : undefined;
      if (github) {
        if (!github.tree.truncated) {
          // The cached memory/ tree: within the TTL this costs zero API calls.
          return github.tree.entries
            .filter((e) => e.type === "blob" && e.path.startsWith(root + "/"))
            .map((e) => e.path);
        }
        // A truncated listing cannot truthfully answer "what exists" — fall
        // back to the per-directory walk (completeness outranks burst).
      }
      const listDir = (path: string) =>
        ctx.useDemo
          ? listFilesDemo(path)
          : listFiles(path, ctx.repo, ctx.owner, { ref: github!.ref });
      const paths: string[] = [];
      const walk = async (dir: string): Promise<void> => {
        let entries: Array<{ name: string; type: string }>;
        try {
          entries = await listDir(dir);
        } catch (error) {
          if (error instanceof Error && /^Directory not found|^File not found/.test(error.message)) return;
          throw error;
        }
        for (const e of entries) {
          const p = `${dir}/${e.name}`;
          if (e.type === "dir") await walk(p);
          else if (p.startsWith("memory/")) paths.push(p);
        }
      };
      await walk(root);
      return paths;
    },
  };
}

function publicRecallResult(result: RecallResult): RecallResult {
  if (result.kind === "entries" || result.kind === "fallback") {
    return { ...result, entries: result.entries.map(withoutConversationEntryContent) };
  }
  if (result.kind === "not_found") {
    return { ...result, nearMisses: result.nearMisses.map(withoutConversationEntryContent) };
  }
  return result;
}

export async function recallRecentExecute(
  input: { category?: string; n?: number; offset?: number; before?: string; after?: string },
  { context: ctx }: ExecuteOpts<ToolContext>,
): Promise<string> {
  "use step";
  const rawCategory = input.category?.trim();
  if (rawCategory && !isRecallCategory(rawCategory)) {
    return renderRecallResult(
      { kind: "unavailable", note: `unknown category ${JSON.stringify(input.category)}` },
      {},
    );
  }
  const category: RecallCategory | undefined = rawCategory
    ? (rawCategory as RecallCategory)
    : undefined;
  const result = await recallRecent(createRecallBackend(ctx), {
    ...(category ? { category } : {}),
    ...(input.n !== undefined ? { n: input.n } : {}),
    ...(input.offset !== undefined ? { offset: input.offset } : {}),
    ...(input.before ? { before: input.before } : {}),
    ...(input.after ? { after: input.after } : {}),
  });
  return renderRecallResult(publicRecallResult(result), { ...(category ? { category } : {}) });
}

type DirectoryToolResult = DirectoryResult | { kind: "unavailable"; note: string };

/** Inventory only. Model arguments never become a backend path. */
function directoryPaths(ctx: ToolContext, category?: string): Promise<string[]> {
  const source = ctx.useGithub ? { kind: "github" as const, owner: ctx.owner, repo: ctx.repo }
    : ctx.useDemo ? { kind: "demo" as const } : { kind: "local" as const };
  return loadMemoryNavigationPaths(source, category);
}

export async function recallListExecute(
  input: RecallListInput,
  { context: ctx }: ExecuteOpts<ToolContext>,
): Promise<DirectoryToolResult> {
  "use step";
  const parsed = recallListInputSchema.safeParse(input);
  if (!parsed.success) return { kind: "invalid_scope", note: "Expected a public memory directory and valid pagination." };
  const preflight = listMemoryDirectory([], parsed.data);
  if (!parsed.data.path || preflight.kind === "invalid_scope") return preflight;
  try {
    return listMemoryDirectory(await directoryPaths(ctx, parsed.data.path.split("/")[0]), parsed.data);
  } catch {
    return { kind: "unavailable", note: "The memory directory could not be listed completely. Retry later." };
  }
}

export async function recallFindExecute(
  input: RecallPathFindInput,
  { context: ctx }: ExecuteOpts<ToolContext>,
): Promise<DirectoryToolResult | string> {
  "use step";
  const parsed = recallPathFindInputSchema.safeParse(input);
  if (!parsed.success) return { kind: "invalid_scope", note: "Expected a name or public memory path and valid scope." };
  const { category, name, under } = parsed.data;
  try {
    if (category === "records" || category === "timeline") {
      if (under !== undefined || parsed.data.offset !== undefined || parsed.data.limit !== undefined) {
        return { kind: "invalid_scope", note: "Record lookup accepts a date or slice ID, without directory scope or pagination." };
      }
      const result = await recallFind(createRecallBackend(ctx), { category, name });
      return renderRecallResult(publicRecallResult(result), { category, name });
    }
    const preflight = findMemoryPaths([], parsed.data);
    if (preflight.kind === "invalid_scope") return preflight;
    const path = under || (name.replace(/\/$/, "").includes("/") ? name : undefined);
    const scope = category ?? path?.split("/")[0];
    return findMemoryPaths(await directoryPaths(ctx, scope), parsed.data);
  } catch {
    return { kind: "unavailable", note: "The memory inventory could not be read completely. Retry later." };
  }
}

export async function recallSearchExecute(
  input: {
    query: string | string[];
    category?: string;
    includeRecords?: boolean;
    dateBasis?: "activity" | "conversation";
    turnLinks?: "user" | "assistant" | "both";
    since?: string;
    until?: string;
    limit?: number;
    offset?: number;
    scanCursor?: number;
  },
  { context: ctx, toolCallId }: ExecuteOpts<ToolContext>,
): Promise<string> {
  "use step";
  const rawCategory = input.category?.trim();
  if (rawCategory && !isRecallCategory(rawCategory)) {
    return renderRecallResult(
      { kind: "unavailable", note: `unknown category ${JSON.stringify(input.category)}` },
      {},
    );
  }
  const category: RecallCategory | undefined = rawCategory
    ? (rawCategory as RecallCategory)
    : undefined;
  const query = recallSearchQuerySchema.safeParse(input.query);
  if (!query.success) {
    return renderRecallResult({ kind: "unavailable", note: "Expected a nonempty keyword or a list of nonempty keywords." }, {});
  }
  const keywords = Array.isArray(query.data) ? query.data : [query.data];
  const result = await recallSearch(createRecallBackend(ctx), {
    query: keywords,
    includeSemanticPassages: ctx.thinkingFlow === true,
    turnLinks: input.turnLinks,
    ...(input.dateBasis ? { dateBasis: input.dateBasis, timezone: ctx.timezone } : {}),
    ...(category ? { category } : {}),
    ...(input.includeRecords !== undefined ? { includeRecords: input.includeRecords } : {}),
    ...(input.since ? { since: input.since } : {}),
    ...(input.until ? { until: input.until } : {}),
    ...(input.limit !== undefined ? { limit: input.limit } : {}),
    ...(input.offset !== undefined ? { offset: input.offset } : {}),
    ...(input.scanCursor !== undefined ? { scanCursor: input.scanCursor } : {}),
  });
  const text = renderRecallResult(publicRecallResult(result), {
    query: keywords.join(" "),
    ...(category ? { category } : {}),
    ...(input.limit !== undefined ? { limit: input.limit } : {}),
  });
  if (!ctx.thinkingFlow || result.kind !== "entries" || !result.passages?.length) return text;
  const asOf = new Date().toISOString();
  const reads = result.passages.map(passage => ({
    ...passage, sourceKind: "semantic_document" as const, coverage: "excerpt" as const, asOf,
  }));
  const links = result.turnNavigation?.length
    ? "\nTURN NAVIGATION ONLY — these documents link to the following candidate messages. " +
      "A link alone establishes neither the words nor agreement. To verify a requested original, pass relevant cardTargets to recallScenario.targets.\n" +
      JSON.stringify(result.turnNavigation)
    : "";
  return wrapThinkingRead(createThinkingReadReceipt(ctx.readScopeId, toolCallId, reads),
    text + links);
}

/**
 * recallRead — read semantic documents. Original conversation refs redirect
 * to recallScenario before any backend read. A successful semantic read still
 * records the document and any referenced slices for the source audit;
 * partial ranges and outlines never receive a full-index read receipt.
 */
function renderThinkingRead(result: RecallReadResult, ref: string, ctx: ToolContext, toolCallId: string,
  input: { range?: RecallReadRange; includeHistory?: boolean }): string {
  const text = renderRecallReadResult(result, ref);
  if (!ctx.thinkingFlow) return text;
  return wrapThinkingRead(observeThinkingRead(result, ref, ctx, toolCallId, input, text), text);
}

function observeThinkingRead(result: RecallReadResult, ref: string, ctx: ToolContext, toolCallId: string,
  input: { range?: RecallReadRange; includeHistory?: boolean }, text: string) {
  const asOf = new Date().toISOString();
  const source = { sourceKind: "semantic_document" as const, asOf };
  const reads: Omit<ThinkingRead, "evidenceId">[] = [];
  if (result.kind === "no_matching_turns") return createThinkingReadReceipt(ctx.readScopeId, toolCallId, reads);
  if (ref.startsWith("records/")) {
    const coverage = result.kind === "outline" ? "outline"
      : result.kind !== "content" || text.startsWith("ERROR:") ? "failed" : input.range ? "range" : "full";
    reads.push({ ref, sourceKind: "original_turn", edition: "original", asOf, coverage,
      revision: result.kind === "content" ? result.storageRevision ?? null : null });
  } else if (result.kind === "content" && (result.path.startsWith("memory/") || result.path.startsWith("dossier/"))) {
    const actualRef = parseCanonicalDocumentRef(result.path.replace(/^memory\//, "").replace(/(?:\/index)?\.md$/, ""));
    if (actualRef && result.storageRevision) {
      const coverage = text.startsWith("ERROR:") ? "failed" as const : input.range ? "range" as const : "full" as const;
      const edition = isHistoryArchiveFileName(result.path) ? "history" as const
        : result.currentUnderstanding ? "original" as const : "current" as const;
      const range = input.range?.type === "lines" && input.range.start && input.range.end
        ? { start: input.range.start, end: input.range.end } : undefined;
      const mentionedSliceIds = ctx.dialogueOffer && coverage !== "failed" && !actualRef.startsWith("records/")
        ? extractSliceIds(result.content) : [];
      reads.push({ ...source, ref: actualRef, coverage, edition, revision: result.storageRevision,
        ...(mentionedSliceIds.length ? { mentionedSliceIds } : {}),
        ...(range ? { range } : {}) });
      if (result.currentUnderstanding && !input.range) {
        const currentRaw = result.currentUnderstanding.content;
        const revision = caseStorageRevision(currentRaw);
        // Missing basis is just as incomplete as a basis that names older
        // bytes. Neither may be promoted to a verified current read.
        const stale = Boolean(result.freshnessWarnings?.length);
        reads.push({ ...source, ref: actualRef, revision, edition: "current", coverage: stale ? "stale" : "full" });
        if (input.includeHistory && parseCaseCurrent(currentRaw).history) {
          reads.push({ ...source, ref: actualRef, revision, edition: "history", coverage: "full" });
        }
      }
    }
    if (actualRef && result.pieceCatalog) {
      reads.push({ sourceKind: "navigation", asOf, ref: actualRef, edition: "current",
        coverage: "outline", revision: result.pieceCatalog.revision });
    }
  } else {
    const canonical = parseCanonicalDocumentRef(ref);
    if (canonical) reads.push({ ...source, ref: canonical, revision: null,
      coverage: result.kind === "outline" ? "outline" : "failed" });
  }
  return createThinkingReadReceipt(ctx.readScopeId, toolCallId, reads);
}

export async function recallReadExecute(
  input: {
    ref: string;
    offset?: number;
    revision?: string;
    part?: "core" | "agent" | "previously";
    range?: RecallReadRange;
    outline?: boolean;
    includeHistory?: boolean;
    /** Deliberate original-record read; not the default recollection path. */
    direct?: boolean;
  },
  { context: ctx, toolCallId }: ExecuteOpts<ToolContext>,
): Promise<string | ConversationRecordReadRedirect | PublicRecordReadResult> {
  "use step";
  const ref = input.ref?.trim();
  if (!ref) {
    return renderRecallReadResult({ kind: "not_found" }, "");
  }
  if (input.part && !["core", "agent", "previously"].includes(input.part)) {
    return renderRecallReadResult(
      { kind: "unavailable", note: `unknown part ${JSON.stringify(input.part)}` },
      ref,
    );
  }
  const directRef = directPublicRecordRef(input);
  const recordRedirect = createConversationRecordReadRedirect(ref);
  if (recordRedirect && !directRef) return recordRedirect;
  const result = await recallRead(createRecallBackend(ctx), {
    ref: directRef ?? ref,
    ...(directRef ? { publicRecordOnly: true } : {}),
    ...(input.part ? { part: input.part } : {}),
    ...(input.range ? { range: input.range } : {}),
    ...(input.outline ? { outline: true } : {}),
    ...(input.includeHistory ? { includeHistory: true } : {}),
    ...(ctx.thinkingFlow ? { includePieceCatalog: true } : {}),
    ...(ctx.timezone ? { timezone: ctx.timezone } : {}),
  });

  const rendered = renderRecallReadResult(result, directRef ?? ref);
  const pageSize = 16_000;
  const offset = input.offset ?? 0;
  if (result.kind === "content" || result.kind === "outline" || result.kind === "archived") {
    const page = readTextPage(rendered, input, pageSize);
    if (!page.ok) return `ERROR: ${page.error}`;
    if (offset > 0 || page.end < page.total) {
      const { revision: selectionRevision, end, text: content } = page;
      const next = end < rendered.length
        ? `\n\n[More text. Repeat recallRead with the same selection, offset ${end}, revision "${selectionRevision}".]` : "";
      const text = content + next;
      if (directRef) {
        return { kind: "public_record_v1", scopeId: ctx.readScopeId, toolCallId, ref: directRef, text,
          ...(ctx.thinkingFlow ? { thinkingReceipt: createThinkingReadReceipt(ctx.readScopeId, toolCallId, [{
            ref: directRef, sourceKind: "original_turn", edition: "original", coverage: "range", asOf: new Date().toISOString(),
            revision: result.kind === "content" ? result.storageRevision ?? null : null,
          }]) } : {}) };
      }
      let pageText = text;
      if (result.kind === "content") {
        const sourceRef = parseCanonicalDocumentRef(result.path.replace(/^memory\//, "").replace(/(?:\/index)?\.md$/, ""));
        if (sourceRef && ctx.thinkingFlow) {
          pageText = wrapThinkingRead(createThinkingReadReceipt(ctx.readScopeId, toolCallId, [{
            ref: sourceRef, sourceKind: "semantic_document", asOf: new Date().toISOString(),
            coverage: "range", revision: selectionRevision,
          }]), text);
        }
        if (!ctx.dialogueOffer && result.path.startsWith("memory/")) recordDocRead(ctx.sliceId, result.path, extractSliceIds(content));
        const match = !input.range && !input.outline && /^memory\/([^/]+)\/([^/]+)\/index\.md$/.exec(result.path);
        if (match && isCaseCategory(match[1]) && result.caseRevision && end > offset) {
          return createCaseReadEnvelope({ scopeId: ctx.readScopeId, toolCallId, requestedRef: ref,
            category: match[1], caseName: match[2]!, revision: result.caseRevision, rendered: pageText,
            page: { revision: selectionRevision, start: offset, end, total: rendered.length } });
        }
      }
      return pageText;
    }
  }
  if (directRef) {
    const text = rendered;
    return {
      kind: "public_record_v1", scopeId: ctx.readScopeId, toolCallId, ref: directRef, text,
      ...(ctx.thinkingFlow ? { thinkingReceipt: observeThinkingRead(result, directRef, ctx, toolCallId, input, text) } : {}),
    };
  }

  if (result.kind === "content") {
    if (!ctx.dialogueOffer && result.path.startsWith("memory/") && !result.path.startsWith("memory/records/")) {
      recordDocRead(ctx.sliceId, result.path, extractSliceIds(result.content));
    }
    const caseMatch = !input.outline && !input.range
      ? /^memory\/([^/]+)\/([^/]+)\/index\.md$/.exec(result.path)
      : null;
    if (caseMatch && isCaseCategory(caseMatch[1]) && result.caseRevision) {
      try {
        return createCaseReadEnvelope({
          scopeId: ctx.readScopeId,
          toolCallId,
          requestedRef: ref,
          category: caseMatch[1],
          caseName: caseMatch[2]!,
          revision: result.caseRevision,
          rendered: renderThinkingRead(result, ref, ctx, toolCallId, input),
        });
      } catch (error) {
        return renderRecallReadResult({
          kind: "unavailable",
          note: error instanceof Error ? error.message : String(error),
        }, ref);
      }
    }
  }
  return renderThinkingRead(result, ref, ctx, toolCallId, input);
}

// ─── recallSince — the differential view (v0.11) ──────────────────────────

/** Question-conditioned recollection, with verified excerpts from original records. */
export async function recallScenarioExecute(
  input: ScenarioRecallRequest,
  { context: ctx, toolCallId, messages = [], abortSignal }: ExecuteOpts<ToolContext>,
): Promise<ScenarioRecallResult & { thinkingReceipt?: ReturnType<typeof createThinkingReadReceipt> }> {
  "use step";
  const request = scenarioRecallRequestSchema.parse(input);
  await emitToolProgress(toolCallId, "recallScenario", "Recollecting the conversation…", "running");
  const refToVerify = ctx.thinkingFlow ? singleRecordForVerification(request) : undefined;
  const priorRecord = refToVerify
    ? collectThinkingReads(messages, ctx.readScopeId, "recallRead").findLast(read => read.ref === refToVerify &&
        read.sourceKind === "original_turn" && read.edition === "original" && read.coverage === "full" &&
        /^[a-f0-9]{64}$/.test(read.revision ?? "")) : undefined;
  const result = await runScenarioRecall({
    ...request,
    sessionId: ctx.sliceId,
    backend: createRecallBackend(ctx),
    model: FIXED_MODEL,
    timezone: ctx.timezone,
    signal: abortSignal,
    trackRevision: ctx.thinkingFlow,
    preferExactTargets: ctx.thinkingFlow === true,
    ...(priorRecord?.revision ? { priorFullRecord: { ref: priorRecord.ref, revision: priorRecord.revision } } : {}),
  });
  if (result.evidence.length > 0) {
    const seen = new Set<string>();
    const references = result.evidence.flatMap((evidence) => {
      const sliceId = /^records\/(\d{4}-\d{2}-\d{2}-\d{4})$/.exec(evidence.ref)?.[1];
      if (!sliceId || !parseSliceId(sliceId) || !evidence.quote.trim() || seen.has(sliceId)) return [];
      seen.add(sliceId);
      return [{ slice_id: sliceId, note: evidence.note }];
    });
    // Only evidence verified by the read-only recall agent counts as a record
    // read. Requested refs and search/read coverage alone prove no recollection.
    // Native dialogue projects the read set once its actual landing slice is known.
    if (!ctx.dialogueOffer) {
      for (const { slice_id: sliceId } of references) {
        try {
          const docFileName = checkDocRework(ctx.sliceId, sliceId);
          if (docFileName) await logDocReworkSignal(ctx.sliceId, sliceId, docFileName);
        } catch (error) {
          console.warn("[recallScenario] source-reference audit failed:", error instanceof Error ? error.message : error);
        }
      }
    }
    try {
      const writer = getWritable<UIMessageChunk>().getWriter();
      try { await writer.write({ type: "data-recall-references", data: { references } } as UIMessageChunk); }
      finally { writer.releaseLock(); }
    } catch { /* Evidence remains in the durable tool result if the live stream closed. */ }
  }
  await emitToolProgress(toolCallId, "recallScenario", result.evidence.length > 0
    ? `Recovered ${result.evidence.length} verified excerpt(s).`
    : "Recollection finished with no verified excerpt.", "done");
  if (!ctx.thinkingFlow) return result;
  const asOf = new Date().toISOString();
  const reads: Omit<ThinkingRead, "evidenceId">[] = result.evidence.flatMap((evidence) => evidence.sourceRevision ? [{
    ref: evidence.ref, revision: evidence.sourceRevision, asOf, sourceKind: "original_turn" as const,
    coverage: "excerpt" as const, edition: "original" as const, turnId: evidence.turnId, turnIndex: evidence.turnIndex,
    role: evidence.role, excerpt: evidence.quote,
  }] : []);
  const attemptedRefs = result.coverage.unsearchedRefs === undefined ? request.refs ?? [] : [];
  for (const ref of attemptedRefs) if (!reads.some((read) => read.ref === ref)) {
    reads.push({ ref, revision: null, asOf, sourceKind: "original_turn", coverage: "failed", edition: "original" });
  }
  return { ...result, thinkingReceipt: createThinkingReadReceipt(ctx.readScopeId, toolCallId, reads) };
}
//
// "自某天以来变了什么" — the commit history IS the diff: the read comes from
// the ledger (facade.readChangesSince), never from a new store. This executor
// validates, picks the default window (neither `since` nor `cursor` → the
// last 1 day, user calendar), and renders with the FIXED template.

/** User-local day one day before today — the default "最近 1 天" window. */
function defaultChangesSince(timezone: string | undefined): string {
  const day = userLocalDate(timezone);
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

export async function recallSinceExecute(
  input: { since?: string; cursor?: string; category?: string; limit?: number },
  { context: ctx }: ExecuteOpts<ToolContext>,
): Promise<string> {
  "use step";
  const rawCategory = input.category?.trim();
  if (rawCategory && !isRecallCategory(rawCategory)) {
    return renderRecallSinceResult({
      kind: "unavailable",
      note: `unknown category ${JSON.stringify(input.category)}`,
    });
  }
  const category: RecallCategory | undefined = rawCategory
    ? (rawCategory as RecallCategory)
    : undefined;
  const since = input.since?.trim();
  if (since && !/^\d{4}-\d{2}-\d{2}$/.test(since)) {
    return renderRecallSinceResult({
      kind: "unavailable",
      note: `since must be YYYY-MM-DD, got ${JSON.stringify(input.since)}`,
    });
  }
  const cursor = input.cursor?.trim();
  if (cursor && !/^[0-9a-f]{7,40}$/i.test(cursor)) {
    return renderRecallSinceResult({
      kind: "unavailable",
      note: `cursor must be a commit sha, got ${JSON.stringify(input.cursor)}`,
    });
  }
  if (ctx.useDemo) {
    return renderRecallSinceResult({
      kind: "unavailable",
      note: "Demo mode runs on read-only benchmark data — there is no commit log to diff",
    });
  }
  const read = await readChangesSince({
    since: since ?? defaultChangesSince(ctx.timezone),
    ...(cursor ? { cursor } : {}),
  });
  if (read.unavailable) {
    return renderRecallSinceResult({ kind: "unavailable", note: read.unavailable });
  }
  const result = recallSince(read, {
    ...(category ? { category } : {}),
    ...(since ? { since } : {}),
    ...(cursor ? { cursor } : {}),
    ...(input.limit !== undefined ? { limit: input.limit } : {}),
  });
  return renderRecallSinceResult(result);
}


// ─── noteForSediment — the sediment mailbox producer (v0.15 design §3.1/§4.3) ──

/**
 * One of the reply segment's TWO bounded writes to memory (alongside
 * writeCase since v0.21 — that one lands the document itself). The main
 * agent is otherwise read-only on memory by design — v0.15 §4.3 designates
 * the reply segment as "只读 + 记账":
 * this tool is the 记账. It appends ONE structured `[doc-marker]` line to the
 * CURRENT slice's agent.md (the inter-stream mailbox, §3.1); the actual
 * document write happens later, when HQ archives the slice — the
 * scribe/librarian passes that consume these markers run on HQ's archive. It
 * never touches core.md (the evidence record) and never writes a document
 * itself.
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
  // Serialize the fresh read-modify-append per slice: the calling executors
  // (noteForSediment, startLongTask) run as tool steps OUTSIDE the turn's
  // slice lock, so two interleaved appends could otherwise lose a marker
  // line. Nothing in the subtree below re-takes this key.
  return withSliceLock(ctx.sliceId, async () => {
  let existing = "";
  try {
    // fresh: read-modify-append — a cached base would silently drop markers
    // other steps landed in between (io-helpers contract).
    existing = await fsReadFile(slicePartPath(ctx.sliceId, "agent"), undefined, { fresh: true });
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
  });
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
  | { ok: true; action: "open" | "addPiece"; path: string; noop?: boolean; warnings?: string[] }
  | { ok: false; reason: string; code?: string; details?: unknown };

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
 * writeCase — open a case (or add a dated piece to an existing one) IN THE
 * MIDDLE of the reply, so the turn writes the document FIRST and then
 * answers FROM it (v0.20 §2.1 选案 (a)).
 *
 * Bounded exactly as §2.2 prescribes:
 * - 分类界: every category is writable but two — people/user and self/ are
 *   the reflection unit's write surface (the user model is evolved, never
 *   written mid-conversation); both refuse here, as do
 *   names outside the nine-category set;
 * - 操作界: only `open` and `addPiece` reach `applyCaseWriteIntent`
 *   (rewriteIndex / appendTail / close are never issued);
 * - 冲突界: the shared `applyCaseWriteIntent` entry — per-case lock
 *   `doc:<category>/<case名>`, fresh read inside the lock — so a concurrent
 *   background run on the same case serializes visibly instead of
 *   interleaving bytes.
 *
 * What the caller passes is EXACTLY what lands — no machine fields are
 * stamped in (v0.21: the case→slice link is semantic, so a piece that wants
 * to say where it came from says so in prose). records get zero write-back.
 */
export async function writeCaseExecute(
  input: { category?: string; caseName: string; body: string; pieceTitle?: string; overviewBody?: string; disconfirmingObservation?: string },
  { context: ctx, messages }: ExecuteOpts<ToolContext>,
): Promise<WriteCaseResult> {
  "use step";
  if (ctx.useDemo) {
    return {
      ok: false,
      reason: "Demo mode runs on read-only benchmark data — cases are not written.",
    };
  }
  const category = input.category?.trim() || "research";
  if (!isCaseCategory(category) || category === "self") {
    return {
      ok: false,
      reason:
        `category ${JSON.stringify(input.category)} is not writable from here — ` +
        "allowed: people / events / things / places / orgs / research / hypotheses / tasks. " +
        "people/user and self belong to the reflection unit: it reads the record and writes them — never your pen.",
    };
  }
  const caseName = sanitizeCaseSegment(input.caseName?.trim() ?? "");
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
  if (isUserModelCase(category, caseName)) {
    return {
      ok: false,
      reason:
        "people/user is the reflection unit's alone — the model of the user is evolved, never " +
        "written mid-conversation. It reads the record and keeps those — you never write it.",
    };
  }
  const body = input.body?.trim() ?? "";
  if (!body) {
    return { ok: false, reason: "body must not be empty — write the WHOLE content." };
  }
  const pieceTitle = sanitizeCaseSegment(input.pieceTitle?.trim() ?? "");

  const date = userLocalDate(ctx.timezone);
  const indexPath = caseIndexPath(category, caseName);

  // ONE batch per tool call: an open followed by an addPiece in the SAME call
  // lands as ONE commit (coalesced per call — the queued open is visible to
  // the in-lock fresh read that the addPiece intent re-checks, exactly like
  // the production batch read-your-writes). The call is ATOMIC: the flush
  // runs only when the call SUCCEEDED — a refused outcome drops the queued
  // batch with the call (an open queued by an addPiece that then refuses must
  // NOT commit: the tool reports failure and the model retries against what
  // it believes is an empty state — the mori二面 triple commit, B5). A flush
  // failure surfaces to the step retry — the intents re-apply under the
  // per-case lock and an already-landed open reads back as "already exists",
  // converging on the same tree. Same threading on the local backend:
  // flushBatch applies the entries and records one local commit.
  const batch = createBatch();
  const result = await (async (): Promise<WriteCaseResult> => {
  // Probe for existence OUTSIDE the lock (fresh read); the in-lock checks
  // inside applyCaseWriteIntent are the backstop for the open race.
  let exists = false;
  try {
    await fsReadFile(indexPath, undefined, { fresh: true });
    exists = true;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;
    const status = error && typeof error === "object" && "status" in error
      ? (error as { status?: unknown }).status
      : undefined;
    const message = error instanceof Error ? error.message : String(error);
    if (code !== "ENOENT" && status !== 404 && !/^(File not found|Directory not found)/.test(message) && !/\bENOENT\b/.test(message)) {
      return { ok: false, reason: `case read failed before writing (not absence): ${message}` };
    }
    exists = false;
  }

  if (!exists) {
    try {
      const { caseOpeningBody } = await import("@/lib/docs/organization");
      const indexBody = caseOpeningBody({ category, caseName, date, body, pieceTitle, overviewBody: input.overviewBody });
      const applied = await applyCaseWriteIntent(
        { action: "open", category, caseName, body: indexBody, disconfirmingObservation: input.disconfirmingObservation },
        date,
        batch,
      );
      // A pieceTitle on the OPEN call adds the first piece in the SAME call:
      // the queued open is read back by the addPiece intent (batch
      // read-your-writes) and both files ride the call's single commit.
      if (!pieceTitle) {
        return { ok: true, action: "open", path: applied.path, ...(applied.warnings ? { warnings: applied.warnings } : {}) };
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!msg.includes("already exists")) {
        return { ok: false, reason: `open refused: ${msg}`, ...documentRefusalFields(e) };
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
  const readScope = exists
    ? await reconstructCaseReadScope({ messages: messages ?? [], scopeId: ctx.readScopeId, category, caseName, batch })
    : undefined;
  if (exists && !readScope) {
    return {
      ok: false,
      reason:
        `addPiece refused: ${category}/${caseName} requires a successful full recallRead ` +
        "in this run's read scope. An outline, error, other turn, or unpaired JSON is not proof.",
    };
  }
    const applied = await applyCaseWriteIntent(
      { action: "addPiece", category, caseName, title: pieceTitle, body },
      date,
      batch,
      readScope ?? undefined,
    );
    return { ok: true, action: "addPiece", path: applied.path, ...(applied.noop ? { noop: true } : {}), ...(applied.warnings ? { warnings: applied.warnings } : {}) };
  } catch (e) {
    return { ok: false, reason: `addPiece refused: ${e instanceof Error ? e.message : String(e)}`, ...documentRefusalFields(e) };
  }
  })();
  if (result.ok) {
    try {
      const { stageDocumentProduct } = await import("@/lib/episodic/document-products");
      for (const path of [...batch.entries.keys()]) await stageDocumentProduct(batch, { sliceId: ctx.sliceId, turnIds: [ctx.turnId] }, path);
      await flushBatch(batch, `writeCase ${category}/${caseName}`);
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error), ...documentRefusalFields(error) };
    }
  }
  return result;
}

/** Archive a complete case without deleting its content or changing task state. */
export async function archiveCaseExecute(
  input: { category: string; caseName: string; reason: string },
  { context: ctx }: ExecuteOpts<ToolContext>,
): Promise<{ ok: true; path: string; files: number; noop?: boolean } | { ok: false; reason: string }> {
  "use step";
  try {
    const category = input.category.trim();
    if (!isCaseCategory(category)) throw new Error("Unknown case category");
    return await archiveCaseDocument({
      category, caseName: input.caseName.trim(), reason: input.reason,
      date: ctx.startedAtIso?.slice(0, 10) ?? new Date().toISOString().slice(0, 10),
    });
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

function documentRefusalFields(error: unknown): { code?: string; details?: unknown } {
  if (!error || typeof error !== "object") return {};
  const value = error as { code?: unknown; details?: unknown };
  return { ...(typeof value.code === "string" ? { code: value.code } : {}), ...(value.details ? { details: value.details } : {}) };
}


// ─── Authoritative task state and delivery intent ─────────────────────────

export type QueryTasksToolResult =
  | {
      status: "ready";
      tasks: ReturnType<typeof queryTasks>["tasks"];
      total: number;
      offset: number;
      hasMore: boolean;
      pendingResults: ReturnType<typeof listPendingTaskResults>;
    }
  | { status: "missing" | "unavailable" | "corrupt"; message?: string };

export async function queryTasksExecute(
  input: TaskQuery,
  { context: ctx }: ExecuteOpts<ToolContext>,
): Promise<QueryTasksToolResult> {
  "use step";
  void ctx;
  const read = await readTaskLedger();
  if (read.status !== "ready") {
    return read.status === "missing"
      ? { status: "missing" }
      : { status: read.status, message: read.message };
  }
  const page = queryTasks(read.ledger, { ...input, limit: Math.min(input.limit ?? 30, 50) });
  return {
    status: "ready",
    ...page,
    pendingResults: listPendingTaskResults(read.ledger, {
      ...(input.ref ? { taskRef: input.ref } : {}),
      limit: 30,
    }),
  };
}

export type TaskMutationToolResult =
  | {
      ok: true;
      outcome: "applied" | "deduped";
      attempts: number;
      task: ReturnType<typeof queryTasks>["tasks"][number];
    }
  | { ok: false; reason: string };

function currentTaskEvidence(ctx: ToolContext, quote?: string): TaskEvidence {
  if (!ctx.currentUserText.trim()) {
    throw new TaskLedgerError(
      "invalid_operation",
      "The current user message is empty; task evidence must be an actual user statement",
    );
  }
  if (quote !== undefined && (!quote.trim() || quote.length > 4000 || !ctx.currentUserText.includes(quote))) {
    throw new TaskLedgerError("invalid_operation", "evidenceQuote must be an exact nonempty excerpt of the current user message, at most 4000 characters");
  }
  if (!quote && ctx.currentUserText.length > 4000) {
    throw new TaskLedgerError("invalid_operation", "For a long current message, provide evidenceQuote quoting the actual task commitment or correction (at most 4000 characters)");
  }
  return {
    sliceId: ctx.sliceId,
    turnId: ctx.turnId,
    statement: quote ?? ctx.currentUserText,
  };
}

function taskMutationFailure(error: unknown): TaskMutationToolResult {
  if (error instanceof TaskLedgerError) {
    return { ok: false, reason: `${error.code}: ${error.message}` };
  }
  throw error;
}

export async function createTaskExecute(
  input: FieldCreateTaskInput,
  { context: ctx, toolCallId }: ExecuteOpts<ToolContext>,
): Promise<TaskMutationToolResult> {
  "use step";
  try {
    const parsed = fieldCreateTaskSchema.safeParse(input);
    if (!parsed.success) throw new TaskLedgerError("invalid_operation", parsed.error.message);
    const { evidenceQuote, ...task } = parsed.data;
    const result = await registerTaskWithDocument({
      operationId: stableTaskOperationId("field:create-task", [ctx.readScopeId, toolCallId]),
      now: new Date().toISOString(),
      task,
      userCommitment: currentTaskEvidence(ctx, evidenceQuote),
    });
    return {
      ok: true,
      outcome: result.outcome,
      attempts: result.attempts,
      task: result.ledger.tasks.find((task) => task.ref === input.ref)!,
    };
  } catch (error) {
    return taskMutationFailure(error);
  }
}

export async function updateTaskExecute(
  input: FieldUpdateTaskInput,
  { context: ctx, toolCallId }: ExecuteOpts<ToolContext>,
): Promise<TaskMutationToolResult> {
  "use step";
  try {
    const parsed = fieldUpdateTaskSchema.safeParse(input);
    if (!parsed.success) throw new TaskLedgerError("invalid_operation", parsed.error.message);
    const { evidenceQuote, ...update } = parsed.data;
    const result = await updateTaskFromUserFeedback({
      operationId: stableTaskOperationId("field:update-task", [ctx.readScopeId, toolCallId]),
      now: new Date().toISOString(),
      ...update,
      evidence: currentTaskEvidence(ctx, evidenceQuote),
    });
    return {
      ok: true,
      outcome: result.outcome,
      attempts: result.attempts,
      task: result.ledger.tasks.find((task) => task.ref === input.ref)!,
    };
  } catch (error) {
    return taskMutationFailure(error);
  }
}

export async function reportTaskFollowupExecute(
  input: ReportTaskFollowupInput,
  { context: ctx }: ExecuteOpts<ToolContext>,
): Promise<ReportTaskFollowupResult> {
  "use step";
  void ctx;
  const read = await readTaskLedger();
  if (read.status !== "ready") {
    return {
      ok: false,
      reason: read.status === "missing"
        ? "The task ledger is missing; there is no confirmed result or task to report"
        : `The task ledger is ${read.status}: ${read.message}`,
    };
  }
  if ("ref" in input) {
    const task = read.ledger.tasks.find((item) => item.ref === input.ref);
    if (!task) return { ok: false, reason: `Unknown task: ${input.ref}` };
    if (task.status === "completed" || task.status === "cancelled") {
      return { ok: false, reason: `${input.ref} is already ${task.status}` };
    }
    return {
      ok: true,
      ackIntent: {
        kind: "task",
        followup: { ref: task.ref, expectedRevision: task.revision },
      },
    };
  }
  const result = read.ledger.results.find((item) => item.id === input.resultId);
  if (!result) return { ok: false, reason: `Unknown task result: ${input.resultId}` };
  if (result.delivery.state !== "pending") {
    return { ok: false, reason: `Task result ${input.resultId} was already delivered` };
  }
  return {
    ok: true,
    ackIntent: {
      kind: "result",
      resultId: result.id,
      expectedRevision: result.revision,
    },
  };
}

async function registerLongTaskCommitment(
  ctx: ToolContext,
  toolCallId: string,
  task: string,
  evidenceQuote?: string,
): Promise<{ ok: true; taskRef: string } | { ok: false; reason: string }> {
  const caseName = sanitizeCaseSegment(task);
  if (!caseName || !isValidCaseName(caseName)) {
    return { ok: false, reason: `The task title cannot form a legal task case: ${JSON.stringify(task)}` };
  }
  const taskRef = taskRefForCase(caseName);
  try {
    const evidence = currentTaskEvidence(ctx, evidenceQuote);
    await registerTaskWithDocument({
      operationId: stableTaskOperationId("field:long-task:create", [ctx.readScopeId, toolCallId]),
      now: new Date().toISOString(),
      task: { ref: taskRef, summary: task },
      userCommitment: evidence,
    });
    return { ok: true, taskRef };
  } catch (error) {
    if (error instanceof TaskLedgerError && error.code !== "task_exists") return { ok: false, reason: `${error.code}: ${error.message}` };
    if (!(error instanceof TaskLedgerError) || error.code !== "task_exists") throw error;
  }
  const read = await readTaskLedger({ fresh: true });
  if (read.status !== "ready") {
    return { ok: false, reason: `Cannot verify existing ${taskRef}: ledger ${read.status}` };
  }
  const existing = read.ledger.tasks.find((item) => item.ref === taskRef);
  if (!existing) return { ok: false, reason: `${taskRef} disappeared while being verified` };
  if (existing.status === "completed" || existing.status === "cancelled") {
    return {
      ok: false,
      reason: `${taskRef} is already ${existing.status}; use a new specific title instead of reopening it`,
    };
  }
  try {
    await updateTaskFromUserFeedback({
      operationId: stableTaskOperationId("field:long-task:evidence", [ctx.readScopeId, toolCallId]),
      now: new Date().toISOString(),
      ref: taskRef,
      expectedRevision: existing.revision,
      changes: existing.status === "needs_review" ? { status: "open" } : {},
      evidence: currentTaskEvidence(ctx, evidenceQuote),
    });
    return { ok: true, taskRef };
  } catch (error) {
    if (error instanceof TaskLedgerError) {
      return { ok: false, reason: `${error.code}: ${error.message}` };
    }
    throw error;
  }
}

// ─── offerReply — start public dialogue, never wait for its completion ────

function offerPublicSeq(messages: ModelMessage[] | undefined, toolCallId: string): number {
  let prior = 0;
  for (const message of messages ?? []) {
    if (message.role !== "tool" || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type !== "tool-result" || !["offerReply", "workCheckpoint", "completeWork"].includes(part.toolName)) continue;
      prior++;
    }
  }
  for (let index = (messages?.length ?? 0) - 1; index >= 0; index--) {
    const message = messages![index]!;
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    const calls = message.content.filter(part => part.type === "tool-call" && ["offerReply", "workCheckpoint", "completeWork"].includes(part.toolName));
    const current = calls.findIndex(part => part.type === "tool-call" && part.toolCallId === toolCallId);
    if (current >= 0) return prior + current + 1;
  }
  return prior + 1;
}

function precedingCheckpoints(messages: ModelMessage[] | undefined, workId: string, parentRunId?: string): DialogueCheckpoint[] {
  const candidates = new Map<string, string>();
  const checkpoints = new Map<string, DialogueCheckpoint>();
  for (const message of messages ?? []) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (message.role === "assistant" && part.type === "tool-call" && ["offerReply", "workCheckpoint"].includes(part.toolName)) {
        const input = part.input as { stage?: unknown; text?: unknown } | null | undefined;
        if ((part.toolName === "workCheckpoint" || input?.stage === "checkpoint") && typeof input?.text === "string") {
          candidates.set(part.toolCallId, input.text);
        }
      } else if (message.role === "tool" && part.type === "tool-result" && ["offerReply", "workCheckpoint"].includes(part.toolName)) {
        const text = candidates.get(part.toolCallId);
        if (!text) continue;
        const legacy = parseOfferReplyResult(part.output.value);
        if (legacy?.stage === "checkpoint" && legacy.offerId === dialogueOfferId(workId, part.toolCallId)) {
          checkpoints.set(legacy.offerId, { offerId: legacy.offerId, runId: legacy.runId, text });
          continue;
        }
        const value = part.output.value as { ok?: unknown; updateId?: unknown; runId?: unknown };
        if (value?.ok === true && value.updateId === dialogueOfferId(workId, part.toolCallId)) {
          checkpoints.set(value.updateId, { offerId: value.updateId,
            runId: parentRunId ?? (typeof value.runId === "string" ? value.runId : ""), text });
        }
      }
    }
  }
  return [...checkpoints.values()];
}

type WorkHandoffOptions = { relation?: WorkRelation; dependsOnInputIds?: string[]; responseMode?: WorkResponseMode };

async function startDialogueOffer(params: {
  context: DialogueOfferContext;
  offerId: string;
  publicSeq: number;
  text: string;
  event?: DialogueSemanticEvent;
  stage?: DialogueOfferStage;
  priorCheckpoints: DialogueCheckpoint[];
  workUpdate?: WorkHandoffOptions;
  parentWritable?: DialogueParentWritable;
}): Promise<OfferReplyResult> {
  const { context, offerId, publicSeq, text, event, stage, workUpdate, parentWritable } = params;
  try {
    const result: OfferReplyResult = {
      ok: true,
      kind: DIALOGUE_OFFER_RESULT,
      offerId,
      runId: context.parentRunId,
      parentRunId: context.parentRunId,
      sourceInputId: context.sourceInputId,
      workId: context.workId,
      locale: context.locale,
      text,
      ...(event ? { event } : {}),
      record: context.record,
      ...(stage ? { stage } : {}), publicSeq,
      ...(event ? { eventKind: event.kind } : {}),
    };
    if (workUpdate) {
      const { publishWorkUpdateStep, reconcileDialogueOffersStep } = await import("../chat/dialogue-transport-steps");
      const update: WorkUpdateEvent = {
        type: stage === "checkpoint" ? "work_checkpoint" : "work_completed",
        updateId: offerId, runId: context.parentRunId,
        sourceInputId: context.sourceInputId, workId: context.workId,
        acceptedAt: new Date().toISOString(), publicSeq, locale: context.locale, text,
        ...(event ? { event } : {}), record: context.record,
        ...(workUpdate.responseMode ? { responseMode: workUpdate.responseMode } : {}),
        ...(workUpdate.relation ? { relation: workUpdate.relation } : {}),
        ...(workUpdate.dependsOnInputIds?.length ? { dependsOnInputIds: workUpdate.dependsOnInputIds } : {}),
      };
      try {
        if (parentWritable) await publishWorkUpdateStep(update, parentWritable);
        else await publishWorkUpdateStep(update);
      } catch (error) {
        // Transport may lose the append acknowledgement. Reconcile the
        // original candidate before any notification or host fallback.
        const offers = await reconcileDialogueOffersStep(context.parentRunId);
        if (!offers.some(candidate => candidate.offerId === offerId && candidate.parentRunId === context.parentRunId &&
            candidate.workId === context.workId && candidate.sourceInputId === context.sourceInputId &&
            candidate.stage === stage)) throw error;
      }
    } else {
      // Legacy compatibility only. New thought runs always use workUpdate.
      const { publishDialogueOfferControlsStep } = await import("../chat/dialogue-transport-steps");
      await publishDialogueOfferControlsStep([result]);
    }
    const request = {
      scope: context.scopeKey,
      parentRunId: context.parentRunId,
      sourceInputId: context.sourceInputId,
      workId: context.workId,
      triggerKey: offerId,
      candidateKeys: [offerId],
    };
    try {
      const { ensureDialogueOrchestratorStep: ensure } = await import("../chat/dialogue-orchestrator-steps");
      const started = parentWritable ? await ensure(request, context.holder, parentWritable)
        : workUpdate && context.holder ? await ensure(request, context.holder) : await ensure(request);
      return { ...result, runId: started.runId };
    } catch (error) {
      // The durable update ID makes activation retry safe. Without a witness,
      // reporting success after a failed lookup would leave the offer orphaned.
      console.warn("[Dialogue] work activation needs recovery", error);
      throw error;
    }
  } catch (error) {
    // An append can commit before either its acknowledgement or its recovery
    // read fails. Redeliver the same durable tool call and updateId.
    if (workUpdate) throw error;
    return {
      ok: false,
      kind: DIALOGUE_OFFER_RESULT,
      offerId,
      reason: `The dialogue could not be started: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export async function offerReplyExecute(
  input: { text: string; stage?: DialogueOfferStage; workUpdate?: WorkHandoffOptions },
  { context: ctx, toolCallId, messages }: ExecuteOpts<ToolContext>,
  parentWritable?: DialogueParentWritable,
): Promise<OfferReplyResult> {
  "use step";
  const context = ctx.dialogueOffer as DialogueOfferContext | undefined;
  const offerId = dialogueOfferId(context?.workId ?? ctx.turnId, toolCallId);
  if (!context) return { ok: false, kind: DIALOGUE_OFFER_RESULT, offerId, reason: "This run has no dialogue offer context." };
  const reject = (reason: string): OfferReplyResult => ({ ok: false, kind: DIALOGUE_OFFER_RESULT, offerId, reason });
  const checkpoint = input.stage === "checkpoint";
  if (!input.text.trim()) return reject("text must be nonblank.");
  const priorCheckpoints = precedingCheckpoints(messages, context.workId, context.parentRunId);
  if (checkpoint) {
    if (priorCheckpoints.some((prior) => prior.text.trim() === input.text.trim())) return reject("This checkpoint was already offered.");
    if (parseNativeSections(input.text).some((section) => section.kind === "native")) return reject("Include native artifacts only in the final result.");
    const current = messages?.at(-1);
    if (current?.role === "assistant" && Array.isArray(current.content)) {
      const calls = current.content.filter(part => part.type === "tool-call" && ["offerReply", "workCheckpoint", "completeWork"].includes(part.toolName));
      const first = calls[0];
      if (first?.type === "tool-call" && calls.some(part => part.type === "tool-call" && part.toolCallId === toolCallId)) {
        if (calls.some(part => part.type === "tool-call" && (part.toolName === "completeWork" ||
            (part.toolName === "offerReply" && (part.input as { stage?: unknown } | null)?.stage !== "checkpoint")))) {
          return reject("The final result in this step replaces this checkpoint.");
        }
        if (first.toolCallId !== toolCallId) return reject("Send one combined checkpoint per model response.");
      }
    }
  }
  const publicSeq = offerPublicSeq(messages, toolCallId);
  return startDialogueOffer({
    context, offerId, publicSeq, text: input.text, parentWritable,
    ...(input.stage ? { stage: input.stage } : {}),
    priorCheckpoints,
    ...(input.workUpdate ? { workUpdate: input.workUpdate } : {}),
  });
}

// Host semantic results can use the new work contract without model drafting.
export async function offerDialogueEventExecute(
  input: { event: DialogueSemanticEvent; stage?: DialogueOfferStage; workUpdate?: WorkHandoffOptions },
  { context: ctx, toolCallId, messages }: ExecuteOpts<ToolContext>,
): Promise<OfferReplyResult> {
  "use step";
  const context = ctx.dialogueOffer as DialogueOfferContext | undefined;
  const offerId = dialogueOfferId(context?.workId ?? ctx.turnId, toolCallId);
  if (!context) return { ok: false, kind: DIALOGUE_OFFER_RESULT, offerId, reason: "This run has no dialogue offer context." };
  const reject = (reason: string): OfferReplyResult => ({ ok: false, kind: DIALOGUE_OFFER_RESULT, offerId, reason });
  const parsed = dialogueSemanticEventSchema.safeParse(input.event);
  if (!parsed.success) return reject("event must be a valid dialogue semantic event.");
  const stage = input.stage === "checkpoint" || input.stage === "final" ? input.stage : undefined;
  const priorCheckpoints = precedingCheckpoints(messages, context.workId, context.parentRunId);
  const publicSeq = offerPublicSeq(messages, toolCallId);
  return startDialogueOffer({
    context, offerId, publicSeq, text: "", event: parsed.data,
    ...(stage ? { stage } : {}),
    priorCheckpoints,
    ...(input.workUpdate ? { workUpdate: input.workUpdate } : {}),
  });
}

function workUpdateResult(result: OfferReplyResult, updateId: string): WorkUpdateResult {
  if (!result.ok) return { ok: false, kind: "work-update", updateId, reason: result.reason };
  return { ok: true, kind: "work-update", updateId, sourceInputId: result.sourceInputId,
    ...(result.runId !== result.parentRunId ? { runId: result.runId } : {}),
  };
}

function validRelation(relation?: WorkRelation): boolean {
  return !relation || (WORK_RELATIONS as readonly string[]).includes(relation);
}

function validResponseMode(mode?: WorkResponseMode): boolean {
  return !mode || (WORK_RESPONSE_MODES as readonly string[]).includes(mode);
}

/** Work-only progress: no public reply is generated by the thinking role. */
export async function workCheckpointExecute(
  input: { text: string; relation?: WorkRelation; dependsOnInputIds?: string[] },
  opts: ExecuteOpts<ToolContext>,
  parentWritable?: DialogueParentWritable,
): Promise<WorkUpdateResult> {
  "use step";
  const updateId = dialogueOfferId(opts.context.dialogueOffer?.workId ?? opts.context.turnId, opts.toolCallId);
  if (!validRelation(input.relation)) return { ok: false, kind: "work-update", updateId, reason: "Invalid work relation." };
  return workUpdateResult(await offerReplyExecute({
    stage: "checkpoint", text: input.text,
    workUpdate: {
      ...(input.relation ? { relation: input.relation } : {}),
      ...(input.dependsOnInputIds?.length ? { dependsOnInputIds: input.dependsOnInputIds } : {}),
    },
  }, opts, parentWritable), updateId);
}

/** Complete a work item, including any native artifacts, without public wording. */
export async function completeWorkExecute(
  input: { result: string; relation?: WorkRelation; dependsOnInputIds?: string[]; responseMode?: WorkResponseMode },
  opts: ExecuteOpts<ToolContext>,
): Promise<WorkUpdateResult> {
  "use step";
  const updateId = dialogueOfferId(opts.context.dialogueOffer?.workId ?? opts.context.turnId, opts.toolCallId);
  if (!validRelation(input.relation)) return { ok: false, kind: "work-update", updateId, reason: "Invalid work relation." };
  if (!validResponseMode(input.responseMode)) return { ok: false, kind: "work-update", updateId, reason: "Invalid response mode." };
  return workUpdateResult(await offerReplyExecute({
    stage: "final", text: input.result,
    workUpdate: {
      responseMode: input.responseMode ?? "focused",
      ...(input.relation ? { relation: input.relation } : {}),
      ...(input.dependsOnInputIds?.length ? { dependsOnInputIds: input.dependsOnInputIds } : {}),
    },
  }, opts), updateId);
}

/** Host-owned structured result or blocker, also using the work-only contract. */
export async function completeWorkEventExecute(
  input: { event: DialogueSemanticEvent; relation?: WorkRelation; dependsOnInputIds?: string[]; responseMode?: WorkResponseMode },
  opts: ExecuteOpts<ToolContext>,
): Promise<WorkUpdateResult> {
  "use step";
  const updateId = dialogueOfferId(opts.context.dialogueOffer?.workId ?? opts.context.turnId, opts.toolCallId);
  if (!validRelation(input.relation)) return { ok: false, kind: "work-update", updateId, reason: "Invalid work relation." };
  if (!validResponseMode(input.responseMode)) return { ok: false, kind: "work-update", updateId, reason: "Invalid response mode." };
  return workUpdateResult(await offerDialogueEventExecute({
    event: input.event, stage: "final",
    workUpdate: {
      ...(input.responseMode ? { responseMode: input.responseMode } : {}),
      ...(input.relation ? { relation: input.relation } : {}),
      ...(input.dependsOnInputIds?.length ? { dependsOnInputIds: input.dependsOnInputIds } : {}),
    },
  }, opts), updateId);
}

/** Read-only Workflow snapshot. No memory file or client cache is involved. */
export async function readWorkSnapshotExecute(
  input: { workId: string },
  { context: ctx }: ExecuteOpts<ToolContext>,
): Promise<{ snapshot: WorkSnapshot | null }> {
  "use step";
  const scope = ctx.dialogueOffer?.scopeKey;
  if (!scope || !input.workId.trim()) return { snapshot: null };
  const { readWorkSnapshotStep } = await import("../chat/dialogue-orchestrator-steps");
  return { snapshot: await readWorkSnapshotStep(scope, input.workId) };
}
// ─── startLongTask — the conversation's sub-stream, dispatched on the spot ──

export type StartLongTaskResult =
  | { ok: true; runId: string; taskRef: string }
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
  input: { task: string; note?: string; evidenceQuote?: string },
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
  const registered = await registerLongTaskCommitment(ctx, toolCallId, task, input.evidenceQuote);
  if (!registered.ok) return registered;

  const posted = await appendDocMarker(ctx, {
    v: 1,
    id: `${ctx.sliceId}-${toolCallId}`,
    kind: "question",
    title: task,
    note: input.note?.trim() ?? "",
    target: registered.taskRef,
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
    return { ok: true, runId: run.runId, taskRef: registered.taskRef };
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

/** A direct search returns the provider's source list to the thinking agent. */
function webToolError(name: string, error: unknown): string {
  // The HTTP client has already retried explicit upstream failures. Returning
  // tool data keeps sibling evidence and lets the model decide what to do next.
  if (isTransientError(error) || (error instanceof TypeError && /fetch failed/i.test(error.message))) {
    return `[${name} unavailable] The upstream request failed: ${error instanceof Error ? error.message : String(error)}. You can retry or proceed with other evidence.`;
  }
  return triageErrorMessage(error, name);
}

export async function searchWebSourcesExecute(input: { query: string; count?: number }, { abortSignal }: ExecuteOpts<ToolContext>) {
  "use step";
  try {
    return await deepseekWebSearch(input, abortSignal);
  } catch (error) {
    abortSignal?.throwIfAborted();
    return { error: webToolError("webSearch", error) };
  }
}

/** Keep the durable executor identity for in-flight and pre-upgrade research. */
export async function webSearchExecute(
  { query, mode }: { query: string; mode?: "standard" | "scout" },
  { toolCallId, context: ctx, abortSignal }: ExecuteOpts<ToolContext>,
): Promise<WebSearchResult | { error: string }> {
  "use step";
  if (!hasDeepSeekCredential()) return { error: "Web research requires a DeepSeek API key." };
  await emitToolProgress(toolCallId, "webResearch", "Researching sources…", "running");
  try {
    const result = await searchViaFlash(query, { toolCallId, toolName: "webResearch" }, {
      scout: mode === "scout", sessionId: ctx.sliceId, abortSignal,
    });
    await emitToolProgress(toolCallId, "webResearch", `Found ${result.sources.length} sources`, "done");
    return result;
  } catch (error) {
    abortSignal?.throwIfAborted();
    return { error: webToolError("webResearch", error) };
  }
}

export async function webFetchExecute(input: WebFetchInput, { abortSignal }: ExecuteOpts<ToolContext>): Promise<string> {
  "use step";
  try {
    return await deepseekWebFetch(input, abortSignal);
  } catch (error) {
    abortSignal?.throwIfAborted();
    return `ERROR: ${webToolError("webFetch", error)}`;
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
    // A case attachment (v0.19 §C.1): doc:<category>/<case>/<attachment> — the
    // unit identity a document cites. Bytes come back through the binary
    // read path; a dead name is a visible error, never a throw.
    const refText = source.slice("doc:".length);
    const segments = refText.split("/");
    const category = segments[0] ?? "";
    const caseName = segments[1] ?? "";
    const fileName = segments.slice(2).join("/");
    if (segments.length !== 3 || !caseName || !fileName) {
      return `ERROR: Invalid doc attachment source "${source}". Expected "doc:<category>/<case>/<attachment>", e.g. "doc:research/phone-survey/2026-09-05-photo.jpg".`;
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
    sessionId: ctx.sliceId,
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

// ── currentTime — the "watch check" for a precise now ────────────────────

/**
 * currentTime — a fresh clock read. The system prompt's slice-head snapshot is
 * frozen at the slice's start (prefix-cache freeze), so it can be tens of
 * minutes old mid-slice; this tool is the model's way to ask "what time is it
 * REALLY now". Zero-input, read-only, and byte-stable per call — it appends to
 * the message tail, so it never breaks the prefix cache.
 *
 * Returns rich text: the user's local time + UTC, this slice's
 * start / elapsed / remaining-to-cap (the start instant is parsed from the
 * slice id itself — YYYY-MM-DD-HHMM is a UTC label; the cap is read from the
 * user config, falling back to the shipped default when unreadable), and a
 * refreshed date-anchor table. The turn count is deliberately omitted:
 * deriving it would require reading the slice file, which is not worth the
 * I/O for a clock check.
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
  const view = ctx.view;
  const sid = sliceId ?? view?.sliceId ?? ctx.sliceId;
  if (!parseSliceId(sid)) {
    return "ERROR: Invalid slice ID. Expected format: YYYY-MM-DD-HHMM (e.g. 2026-07-24-1500).";
  }
  const frozen =
    view?.sliceId === sid && view.snapshot?.sliceId === sid
      ? view.snapshot
      : undefined;
  const desc = describeRoom(
    sid,
    frozen
      ? frozen.generatorVersion === 2
        ? { generatorVersion: 2, profile: frozen.profile, timezone: frozen.timezone }
        : {
            generatorVersion: 1,
            profile: frozen.profile,
            strandDoors: frozen.roomDoorCount,
            corridorSide: frozen.corridorSide,
          }
      : {
          generatorVersion: 2,
          ...(ctx.timezone ? { timezone: ctx.timezone } : {}),
          ...(strandDoors !== undefined ? { strandDoors } : {}),
          ...(corridorSide ? { corridorSide } : {}),
        },
  );
  const rendered = formatRoomDescription(desc, ctx.locale === "zh" ? "zh" : "en");
  const generatedAtmosphereNote =
    ctx.locale === "zh"
      ? "日期与天气氛围仅是固定房间生成器的视觉装饰，不是真实天气或现场观测。"
      : "Date and weather atmosphere are decorative fixed-room visuals, not real weather or a live observation.";
  if (frozen) return frozen.generatorVersion === 2
    ? `${rendered}\n\n${generatedAtmosphereNote}`
    : rendered;
  const baseNote =
    ctx.locale === "zh"
      ? "固定房间说明：以上使用当前固定房间生成器；没有读取该记录原文或语义 profile，也没有借用其他房间的冻结快照。"
      : "Fixed room only: this uses the current fixed-room generator. No record text or semantic profile was read, and no other room's frozen snapshot was borrowed.";
  return `${rendered}\n\n${baseNote}\n${generatedAtmosphereNote}`;
}

export type SelectSkillResult =
  | {
      status: "selected";
      id: string;
      instruction: string;
      applicability: string;
      source: { ref: string; content: string; revision: string };
      reviewNeeded: boolean;
    }
  | { status: "error"; reason: string };

export async function selectSkillExecute(
  input: { id: string },
  _options: ExecuteOpts<ToolContext>,
): Promise<SelectSkillResult> {
  "use step";
  const state = await readSkillLedger();
  if (state.status === "corrupt" || state.status === "unavailable") {
    return { status: "error", reason: state.diagnostic };
  }
  const entry = state.ledger.entries.find((item) =>
    item.id === input.id && item.state === "adopted" && item.role === "main"
  );
  if (!entry) {
    return { status: "error", reason: `No adopted main skill named ${input.id}` };
  }
  const source = await readSkillSource(entry.ref);
  if (source.status !== "ok") {
    return {
      status: "error",
      reason: source.status === "missing"
        ? `Skill source is missing: ${entry.ref}`
        : source.diagnostic,
    };
  }
  return {
    status: "selected",
    id: entry.id,
    instruction: entry.instruction,
    applicability: entry.applicability,
    source: { ref: entry.ref, content: source.content ?? "", revision: source.revision },
    reviewNeeded: entry.reviewNeeded || source.revision !== entry.acknowledgedSourceRevision,
  };
}

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
  { question }: {
    question: string;
    },
  { context: ctx, toolCallId, abortSignal }: ExecuteOpts<ToolContext>,
): Promise<ThinkDeepFragmentResult> {
  "use step";

  if (!isAIConfigured()) {
    return {
      question,
      ok: false,
      status: "error",
      error:
        "AI is not configured (no API key). Configure DeepSeek BYOK or DEEPSEEK_API_KEY.",
    };
  }

  // The turn's main model flows through the tools context (shared with the
  // main agent — no per-call config resolution / GitHub round-trip). Falls
  // back to resolving it only when the context lacks it.
  const modelConfig = ctx.mainModel ?? (await resolveMainModelFromConfig());

  // Single fragment (index 0 of 1) → streams WITHOUT the [i/N] prefix.
  return runThinkDeepFragment(
    { question },
    0,
    1,
    {
      modelConfig,
      baseSystemPrompt: ctx.baseSystemPrompt,
      sessionId: ctx.sliceId,
      toolCallId,
      abortSignal,
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
    sessionId: string;
    toolCallId: string;
    abortSignal?: AbortSignal;
  },
): Promise<ThinkDeepFragmentResult> {
  const { question } = fragment;
  const { modelConfig, baseSystemPrompt, toolCallId } = opts;

  const prefix = total > 1 ? `[${index + 1}/${total}] ` : "";

  // Thinking is always requested for a reasoning fragment; the injector owns
  // the provider-specific effort mapping.

  const [sop, skillState] = await Promise.all([
    readSelfSopSnapshot("thinkdeep", undefined, { fresh: false }).catch(() => null),
    readSkillLedger().catch(() => null),
  ]);
  const guidance = renderRoleSkillGuidance({
    role: "thinkdeep",
    hostReservedChars: 2,
    ledger: skillState?.status === "ok" ? skillState.ledger : null,
    legacySop: sop?.content?.trim()
      ? {
          content: sop.content,
          ref: sop.origin === "legacy" ? "agent-playbooks/thinkdeep.md" : "self/thinkdeep/index.md",
        }
      : null,
    stateDiagnostic: skillState?.status === "corrupt"
      ? "Skill ledger is corrupt; adopted skills were not injected and the ledger was not reset."
      : skillState?.status === "unavailable"
        ? "Skill ledger is unavailable; adopted skills were not injected."
        : undefined,
  });
  const inherited = replaceMainCraftBlock(baseSystemPrompt, "");
  const baseSystem = buildSubAgentSystemPrompt(inherited);
  const system = guidance.text ? `${baseSystem}\n\n${guidance.text}` : baseSystem;
  const dateAnchor = new Date().toISOString().slice(0, 10);

  const userPrompt = [
    `Today is ${dateAnchor}.`,
    "",
    "# Reasoning fragment",
    "",
    "Reason through the sub-question to a clear conclusion and explain what supports it.",
    "",
    `Sub-question: ${question.trim()}`,
    "",
    "You have no tools and no search. Reason with what is given; state plainly",
    "anything you lack.",
  ]
    .filter(Boolean)
    .join("\n");

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

  const releaseProgress = () => {
    try { flushProgress(); } finally { progressWriter?.releaseLock(); }
  };
  try {
    const stream = await streamText({
      role: "think",
      sessionId: opts.sessionId,
      system,
      prompt: userPrompt,
      thinking: true,
      abortSignal: opts.abortSignal,
      onChunk({ chunk }) {
        if (chunk.type === "text-delta") {
          answer += (chunk.text ?? chunk.delta ?? "");
          // Stream the live reasoning/answer line to the client.
          writeProgress();
        } else if (chunk.type === "reasoning-delta") {
          reasoning += (chunk.text ?? chunk.delta ?? "");
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
    const finalAnswer = await stream.text;
    return {
      question,
      ok: true,
      status: "completed",
      answer: finalAnswer,
      reasoning,
    };
  } catch (err) {
    opts.abortSignal?.throwIfAborted();
    return {
      question,
      ok: false,
      status: "error",
      error: err instanceof Error ? err.message : "Sub-agent failed",
      answer,
      reasoning,
    };
  } finally {
    releaseProgress();
  }
}

