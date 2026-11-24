import { DOCUMENT_BUDGET_RULE } from "@/lib/docs/write-limits";
/**
 * Shared tool definitions for the WorkflowAgent — the chat agent binds its
 * tool set here.
 *
 * Each tool couples an inputSchema (what the model provides), a contextSchema
 * (what the workflow provides via `toolsContext`), and a standalone
 * `"use step"` executor from ./tool-executors — so every tool call is an
 * individually durable, auto-retried workflow step.
 *
 * Tools use public memory references. The directory tools list or match
 * those references; each content reader owns its storage paths.
 */

import { renderSemanticDocumentRead, renderVerifiedSearchPassages } from "@/lib/agents/thinking-read-receipt";
import { tool } from "@/lib/deepseek/tools";
import { z } from "zod";
import type { DialogueOfferContext } from "@/lib/dialogue/transport";
import { WORK_RESPONSE_MODES } from "@/lib/dialogue/work-contract";

import { DOC_HOUSE_STYLE, DOC_LANGUAGE_RULE } from "@/lib/agents/doc-style";
import { currentViewSchema } from "@/lib/chat/current-view";
import { ROOM_SNAPSHOT_MAX_DOOR_COUNT } from "@/lib/game/room-snapshot";
import { RECALL_CATEGORIES } from "@/lib/memory/categories";
import { recallSearchQuerySchema } from "@/lib/memory/search-query";
import { recallListInputSchema, recallPathFindInputSchema } from "@/lib/memory/navigation";
// Direct module path, not the "@/lib/docs" barrel: this file is reachable
// from the "use workflow" bundle, and the barrel re-exports case-doc.ts
// (gray-matter → node:*), which the workflow bundler rejects.
import {
  DOC_WRITE_WINDOW_RULE,
  MEMORY_IS_GIT_RULE,
} from "@/lib/docs/write-window";
import {
  recallRecentExecute,
  recallListExecute,
  recallFindExecute,
  recallSearchExecute,
  recallReadExecute,
  recallScenarioExecute,
  recallSinceExecute,
  webSearchExecute,
  webFetchExecute,
  thinkDeepExecute,
  currentTimeExecute,
  describeRoomExecute,
  viewImageExecute,
  writeCaseExecute,
  archiveCaseExecute,
  startLongTaskExecute,
  workCheckpointExecute,
  completeWorkExecute,
  readWorkSnapshotExecute,
  noteForSedimentExecute,
  queryTasksExecute,
  createTaskExecute,
  updateTaskExecute,
  reportTaskFollowupExecute,
  selectSkillExecute,
  type ToolContext,
} from "./tool-executors";
import {
  queryTasksToolSchema,
} from "@/lib/tasks/contracts";
import { fieldCreateTaskSchema, fieldUpdateTaskSchema } from "@/lib/chat/task-input";
import { reportTaskFollowupInputSchema } from "@/lib/chat/task-followups";
import { scenarioRecallRequestSchema } from "@/lib/chat/scenario-recall-contract";

// ─── Context schemas ─────────────────────────────────────────────────────

/** Structural ModelConfig schema for the serializable tool context — mirrors
 *  src/lib/models/registry.ts so provider configs survive the workflow
 *  boundary. Used by mainModel (the turn's resolved main agent, which all
 *  sub-agents run on since the v0.9 unified runner). */
const modelConfigSchema = z.object({
  id: z.string(),
  name: z.string(),
  provider: z.string(),
  providerName: z.string(),
  sdk: z.literal("deepseek"),
  envKey: z.string(),
  baseURL: z.string().optional(),
  capabilities: z.object({
    thinking: z.boolean(),
    vision: z.boolean(),
    maxTokens: z.number(),
  }),
  defaultThinking: z.boolean(),
  defaultEffort: z.enum(["low", "medium", "high"]),
});

/**
 * The serializable per-turn tool context. EVERY ToolContext field must be
 * declared here: the workflow step boundary re-parses each tool's context
 * entry through this schema and zod strips undeclared keys — an undeclared
 * field silently never reaches the executor (timezone once fell off this
 * way, and every read tool rendered UTC).
 * Exported for the round-trip regression test.
 */
export const toolContextSchema = z.object({
  repo: z.string(),
  owner: z.string(),
  useGithub: z.boolean(),
  useDemo: z.boolean(),
  sliceId: z.string(),
  turnId: z.string().min(1),
  readScopeId: z.string().min(1),
  currentUserText: z.string(),
  // Server-owned Workflow offer context. Opaque here to preserve the complete nested payload.
  dialogueOffer: z.custom<DialogueOfferContext>((value) => !!value && typeof value === "object", "Invalid dialogue offer context").optional(),
  // Sanitized visual context only. Its nested schemas are strict, so a malformed
  // snapshot is rejected rather than stripped into an apparently valid view.
  view: currentViewSchema.optional(),
  recentTurns: z.array(z.object({
    role: z.string(),
    content: z.string(),
  })),
  // The turn's assembled system prompt, fanned out to thinkDeep so sub-agents
  // share the exact same prefix as the main agent — prompt-cache hits across
  // main + sub-agent calls within one turn.
  baseSystemPrompt: z.string().optional(),
  // The turn's resolved MAIN model — the sub-agents that run on the chat
  // model (thinkDeep) use it directly (the same one injected for the main
  // agent) instead of re-resolving config from GitHub on every fragment step.
  // webSearch is the exception: a DeepSeek-only infrastructure call
  // (tool-executors webSearchExecute), independent of mainModel.
  mainModel: modelConfigSchema.optional(),
  // User-local time rendering (time-localize.ts / the currentTime executor).
  // These MUST be declared here: the workflow step boundary re-parses the
  // context through this schema and zod strips undeclared keys — without
  // them the executors see `timezone: undefined` and fall back to UTC.
  /** The user's IANA timezone (e.g. "Asia/Shanghai"). */
  timezone: z.string().optional(),
  /** The turn's start instant (UTC ISO) — anchors local-time rendering. */
  startedAtIso: z.string().optional(),
  /** Only the host enables read receipts for a 思考流 work. */
  thinkingFlow: z.boolean().optional(),
  /** UI locale ("zh" | "en") — relative-time annotations follow it. */
  locale: z.string().optional(),
  /** Image attachments (data URLs) extracted when the main model lacks vision. */
  imageAttachments: z.array(z.string()).optional(),
});

// ─── The memory-read verbs (v0.36) + the rest of the chat tool set ─────────
//
// The reply segment's read surface is FOUR verbs sharing one entry shape and
// one result envelope (src/lib/memory/facade.ts). The agent sees entries —
// ref / title / date / excerpt — never the tree, never raw listings.
export const chatTools = {
  recallScenario: tool({
    description:
      "Recover original conversation evidence for a specific gap in the case account, exact words, disputed attribution, or proof of a commitment. Read the case passage first when its content will determine whether recollection is needed. " +
      "Give a focused question. Pass cardTargets as targets to read exact messages directly. With recordLeads, pass up to four refs plus literal searchTerms to find matching user excerpts. Otherwise the recall agent can locate and read records. " +
      "Only the verified excerpts establish original wording and roles. Use the turn's localTimestamp for the user's local date and time when available. A record ref identifies a UTC slice and does not specify the turn's local clock. The narrative and notes are interpretations. If missing coverage could change the answer, nextCursor resumes the same question and window. A miss does not establish absence. Recollection grants no write authority or task evidence.",
    inputSchema: scenarioRecallRequestSchema,
    contextSchema: toolContextSchema,
    execute: recallScenarioExecute,
  }),
  // ① What has been happening — the recent-N view. Omitting `category` gives
  // one cross-category timeline (the "I can't recall which world it lives
  // in" answer); a category narrows to one world.
  recallRecent: tool({
    description:
      "Browse recent activity, newest first. Omit category for a cross-category timeline or restrict it to a category. Record heads are navigation metadata. Semantic entries include excerpts. " +
      "Use an offset or date bounds for older entries when the question calls for them. An empty page describes only its scope.",
    inputSchema: z.object({
      category: z
        .enum(RECALL_CATEGORIES)
        .optional()
        .describe(
          "One world to look inside. Omit for the cross-category timeline " +
          "(use when you cannot tell which category something lives in).",
        ),
      n: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("How many entries (default 10, hard cap 30)."),
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe(
          "Skip the newest `offset` entries and return the next page " +
          "(default 0). Use the returned offset if older entries matter.",
        ),
      after: z
        .string()
        .optional()
        .describe("Inclusive lower day bound, YYYY-MM-DD (user calendar)."),
      before: z
        .string()
        .optional()
        .describe("Inclusive upper day bound, YYYY-MM-DD (user calendar)."),
    }),
    contextSchema: toolContextSchema,
    execute: recallRecentExecute,
  }),
  recallList: tool({
    description:
      "Browse the public memory directory. Omit path to list the categories, pass a category such as 'people' to list its case directories, or pass a case path to list its immediate documents. " +
      "Returns one page of navigation entries and nextOffset when there is more. It reads no document text. Use recallRead on a returned ref to read a document; storage paths are not accepted.",
    inputSchema: recallListInputSchema,
    contextSchema: toolContextSchema,
    execute: recallListExecute,
  }),
  // ② Locate named documents by their public directory paths.
  recallFind: tool({
    description:
      "Find an unfamiliar case or document by exact, included, normalized or near name. Omit category to search across categories, or restrict by category or directory. " +
      "Hits are navigation only. A known document ref can go straight to recallRead. For a known record ID use the records category, or pass the ref to recallScenario for original evidence.",
    inputSchema: recallPathFindInputSchema,
    contextSchema: toolContextSchema,
    execute: recallFindExecute,
  }),
  // ③ Keyword hunt — with the scan-surface discipline: organized layer
  // first, raw conversation only on explicit request.
  recallSearch: tool({
    description:
      "Search memory text by keyword. By default searches semantic documents, self documents, the user profile, and slice navigation heads. " +
      "Raw conversation is scanned only with category 'records' or includeRecords:true; the resulting record refs are navigation only. Use recallScenario to verify original words. " +
      "To find accounts of a conversation, set dateBasis to 'conversation' with since/until. This matches the local opening day of a cited slice, including in accounts filed later. Each call scans up to 50 candidates. Mixed searches scan and show semantic documents before record leads. Within each group, passages matching more keywords together rank higher on the page. " +
      "A thinking-read receipt may include up to two verified case passages. They can directly answer a factual question. A passage labeled 'complete body of this edition' already contains that document's body. Other editions, pieces and linked records have their own coverage. " +
      "If there is no text match in a page, the result may offer separately labeled related names or paths. Those are navigation leads, not content matches or evidence. " +
      "If another page could affect the answer or complete coverage is required, pass both continuation values. A partial scan leaves the rest unknown.",
    inputSchema: z.object({
      query: recallSearchQuerySchema
        .describe(
          "One keyword or up to eight (case-insensitive). Results favor passages matching more terms together.",
        ),
      category: z
        .enum(RECALL_CATEGORIES)
        .optional()
        .describe(
          "Scope the search to one world. Omit for all structured documents " +
          "(records excluded unless includeRecords).",
        ),
      includeRecords: z
        .boolean()
        .optional()
        .describe(
          "Also scan raw conversation bodies (default false — the " +
          "structured layer only).",
        ),
      dateBasis: z.enum(["activity", "conversation"]).optional().describe(
        "Use activity (default) for when documents were active. Conversation matches the user's local day when a cited slice opened. Turns can cross midnight; for a specific turn's date, check its original timestamp and include the preceding slice when needed.",
      ),
      turnLinks: z.enum(["user", "assistant", "both"]).optional().describe(
        "When the question asks for original wording, authorship or explicit agreement, request turn pointers for the relevant speaker. Links from matched documents identify candidates for recallScenario.targets. They do not establish what the linked turns say.",
      ),
      since: z
        .string()
        .optional()
        .describe("Inclusive lower day bound for the selected date basis, YYYY-MM-DD."),
      until: z
        .string()
        .optional()
        .describe("Inclusive upper day bound for the selected date basis, YYYY-MM-DD. For one day, use the same date as since."),
      limit: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Max hits per page (default 20, hard cap 30)."),
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe(
          "Skip hits within the current candidate page (default 0). Pass the returned nextOffset together with nextScanCursor.",
        ),
      scanCursor: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Candidate-page cursor from nextScanCursor; omit for the first 50 candidates. This is independent of hit offset."),
    }),
    contextSchema: toolContextSchema,
    execute: recallSearchExecute,
    toModelOutput: renderVerifiedSearchPassages,
  }),
  // ④ Continue reading — the "出处" verb: entries cite refs, refs read here.
  recallRead: tool({
    description:
      "Read a semantic document by ref for evidence missing from the conversation or search passages. Approximate names resolve with a matched-name note. " +
      "For a long document, outline returns headings and line spans for bounded reads. Optional relatedCases, cardTargets and recordLeads point to further evidence when a material question remains. " +
      "An original record ref normally returns recallScenario_required. For surrounding public conversation, direct: true returns original user and assistant messages from core. A failed read leaves the content unknown.",
    inputSchema: z.object({
      ref: z
        .string()
        .min(1)
        .describe(
          "The entry ref from any recall result — an approximate name " +
          "also resolves; the result tells you which stored name it matched.",
        ),
      part: z
        .enum(["core", "agent", "previously"])
        .optional()
        .describe(
          "Record part. Only core can be read with direct: true. Private agent and previously parts always redirect. Semantic documents do not use parts.",
        ),
      range: z
        .object({
          type: z
            .enum(["turns", "last", "date", "search", "lines"])
            .describe(
              "turns = specific turn indices. last = most recent N turns. " +
              "date = turns after a given timestamp. search = keyword match, " +
              "returns matching turns (+ context); a direct public read reports when none match. lines = 1-indexed line " +
              "range of the raw file.",
            ),
          indices: z
            .array(z.number())
            .optional()
            .describe("Turn indices (0-based). Only for type 'turns'."),
          count: z
            .number()
            .optional()
            .describe("Number of recent turns. Only for type 'last'."),
          after: z
            .string()
            .optional()
            .describe("ISO 8601 timestamp. Only for type 'date'."),
          keywords: z
            .array(z.string())
            .optional()
            .describe("Case-insensitive keywords to match. Only for type 'search'."),
          context: z
            .number()
            .optional()
            .describe("Turns of context around each match (default 1). Only for type 'search'."),
          start: z
            .number()
            .optional()
            .describe("First line (1-indexed, inclusive). Only for type 'lines'."),
          end: z
            .number()
            .optional()
            .describe("Last line (1-indexed, inclusive). Only for type 'lines'."),
        })
        .optional()
        .describe(
          "For semantic documents, 'lines' reads at most 400 lines/16000 chars. For direct record reads the range applies to the public conversation.",
        ),
      outline: z
        .boolean()
        .optional()
        .describe(
          "true = return the document's heading skeleton instead of its " +
          "body (levels + line spans, no prose). On a long " +
          "document you can request the relevant spans with " +
          'range: { type: "lines", start, end }.',
        ),
      includeHistory: z.boolean().optional().describe(
        "For a case index, include its earlier current-understanding revisions. Use when the user is reading the history edition or asks why an earlier interpretation changed. This directly reads stored prose; it does not call another model.",
      ),
      direct: z.boolean().optional().describe(
        "Original records only: read the public user and assistant messages in core, optionally by range, when surrounding original context matters.",
      ),
    }),
    contextSchema: toolContextSchema,
    execute: recallReadExecute,
    toModelOutput: renderSemanticDocumentRead,
  }),

  // ⑤ The differential view — "自某天以来变了什么" from the commit history
  // itself (the ledger IS the diff; no new storage). Use when the user asks
  // what CHANGED since a day or since a previous recallSince result.
  recallSince: tool({
    description:
      "See what CHANGED in memory over a window — the differential view the " +
      "commit history already carries, no new storage behind it. Use this " +
      "when the user asks '自某天以来变了什么' / 'what has changed since …' " +
      "instead of pulling a recent list and diffing snapshots yourself. " +
      "Give `since` (YYYY-MM-DD, user calendar, that day included) OR " +
      "`cursor` (a commit sha from a previous result's paging note — the " +
      "changes AFTER that commit); neither defaults to the last 1 day. " +
      "Every returned entry is a ref carrying its change (added / modified / removed) and date. " +
      "When details matter, semantic refs are readable with recallRead(ref) and record refs with recallScenario. " +
      "`limit` caps ENTRIES (default 20, hard cap 50), not commits; " +
      "`category` narrows to one world (records / events / …). The refs of " +
      "one conversation slice collapse into ONE records/<sliceId> entry no " +
      "matter how many of its files changed. FIXED result wording (recognize " +
      "it, do not paraphrase): a window opens `Changes since {since} " +
      "through {until} ({n} commits):` with lines `- [date] +|~|− ref — " +
      "added|modified|removed`; a genuinely empty window opens `No changes " +
      "since {since} through {until} — the commit history shows nothing in " +
      "this window.`; a capped page appends `Showing the newest {n} of " +
      "{total} changed entries — pass cursor={sha} for older ones.`; and a " +
      "TRUNCATED backend appends `This result is INCOMPLETE — the commit " +
      "history scan was truncated; more changes may exist beyond those " +
      "shown.` — an INCOMPLETE result is a PARTIAL truth, NEVER report it " +
      "as 'nothing changed'.",
    inputSchema: z.object({
      since: z
        .string()
        .optional()
        .describe(
          "Inclusive day bound, YYYY-MM-DD (user calendar) — changes from " +
          "that day onward. Omit when passing `cursor`.",
        ),
      cursor: z
        .string()
        .optional()
        .describe(
          "A commit sha from a previous result's paging note — the changes " +
          "AFTER that commit. Omit when passing `since`.",
        ),
      category: z
        .enum(RECALL_CATEGORIES)
        .optional()
        .describe("Narrow the diff to one world (same categories as recallRecent)."),
      limit: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Max changed entries (default 20, hard cap 50) — entries, not commits."),
    }),
    contextSchema: toolContextSchema,
    execute: recallSinceExecute,
  }),

  // The field agent's case write (v0.21 §2): open a case mid-reply so the
  // turn's document is written FIRST and the answer speaks FROM it. Every
  // category is writable but two — people/user and self/ are the reflection
  // unit's alone and are refused in the executor. Only open +
  // addPiece reach the shared case-write entry (per-case lock, fresh read in
  // lock). Nothing is stamped into the text — the case→slice link is semantic.
  writeCase: tool({
    description:
      "Write a case document — for ONE job: the user explicitly asks you to " +
      "document a subject. File an explicitly requested case note under its subject. " +
      "Use the task ledger for a requested future action; a personal preference goes to the user-model review. Nothing else earns " +
      "a write from you — the record carries the turn, and the reflection " +
      "unit reads it. The case is your own memory, not a delivery to the " +
      "user — never announce the write or cite its path in the reply; when " +
      "the user asks where something is recorded, answer in your own words. " +
      "Choose the subject the user wants to return to. A place case gathers life and conditions " +
      "at that location. An event case follows an undertaking or consequential occurrence. " +
      "Use the filing guidance in your charter for the other categories. " +
      "people/user and self/ are the reflection unit's alone — " +
      "it reads the record and keeps those; your pen never lands there. Semantics: if " +
      "the case does not exist yet it is OPENED — body becomes the case's " +
      "index.md (the case name is permanent; name the subject a reader would look up). If it ALREADY " +
      "exists, pass pieceTitle to ADD one dated piece (the date prefix is " +
      "stamped mechanically — pass the bare title); a pieceTitle on the OPEN " +
      "call also lands that first piece in the same call (one commit), but " +
      "requires a distinct overviewBody for the index: body belongs only to the piece. " +
      "Omitting pieceTitle on an existing case is refused — this tool never " +
      "rewrites an index body. A new piece and its short index navigation link land together. What you write is exactly what lands: no machine " +
      "fields are added (dates and the updated stamp are stamped " +
      "mechanically). If the piece should say where it came from (which " +
      "conversation, when), say it in prose. " +
      DOC_WRITE_WINDOW_RULE + " " + DOCUMENT_BUDGET_RULE +
      `\n\n${MEMORY_IS_GIT_RULE}\n\n${DOC_LANGUAGE_RULE}\n\n${DOC_HOUSE_STYLE}`,
    inputSchema: z.object({
      category: z
        .enum([
          "people",
          "events",
          "things",
          "places",
          "orgs",
          "research",
          "hypotheses",
          "tasks",
        ])
        .optional()
        .describe(
          "Choose the category of the subject this case is about. " +
          "Defaults to research.",
        ),
      caseName: z
        .string()
        .min(1)
        .describe(
          "The case's stable subject name without a category prefix. Undated names ('Phone research') and dated " +
          "names ('2026-11-05-Screen supplier') are both legal. The title after any date prefix cannot start with four digits.",
        ),
      body: z
        .string()
        .min(1)
        .describe(
          "The WHOLE content to write: for open — the case's index body; " +
          "for addPiece — the piece's full text. Written verbatim.",
        ),
      pieceTitle: z
        .string()
        .optional()
        .describe(
          "The dated piece's title (the date prefix is stamped " +
          "mechanically — pass the bare title, e.g. 'Vendor quotes'). On an existing " +
          "case it adds the piece; on the OPEN call it also lands that first " +
          "piece in the same call; provide overviewBody for that new case. Omit for a bare open.",
        ),
      overviewBody: z.string().min(1).optional().describe(
        "Required when opening a NEW case with pieceTitle. A distinct overview of the case and its reading purpose; body is the piece's full text. Never copy the piece into the overview. Existing cases do not need this field.",
      ),
      disconfirmingObservation: z.string().trim().min(1).optional().describe(
        "For a new hypothesis, state a concrete observation that would count against it. This is saved in the opening overview. Use the document's language.",
      ),
    }),
    contextSchema: toolContextSchema,
    execute: writeCaseExecute,
  }),
  archiveCase: tool({
    description:
      "Archive a case when the user explicitly asks to forget/retire it, or when its content is clearly obsolete. The complete case and attachments move intact to a sibling directory with the -archived suffix; nothing is deleted or detached from its semantic home. Archived cases leave default directories, search and recent views, and an old ref reads as ARCHIVED. This is not task completion and never changes the task ledger. The live people/user model and original records cannot be archived here.",
    inputSchema: z.object({
      category: z.enum(["people", "events", "things", "places", "orgs", "research", "hypotheses", "tasks", "self"]),
      caseName: z.string().trim().min(1),
      reason: z.string().trim().min(1).max(500).describe("A short human reason for retiring this case"),
    }).strict(),
    contextSchema: toolContextSchema,
    execute: archiveCaseExecute,
  }),
  queryTasks: tool({
    description:
      "List or query the AUTHORITATIVE task ledger, including revisions and non-candidates. " +
      "Pass ref for one exact task, status/query for a filtered list, and offset/limit for pages. " +
      "Omit status to include completed, cancelled, and needs_review entries. Pending background " +
      "result events are included separately. Task documents remain free prose: read them on demand " +
      "with recallRead, never treat them as lifecycle state or scan them every turn.",
    inputSchema: queryTasksToolSchema,
    contextSchema: toolContextSchema,
    execute: queryTasksExecute,
  }),
  createTask: tool({
    description:
      "Register a genuine commitment from the CURRENT user message. Never create a task from your " +
      "own proposal, generated HTML, restored controls, or UI defaults. Supply the exact tasks/<caseName> " +
      "ref, a concise summary, and only dates or waiting conditions the user actually stated. The executor " +
      "attaches the verbatim current user text, turn, and slice as evidence and uses this tool call's stable identity.",
    inputSchema: fieldCreateTaskSchema,
    contextSchema: toolContextSchema,
    execute: createTaskExecute,
  }),
  updateTask: tool({
    description:
      "Narrowly revise task state from EXPLICIT feedback in the CURRENT user message: complete, cancel, " +
      "defer, wait, pause/resume, resolve needs_review, or correct details. A postponement is never completion. " +
      "If a status-check question receives no answer, leave the state unchanged and unconfirmed. Pass the revision " +
      "returned by queryTasks; stale revisions refuse instead of overwriting newer state. The executor attaches " +
      "the actual current user statement as evidence, never model-authored evidence.",
    inputSchema: fieldUpdateTaskSchema,
    contextSchema: toolContextSchema,
    execute: updateTaskExecute,
  }),
  reportTaskFollowup: tool({
    description:
      "Declare that THIS reply actually delivers a pending background result, follows up a task candidate, or " +
      "asks a needs_review status-check question. Pass exactly one resultId from the pending-result projection " +
      "or ref from the ledger. This only queues acknowledgment intent; it does not mark anything delivered or " +
      "change lifecycle state. Follow-up is confirmed separately only after the matching reply is saved and " +
      "this source turn reaches a clean completed state. Injection, partial, failed, and cancelled turns consume nothing.",
    inputSchema: reportTaskFollowupInputSchema,
    contextSchema: toolContextSchema,
    execute: reportTaskFollowupExecute,
  }),
  selectSkill: tool({
    description:
      "Select one task-specific procedural skill by id from the adopted main catalogue. " +
      "The tool reads the original self document, returns that source plus the skill's pinned adopted " +
      "instruction, and flags source changes for review without writing memory. Changed source text is never silently adopted. " +
      "Candidates, retired entries, and skills for other roles cannot be selected.",
    inputSchema: z.object({ id: z.string().min(1) }),
    contextSchema: toolContextSchema,
    execute: selectSkillExecute,
  }),
  // The conversation's SUB-STREAM (v0.21 §2): long work the user EXPLICITLY
  // asked for ("去查一下 X") is dispatched on the spot — the executor drops a
  // question marker into the live slice's mailbox and starts the question
  // run. The sub-stream has no mouth: findings land in research/ hypotheses/
  // cases, and the completion statement is read off the tasks/ notice case by
  // a LATER turn — nothing flows back into this reply.
  startLongTask: tool({
    description:
      "Hand a piece of LONG work the user explicitly asked for to the " +
      "conversation's sub-stream — \"去查一下 X\", an investigation too big " +
      "or too slow for this reply. The sub-stream researches it ACROSS the " +
      "memory record in a durable background run and writes the findings as " +
      "documents (research/ or hypotheses/ cases). The result does NOT come " +
      "back to you here — do not wait for it and do not promise specifics: " +
      "you will read its completion statement on a LATER turn and tell the " +
      "user then. After dispatching, just tell the user the work is underway. " +
      "ONLY for work the user explicitly requested as background/long work — " +
      "never for something you can answer in this reply, and never on your " +
      "own initiative.",
    inputSchema: z.object({
      task: z
        .string()
        .min(1)
        .describe(
          "What the user asked for, as ONE self-contained line — the " +
          "investigation's title. It names the work in the record and becomes " +
          "the subject of the completion statement, so phrase it the way the " +
          "user would recognize it.",
        ),
      note: z
        .string()
        .optional()
        .describe(
          "Optional grounding for the researcher: why this matters now, plus " +
          "pointers (slice ids, case paths) — pointers are worth more than " +
          "summaries; the run reads the original records itself.",
        ),
      evidenceQuote: z.string().min(1).max(4000).optional().describe(
        "For long user messages, quote the exact current-user request for this background work (at most 4000 characters).",
      ),
    }),
    contextSchema: toolContextSchema,
    execute: startLongTaskExecute,
  }),
  // The sediment mailbox PRODUCER (v0.15 design §3.1/§4.3). One of the reply
  // segment's TWO writes (alongside writeCase): a single structured marker
  // line into the current slice's agent.md, consumed by the reflection unit
  // and the scribe/research passes at slice close — a clue, not an order.
  noteForSediment: tool({
    description:
      "Leave a marker for reflection when the conversation provides a finding worth keeping, " +
      "such as a change in a decision or a comparison someone would want to consult (kind 'sediment'). " +
      "Use the existing case as the target when the new evidence belongs there. " +
      "A passing reference can stay in the conversation. For a date-anchored commitment the user " +
      "actually made, use 'task' and pass dateAnchor. For an open question worth investigating later, " +
      "use 'question'. This appends one marker to the current slice's mailbox. " +
      "Reflection evaluates it when archiving the slice. Continue answering; the marker itself does not file a document.",
    inputSchema: z.object({
      kind: z
        .enum(["sediment", "task", "question"])
        .describe(
          "sediment = worth keeping as a document; task = a date-anchored " +
          "thing the user stated; question = a thread for the background " +
          "research pass.",
        ),
      title: z
        .string()
        .min(1)
        .describe(
          "Name the subject or question the marker is about.",
        ),
      note: z
        .string()
        .optional()
        .describe("One line on what this is about — grounds the later write."),
      docType: z
        .enum(["research", "entity"])
        .optional()
        .describe("sediment only: research (default) or entity."),
      entityKind: z
        .enum(["event", "person", "object", "place", "org"])
        .optional()
        .describe("sediment+entity only: which of the five entity kinds."),
      target: z
        .string()
        .optional()
        .describe(
          "sediment only: an EXISTING case reference to update (<category>/<case>, as cited by a recall result's ref), when this updates one rather than opening one.",
        ),
      dateAnchor: z
        .string()
        .optional()
        .describe("task only: the date the user stated, YYYY-MM-DD."),
      topics: z
        .array(z.string())
        .optional()
        .describe(
          "LEGACY, ignored by the case-model writers — kept for mailbox compatibility.",
        ),
      body: z
        .string()
        .optional()
        .describe(
          "sediment only: the FULL pasted text when sedimenting a long text the user sent " +
          "('save this') — the scribe preserves the source wording and origin. " +
          "Omit for ordinary markers.",
        ),
    }),
    contextSchema: toolContextSchema,
    execute: noteForSedimentExecute,
  }),
  describeRoom: tool({
    description:
      "Describe the hotel room a time slice opens onto in the game view — " +
      "an engine-computed outline of its world, plan, modules, palette, light, " +
      "furnishing, water, doors and windows. With a validated view, omitting " +
      "sliceId describes the room being viewed. Its frozen snapshot, when " +
      "present, ALWAYS supplies the profile, door count and corridor side; " +
      "model-supplied runtime inputs cannot override what the user sees. " +
      "Without a matching snapshot the result says plainly that it is only " +
      "the base compilation and no record semantics were read. Legacy calls " +
      "without a view may supply known strandDoors + corridorSide; never " +
      "guess them for the currently viewed room.",
    inputSchema: z.object({
      sliceId: z
        .string()
        .optional()
        .describe(
          "Slice ID in YYYY-MM-DD-HHMM format. Defaults to the validated view's slice, then the conversation slice.",
        ),
      strandDoors: z
        .number()
        .int()
        .min(0)
        .max(ROOM_SNAPSHOT_MAX_DOOR_COUNT)
        .optional()
        .describe(
          "Legacy/no-view calls only: the known runtime strand-door count. " +
          "A validated view takes precedence; its frozen count cannot be overridden.",
        ),
      corridorSide: z
        .enum(["north", "south"])
        .optional()
        .describe(
          "Legacy/no-view calls only: which corridor side the entrance sits on. " +
          "A validated view takes precedence; its frozen side cannot be overridden.",
        ),
    }),
    contextSchema: toolContextSchema,
    execute: describeRoomExecute,
  }),
  currentTime: tool({
    description:
      "Check the current time — the user's local time (minute precision, with " +
      "timezone and UTC offset), how long this conversation slice has been " +
      "running and how much of its time cap is left, plus a refreshed " +
      "date-anchor table (today / tomorrow / last week with weekdays). " +
      "Call this whenever a precise time matters: \"now\", \"in a few minutes\", " +
      "\"how long have we been talking\", \"tonight\", or something due today. " +
      "The slice-start time in your system prompt is a snapshot taken when " +
      "this slice began — it may already be tens of minutes old, so never " +
      "trust it for exact times.",
    inputSchema: z.object({}),
    contextSchema: toolContextSchema,
    execute: currentTimeExecute,
  }),
  webSearch: tool({
    description:
      "Use for current or external evidence needed for the answer. A search agent finds and reads sources, then reports an answer, its sources and uncertainty. " +
      "Choose standard for one research question. Independent gaps in a broad request can use up to four concurrent scout calls. Suggested pages are optional when the report already answers the question.",
    inputSchema: z.object({
      query: z
        .string()
        .describe("A specific, self-contained research question."),
      mode: z
        .enum(["standard", "scout"])
        .optional()
        .describe(
          "'scout' = a lean fan-out leg (fewer page reads/search rounds) for " +
          "when you dispatch several researchers in parallel. Omit (or " +
          "'standard') for a single normal research run.",
        ),
    }),
    contextSchema: toolContextSchema,
    execute: webSearchExecute,
  }),
  webFetch: tool({
    description:
      "Read one specific page as Markdown (boilerplate stripped, ~15K " +
      "characters, optional range filters search/lines). YOUR tool for " +
      "reading a KNOWN URL — a link the user pasted, or a suggestedReads page " +
      "from a webSearch report you want to verify. NOT a search tool: to FIND " +
      "information, use webSearch.",
    inputSchema: z.object({
      url: z
        .string()
        .describe("Full absolute URL of the page to read, e.g. 'https://example.com/article'."),
      range: z
        .object({
          type: z
            .enum(["search", "lines"])
            .describe(
              "search = keyword match, returns matching paragraphs (+ context); " +
              "if nothing matches, returns the full text with a note. " +
              "lines = 1-indexed line range of the raw text, like a code file.",
            ),
          keywords: z
            .array(z.string())
            .optional()
            .describe("Case-insensitive keywords to match. Only for type 'search'."),
          context: z
            .number()
            .optional()
            .describe("Paragraphs of context around each match (default 1). Only for type 'search'."),
          start: z
            .number()
            .optional()
            .describe("First line (1-indexed, inclusive). Only for type 'lines'."),
          end: z
            .number()
            .optional()
            .describe("Last line (1-indexed, inclusive). Only for type 'lines'."),
        })
        .optional()
        .describe("Optional range filter. When omitted, returns the page text up to the cap."),
    }),
    contextSchema: toolContextSchema,
    execute: webFetchExecute,
  }),
  viewImage: tool({
    description:
      "See an image — a link the user pasted, an image found during research, " +
      "or a user attachment on a non-vision model. One-shot look: pass a " +
      "`question` to say what you want to know about the image. For `source`, " +
      "use an http(s) URL, `attachment:N` where N is the attachment number " +
      "from the placeholder in the user's message, or " +
      "`doc:<category>/<case>/<attachment>` for an image attachment stored in a " +
      "memory case (v0.19 §C.1). NOT for pages — use webFetch for those.",
    inputSchema: z.object({
      source: z
        .string()
        .describe(
          "Image source: an http(s) URL, 'attachment:N' referring to the Nth " +
          "image attachment of the current turn, or 'doc:<category>/<case>/<attachment>' " +
          "for an image attachment stored in a memory case.",
        ),
      question: z
        .string()
        .optional()
        .describe(
          "What you want to know about the image. Be specific. Omit for a general " +
          "structured description.",
        ),
    }),
    contextSchema: toolContextSchema,
    execute: viewImageExecute,
  }),
  thinkDeep: tool({
    description:
      "Dispatch a question to a clean-room thinking pod — a think-only copy " +
      "of yourself reasoning in complete isolation from your current context " +
      "(no search, no memory tools — embed every fact it needs in the " +
      "question). Two first-class uses: (a) genuinely hard problems where the " +
      "clean room sustains depth that your live context would dilute — " +
      "trade-offs, architecture decisions, deep analysis; dispatch with " +
      "the fixed maximum reasoning profile. (b) Parallel " +
      "reasoning when the user raises several independent questions or angles " +
      "in one turn — dispatch only directions that benefit from deeper reasoning " +
      "together in the SAME step (tool calls within one step " +
      "run concurrently), then synthesize. " +
      "Embed not just facts but the user's DECISION CRITERIA — what matters " +
      "to them, constraints, standards. A pod fed only facts reasons by " +
      "generic standards and comes back objective but ill-fitting. " +
      "The pod's output is EVIDENCE, not a verdict: it reasons without this " +
      "conversation, so you must couple its conclusion with your own context " +
      "and the user's actual needs. On conflict, your context wins; surface " +
      "the divergence rather than hiding it. " +
      "Returns the conclusion plus its thinking trail; a pod may come back " +
      "partial (`status: timeout`) — its `answer` and `reasoning` hold what " +
      "it already produced; work with them, or gather the missing facts " +
      "yourself and dispatch a finer question. The thinking role always uses max " +
      "effort. Synthesize its evidence in your own voice.",
    inputSchema: z.object({
      question: z
        .string()
        .describe("Self-contained question for the thinking pod. Include all necessary context, facts, AND the user's decision criteria — it has no tools and cannot look anything up."),
    }),
    contextSchema: toolContextSchema,
    execute: thinkDeepExecute,
  }),
};

const workRelationSchema = z.object({
  relation: z.enum(["new", "related", "continuation", "unclear"]).optional()
    .describe("Advisory relation to other work; never changes ownership of this input."),
  dependsOnInputIds: z.array(z.string().min(1)).max(8).optional()
    .describe("Other input IDs whose existing handoffs are useful; not permission to redo them."),
}).strict();

export const workCheckpointTool = tool({
  description:
    "Hand off a new, supported partial answer to this input while work continues. It may come from the supplied context or a completed lookup. You can call this alongside an independent next lookup. The dialogue Actor decides what to say. If the full answer is ready, use completeWork.",
  inputSchema: workRelationSchema.extend({
    text: z.string().max(2400).refine(text => text.trim().length > 0, "text must not be blank")
      .describe("The finding and its material uncertainty. Identify the outstanding question if useful. Omit plans, tool logs and private reasoning."),
  }).strict(),
  contextSchema: toolContextSchema,
  execute: workCheckpointExecute,
});

export const completeWorkTool = tool({
  description:
    "Complete ONLY the current input with verified work results, not public wording. Include the selected responseMode and what the user needs at the requested precision. Preserve material caveats, sources and complete native HTML artifacts. Call exactly once when work is complete, then call finishThinking in a SEPARATE later tool step; never bundle them. For a genuine user-input blocker, skip this tool and use finishThinking with needsUser. Do not answer, repeat or complete other inputs. The dialogue Actor owns integration and public expression.",
  inputSchema: workRelationSchema.extend({
    result: z.string().max(200_000).refine(text => text.trim().length > 0, "result must not be blank")
      .describe("Findings for the current ask, with their evidence and material limits. State what was established about the event separately from what you could find in the records. An unavailable source leaves its contents unknown. Omit wording advice and incidental claims. The dialogue role chooses its own words."),
    responseMode: z.enum(WORK_RESPONSE_MODES).optional()
      .describe("The response mode selected for this input. The result should fit the user's requested shape."),
  }).strict(),
  contextSchema: toolContextSchema,
  execute: completeWorkExecute,
});

export const readWorkSnapshotTool = tool({
  description:
    "Read another thinking run's public-safe current snapshot: status, stage, handoffs and result reference. Read it when the answer depends on that handoff or it could avoid repeating needed work. This is read-only Workflow state, not permission to take over the work. Do not treat pending work as finished or share its private reasoning.",
  inputSchema: z.object({ workId: z.string().min(1) }).strict(),
  contextSchema: toolContextSchema,
  execute: readWorkSnapshotExecute,
});
/** Cloud and local BYOK share the same tool surface. */
export function getChatTools(): typeof chatTools { return chatTools; }

// ─── toolsContext builders ───────────────────────────────────────────────

/** Same serializable chat context, fanned out to every chat tool by name. */
export function buildChatToolsContext(
  ctx: ToolContext,
): Record<keyof typeof chatTools, ToolContext> {
  const imageContext = ctx;
  if (ctx.imageAttachments?.length) {
    // Only viewImage needs the image data URLs in its tool invocation payload.
    ctx = { ...ctx };
    delete ctx.imageAttachments;
  }
  const contexts: Record<keyof typeof chatTools, ToolContext> = {
    recallScenario: ctx,
    recallRecent: ctx,
    recallList: ctx,
    recallFind: ctx,
    recallSearch: ctx,
    recallRead: ctx,
    recallSince: ctx,
    writeCase: ctx,
    archiveCase: ctx,
    queryTasks: ctx,
    createTask: ctx,
    updateTask: ctx,
    reportTaskFollowup: ctx,
    selectSkill: ctx,
    startLongTask: ctx,
    noteForSediment: ctx,
    describeRoom: ctx,
    currentTime: ctx,
    webSearch: ctx,
    webFetch: ctx,
    viewImage: imageContext,
    thinkDeep: ctx,
  };
  // Keep the context map in lockstep with getChatTools(): a registered tool
  // must never lack its context entry.
  return contexts;
}

