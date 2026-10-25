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
import { start } from "workflow/api";
// Side effect: keep the step-bundle copy of StepBoundaryLanguageModel
// evaluated in the step runtime so the Workflow 5 SWC plugin's inlined
// serialization-class registration for it runs before any doStreamStep
// message is handled (see src/lib/models/step-boundary-model.ts).

import { readFile, readFileViaTree, getRepoTree } from "@/lib/tools/readFile";
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
import { replaceMainCraftBlock } from "@/lib/chat/craft-prompt";
import {
  readSkillLedger,
  readSkillSource,
} from "@/lib/evolution/skill-store";
import { renderRoleSkillGuidance } from "@/lib/evolution/skill-policy";

import { readCaseAttachment } from "@/lib/tools/attachments";
import {
  normalizeCaseRefText,
  caseIndexPath,
  isValidCaseName,
  sanitizeCaseSegment,
  isCaseCategory,
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
  type RecallReadRange,
} from "@/lib/memory/facade";
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
import { slicePartPathCandidates } from "@/lib/episodic";
import { buildDateAnchors } from "@/lib/time/relative";
import { formatLocalTime } from "@/lib/turn-priming";
import { loadUserConfig } from "@/lib/config/loader";
import { DEFAULTS } from "@/lib/config/defaults";
import {
  splitParagraphs,
  segmentSearch,
  textLines,
  searchResultToString,
} from "@/lib/retrieval/doc-segments";

import { resolveMainModelFromConfig } from "@/lib/models/resolve";
import { resolveSubAgentModel } from "@/lib/agents/sub-agent-runner";
import type { ModelConfig } from "@/lib/models/registry";
import { withStepTimeout } from "@/lib/chat/step-timeout";
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

/**
 * Backend-dispatched raw read (demo / GitHub / local) — the dispatch the
 * facade backend below shares.
 *
 * GitHub historical reads go through the content-addressed tree + blob layer
 * (`readFileViaTree`): the path's sha comes from the cached tree, the bytes
 * from the permanent blob cache, so a recall scan over N slice files costs
 * zero per-file API calls on a warm instance instead of N direct reads. The
 * recall surface only ever reads history (committed slices), so staleness is
 * bounded by the tree TTL; `opts.fresh` keeps the direct per-file read for a
 * caller that must see the bytes on the other side NOW.
 */
async function readRawBackend(
  ctx: ToolContext,
  path: string,
  opts?: { fresh?: boolean },
): Promise<string> {
  if (ctx.useDemo) return readFileDemo(path);
  if (ctx.useGithub) {
    // The recall surface only reads history (committed slices), so the tree's
    // TTL is the only staleness bound — `fresh` stays available for a caller
    // that must see the bytes on the other side of a write.
    return opts?.fresh
      ? readFile(path, ctx.repo, ctx.owner, opts)
      : readFileViaTree(path, ctx.repo, ctx.owner, opts);
  }
  return readFileLocal(path);
}


// ─── The memory-read facade executors (v0.36) ─────────────────────────────
//
// The field agent's read surface is FOUR verbs over one entry shape and one
// result envelope (see src/lib/memory/facade.ts): recallRecent / recallFind /
// recallSearch return ENTRIES (ref/title/date/excerpt), never files; recallRead
// continues reading through an entry's ref. The model never sees the tree.
// These executors are thin wrappers: they build a backend from the tool
// context (demo / GitHub / local), call the facade, and render the result with
// the FIXED per-kind templates (v0.36 §3.2).

/** Build the facade's read backend from the tool context's storage flags. */
function createRecallBackend(ctx: ToolContext): RecallBackend {
  const readFile = (path: string): Promise<string> => readRawBackend(ctx, path);
  return {
    readFile,
    listMemoryFiles: async (): Promise<string[]> => {
      if (ctx.useGithub) {
        const tree = await getRepoTree(ctx.repo, ctx.owner);
        if (!tree.truncated) {
          // The cached memory/ tree: within the TTL this costs zero API calls.
          return tree.entries
            .filter((e) => e.type === "blob" && e.path.startsWith("memory/"))
            .map((e) => e.path);
        }
        // A truncated listing cannot truthfully answer "what exists" — fall
        // back to the per-directory walk (completeness outranks burst).
      }
      const listDir = (path: string) =>
        ctx.useDemo
          ? listFilesDemo(path)
          : ctx.useGithub
            ? listFiles(path, ctx.repo, ctx.owner)
            : listFilesLocal(path);
      const paths: string[] = [];
      const walk = async (dir: string): Promise<void> => {
        let entries: Array<{ name: string; type: string }>;
        try {
          entries = await listDir(dir);
        } catch {
          return; // missing dir — a fresh memory root, fine
        }
        for (const e of entries) {
          const p = `${dir}/${e.name}`;
          if (e.type === "dir") await walk(p);
          else if (p.startsWith("memory/")) paths.push(p);
        }
      };
      await walk("memory");
      return paths;
    },
  };
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
  return renderRecallResult(result, { ...(category ? { category } : {}) });
}

export async function recallFindExecute(
  input: { category: string; name: string },
  { context: ctx }: ExecuteOpts<ToolContext>,
): Promise<string> {
  "use step";
  const rawCategory = input.category?.trim();
  if (!rawCategory || !isRecallCategory(rawCategory)) {
    return renderRecallResult(
      { kind: "unavailable", note: `unknown category ${JSON.stringify(input.category)}` },
      {},
    );
  }
  const category: RecallCategory = rawCategory;
  const name = input.name?.trim();
  if (!name) {
    return renderRecallResult(
      { kind: "unavailable", note: "name must not be empty" },
      { category },
    );
  }
  const result = await recallFind(createRecallBackend(ctx), { category, name });
  return renderRecallResult(result, { category, name });
}

export async function recallSearchExecute(
  input: {
    query: string | string[];
    category?: string;
    includeRecords?: boolean;
    since?: string;
    until?: string;
    limit?: number;
    offset?: number;
  },
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
  const keywords = (Array.isArray(input.query) ? input.query : [input.query])
    .map((q) => q?.trim() ?? "")
    .filter((q) => q.length > 0);
  if (keywords.length === 0) {
    return renderRecallResult({ kind: "unavailable", note: "query must not be empty" }, {});
  }
  const result = await recallSearch(createRecallBackend(ctx), {
    query: keywords,
    ...(category ? { category } : {}),
    ...(input.includeRecords !== undefined ? { includeRecords: input.includeRecords } : {}),
    ...(input.since ? { since: input.since } : {}),
    ...(input.until ? { until: input.until } : {}),
    ...(input.limit !== undefined ? { limit: input.limit } : {}),
    ...(input.offset !== undefined ? { offset: input.offset } : {}),
  });
  return renderRecallResult(result, {
    query: keywords.join(" "),
    ...(category ? { category } : {}),
    ...(input.limit !== undefined ? { limit: input.limit } : {}),
  });
}

/**
 * recallRead — continue reading through an entry's ref. Also the carrier of
 * the doc_rework probe (design v0.15 §4.4): a successful case read records
 * the document + the slice ids its text references (recordDocRead); a
 * successful slice read then classifies against it, logging an audit line on
 * the current slice's agent.md when the document was not credited for the
 * fact it carried. Best-effort, never fails the read.
 */
export async function recallReadExecute(
  input: {
    ref: string;
    part?: "core" | "agent" | "previously";
    range?: RecallReadRange;
    outline?: boolean;
  },
  { context: ctx, toolCallId }: ExecuteOpts<ToolContext>,
): Promise<string> {
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
  const result = await recallRead(createRecallBackend(ctx), {
    ref,
    ...(input.part ? { part: input.part } : {}),
    ...(input.range ? { range: input.range } : {}),
    ...(input.outline ? { outline: true } : {}),
    ...(ctx.timezone ? { timezone: ctx.timezone } : {}),
  });

  if (result.kind === "content") {
    const recordsMatch = /^records\/(\d{4}-\d{2}-\d{2}-\d{4})$/.exec(normalizeCaseRefText(ref));
    if (recordsMatch && (!input.part || input.part === "core")) {
      const sliceId = recordsMatch[1]!;
      const docReworkFile = checkDocRework(ctx.sliceId, sliceId);
      if (docReworkFile) {
        await logDocReworkSignal(ctx.sliceId, sliceId, docReworkFile);
      }
    } else if (!recordsMatch && result.path.startsWith("memory/")) {
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
          rendered: renderRecallReadResult(result, ref),
        });
      } catch (error) {
        return renderRecallReadResult({
          kind: "unavailable",
          note: error instanceof Error ? error.message : String(error),
        }, ref);
      }
    }
  }
  return renderRecallReadResult(result, ref);
}

// ─── recallSince — the differential view (v0.11) ──────────────────────────
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
  input: { category?: string; caseName: string; body: string; pieceTitle?: string },
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
  if (category === "people" && caseName === "user") {
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
      const applied = await applyCaseWriteIntent(
        { action: "open", category, caseName, body },
        date,
        batch,
      );
      // A pieceTitle on the OPEN call adds the first piece in the SAME call:
      // the queued open is read back by the addPiece intent (batch
      // read-your-writes) and both files ride the call's single commit.
      if (!pieceTitle) {
        return { ok: true, action: "open", path: applied.path };
      }
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
    return { ok: true, action: "addPiece", path: applied.path };
  } catch (e) {
    return { ok: false, reason: `addPiece refused: ${e instanceof Error ? e.message : String(e)}` };
  }
  })();
  if (result.ok) {
    await flushBatch(batch, `writeCase ${category}/${caseName}`);
  }
  return result;
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
  if (!isAIConfigured()) {
    return {
      error:
        "Web search requires a DeepSeek API key. Configure DeepSeek BYOK in client settings or DEEPSEEK_API_KEY on the server.",
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
 * The web complement of recallRead: the main agent points at one item (a URL
 * instead of a memory ref) and gets its raw content back for the model to
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
      ? {
          profile: frozen.profile,
          strandDoors: frozen.roomDoorCount,
          corridorSide: frozen.corridorSide,
        }
      : view
        ? {}
        : {
            ...(strandDoors !== undefined ? { strandDoors } : {}),
            ...(corridorSide ? { corridorSide } : {}),
          },
  );
  const rendered = formatRoomDescription(desc, ctx.locale === "zh" ? "zh" : "en");
  if (frozen) return rendered;
  const baseNote =
    ctx.locale === "zh"
      ? "基础空间说明：以上仅使用现有基础编译；没有读取该记录原文或语义 profile，也没有借用其他房间的冻结快照。"
      : "Base space only: this is the existing basic compilation. No record text or semantic profile was read, and no other room's frozen snapshot was borrowed.";
  return `${rendered}\n\n${baseNote}`;
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

/** Guidance the main agent reads when a reasoning fragment is interrupted. */
const SUB_AGENT_TIMEOUT_NOTE =
  "The reasoning fragment was interrupted before finishing. The `answer` holds " +
  "the partial conclusion and `reasoning` the thinking trail it already produced " +
  "— work with them (noting the uncertainty). If you need more, gather the " +
  "missing information yourself (webSearch / recallSearch / recallRead), embed it, and dispatch a " +
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
  { context: ctx, toolCallId }: ExecuteOpts<ToolContext>,
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

  // Step start — the fragment's adaptive SDK timeout is measured from here so
  // the step returns around STEP_TOTAL_MS no matter how long setup took.
  const stepStartMs = Date.now();

  // Single fragment (index 0 of 1) → streams WITHOUT the [i/N] prefix.
  return runThinkDeepFragment(
    { question },
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
  const { question } = fragment;
  const { modelConfig, baseSystemPrompt, toolCallId, stepStartMs } = opts;

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
            role: "think",
            system,
            prompt: userPrompt,
            thinking: true,
            // The SDK timeout hook — aborts the stream cleanly at the deadline.
            timeout: streamTimeoutMs,
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

