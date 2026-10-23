/**
 * Shared tool definitions for the WorkflowAgent — the chat agent binds its
 * tool set here.
 *
 * Each tool couples an inputSchema (what the model provides), a contextSchema
 * (what the workflow provides via `toolsContext`), and a standalone
 * `"use step"` executor from ./tool-executors — so every tool call is an
 * individually durable, auto-retried workflow step.
 *
 * Tools are conceptual, not filesystem-oriented. The agent sees slices,
 * case documents, and its own agent timelines — never file paths. Each tool
 * constructs its own path internally and only accesses its specific concept.
 */

import { tool } from "@/lib/deepseek/tools";
import { z } from "zod";

import { DOC_HOUSE_STYLE, DOC_LANGUAGE_RULE } from "@/lib/agents/doc-style";
import { RECALL_CATEGORIES } from "@/lib/memory/categories";
// Direct module path, not the "@/lib/docs" barrel: this file is reachable
// from the "use workflow" bundle, and the barrel re-exports case-doc.ts
// (gray-matter → node:*), which the workflow bundler rejects.
import {
  DOC_WRITE_WINDOW_RULE,
  MEMORY_IS_GIT_RULE,
} from "@/lib/docs/write-window";
import {
  recallRecentExecute,
  recallFindExecute,
  recallSearchExecute,
  recallReadExecute,
  recallSinceExecute,
  webSearchExecute,
  webFetchExecute,
  thinkDeepExecute,
  currentTimeExecute,
  describeRoomExecute,
  viewImageExecute,
  writeCaseExecute,
  startLongTaskExecute,
  noteForSedimentExecute,
  type ToolContext,
} from "./tool-executors";

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
  // ① What has been happening — the recent-N view. Omitting `category` gives
  // one cross-category timeline (the "I can't recall which world it lives
  // in" answer); a category narrows to one world.
  recallRecent: tool({
    description:
      "See what has been happening in memory — the N most recent ENTRIES " +
      "(ref / title / date / one-line excerpt), never raw files, newest " +
      "activity first. Use this FIRST whenever the user asks about the past " +
      "and you are not sure WHERE it lives: omit `category` and you get one " +
      "cross-category timeline (conversation slices + cases interleaved by " +
      "activity date). Pass a category to look inside one world — events / " +
      "people / things / tasks / research / places / orgs / self / timeline " +
      "(slice heads) / records (slices). `n` defaults to 10 (hard cap 30); " +
      "`after` / `before` (YYYY-MM-DD, inclusive) bound the window. Order is " +
      "always newest activity first — you cannot sort. `offset` (default 0) " +
      "pages deeper: pass the offset the result tells you to continue past " +
      "the first page. Use recallFind when the thing is NAMED, recallSearch " +
      "for a keyword hunt. " +
      "FIXED result wording (recognize it, do not paraphrase): entries open " +
      "with `The {n} most recent {category} entries:`; an empty scope opens " +
      "with `There is nothing here yet — no {category} entries exist in this " +
      "scope.` — report THAT, not your own guess about what the user " +
      "remembers; a page with older entries behind it appends `Showing {n} " +
      "from offset {offset} — pass offset={offset+n} for older ones.`; an " +
      "offset past the end returns `No more entries — offset {offset} is " +
      "past the end; only {total} exist in this scope, newest first.` — an " +
      "empty page is NOT absence.",
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
          "(default 0). Continue with the offset the full-page note gives you.",
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
  // ② Locate ONE named thing — the point-lookup verb.
  recallFind: tool({
    description:
      "Locate ONE thing in memory by its name. Use this when the user (or a " +
      "document) NAMES the thing: a case by name (category + the bare case " +
      "name, e.g. category 'events', name '换手机'), a self document " +
      "(category 'self': 'search', 'thinkdeep', … or the reserved bare file " +
      "'agenda'), a slice by id (category 'records' or 'timeline', " +
      "'2026-10-14-1836' — or a day '2026-10-14' for timeline). Give the " +
      "name as you remember it — approximate names (a missing space, " +
      "full/half-width punctuation, letter case) resolve automatically, " +
      "and an approximate hit tells you the stored name it matched. " +
      "FIXED result wording: a hit opens `The 1 most recent {category} " +
      "entries:`; an approximate hit appends `(matched the near-name " +
      "\"{stored name}\" — that is the stored name)`; a miss opens " +
      "`Nothing named \"{name}\" exists in {category}. Closest matches: …` " +
      "(or `…and nothing similar.`) — a miss is NOT proof of absence; " +
      "check the near matches before telling the user anything is " +
      "missing. Then recallRead(ref) for the content.",
    inputSchema: z.object({
      category: z
        .enum(RECALL_CATEGORIES)
        .describe("Which world the named thing lives in."),
      name: z
        .string()
        .min(1)
        .describe(
          "Case name / self document name ('agenda' included) / slice id " +
          "(YYYY-MM-DD-HHMM) or day (YYYY-MM-DD for timeline) — as you " +
          "remember it; near names resolve automatically.",
        ),
    }),
    contextSchema: toolContextSchema,
    execute: recallFindExecute,
  }),
  // ③ Keyword hunt — with the scan-surface discipline: organized layer
  // first, raw conversation only on explicit request.
  recallSearch: tool({
    description:
      "Keyword-search memory. The DEFAULT scan surface is the organized " +
      "layer ONLY: case documents, self SOPs + agenda, the user profile, and " +
      "slice HEADS (focus/summary lines). Raw conversation bodies " +
      "(category 'records') are scanned ONLY when you pass category " +
      "'records' or includeRecords:true — reach for the organized layer " +
      "first; go to the raw record as the second layer, when the answer is " +
      "not in any document. Keywords AND within a segment (pass synonyms as " +
      "separate calls). Hits return entries whose excerpt is the matching " +
      "snippet, newest activity first, up to `limit` (default 20, hard cap 30) " +
      "per page; `offset` (default 0) pages deeper — pass the offset the " +
      "full-page note gives you; order is always newest first — you cannot " +
      "sort. Scanning touches at most 50 files per call; `since` / `until` " +
      "(YYYY-MM-DD) bound by " +
      "activity date. FIXED result wording: hits open `{n} match(es) for " +
      "\"{query}\":`; ZERO hits on a non-empty scope open `Nothing matches " +
      "\"{query}\". Here are the {n} most recent entries instead:` — that is " +
      "a FALLBACK, not absence, and you must not quote it as 'the user never " +
      "recorded this'; an empty scope opens `There is nothing here yet — no " +
      "{category} entries exist in this scope.`; a capped scan appends " +
      "`Showing the newest {limit} of {scanned} scanned — narrow by date or " +
      "add keywords for the older ones.`; a page with older hits behind it " +
      "appends `Showing {n} from offset {offset} — pass offset={offset+n} for " +
      "older ones.`; an offset past the end returns `No more entries — offset " +
      "{offset} is past the end; only {total} exist in this scope, newest " +
      "first.` — an empty page is NOT absence. Continue with recallRead(ref) " +
      "on anything promising.",
    inputSchema: z.object({
      query: z
        .union([z.string(), z.array(z.string())])
        .describe(
          "One keyword or several — within one segment every keyword must " +
          "match (case-insensitive).",
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
      since: z
        .string()
        .optional()
        .describe("Inclusive lower day bound, YYYY-MM-DD."),
      until: z
        .string()
        .optional()
        .describe("Inclusive upper day bound, YYYY-MM-DD."),
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
          "Skip the newest `offset` hits and return the next page " +
          "(default 0). Continue with the offset the full-page note gives you.",
        ),
    }),
    contextSchema: toolContextSchema,
    execute: recallSearchExecute,
  }),
  // ④ Continue reading — the "出处" verb: entries cite refs, refs read here.
  recallRead: tool({
    description:
      "Continue reading an entry — pass the `ref` from any recall result " +
      "(e.g. 'events/换手机', 'research/手机调研/" +
      "2026-09-08-报价篇', 'self/agenda', 'people/user/profile', " +
      "'records/2026-10-14-1836'). An approximate name in the ref also " +
      "resolves — the result opens by telling you which stored name it " +
      "matched. Case refs return the whole document; the " +
      "records ref returns that conversation's core record — the ONLY " +
      "source for specific facts (numbers, dates, quotes, promises): read " +
      "it BEFORE answering from memory, and prefer a `range` over a full " +
      "slice (a full slice is the most expensive read). For records: " +
      "`part` selects 'core' (default) / 'agent' (your cognition for that " +
      "slice) / 'previously' (the user-card snapshot of that moment); on " +
      "core, `range` narrows the read — 'last' the most recent N turns, " +
      "'turns' by 0-based index, 'date' turns after an ISO timestamp, " +
      "'search' keywords (matched turns + one turn of context; a miss " +
      "returns the full slice with a note), 'lines' a 1-indexed line range " +
      "like a code file. For a LONG document, first call with `outline: true` " +
      "to get its heading skeleton (levels + line spans), then read only the " +
      "spans you need with `range: { type: \"lines\", start, end }`. FIXED " +
      "result wording: an approximate match " +
      "opens `(matched the near-name \"{stored ref}\" — read it under " +
      "that stored name)`; an unresolvable ref returns `Nothing named " +
      "\"{ref}\" exists in memory. Closest matches: …` (or `…and nothing " +
      "similar.`); a read failure returns `This could not be read right " +
      "now (…). That is a read failure, not absence — it may still " +
      "exist.` — never report either as the user not having remembered " +
      "something.",
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
          "records refs only: which slice part to read (default 'core').",
        ),
      range: z
        .object({
          type: z
            .enum(["turns", "last", "date", "search", "lines"])
            .describe(
              "turns = specific turn indices. last = most recent N turns. " +
              "date = turns after a given timestamp. search = keyword match, " +
              "returns matching turns (+ context); if nothing matches, " +
              "returns the full slice with a note. lines = 1-indexed line " +
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
          "records core only: an optional range filter. When omitted, " +
          "returns the full slice content.",
        ),
      outline: z
        .boolean()
        .optional()
        .describe(
          "true = return the document's heading skeleton instead of its " +
          "body (levels + line spans, no prose). Use FIRST on a long " +
          "document, then fetch the spans you need with " +
          'range: { type: "lines", start, end }.',
        ),
    }),
    contextSchema: toolContextSchema,
    execute: recallReadExecute,
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
      "Every returned entry is a recallRead-ready ref carrying its change " +
      "(added / modified / removed) and date — continue with recallRead(ref). " +
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
      "write something down. That is a task (v0.30 §2.6): call writeCase " +
      "FIRST, write it, then answer from what you wrote. Nothing else earns " +
      "a write from you — the record carries the turn, and the reflection " +
      "unit reads it. The case is your own memory, not a delivery to the " +
      "user — never announce the write or cite its path in the reply; when " +
      "the user asks where something is recorded, answer in your own words. " +
      "Categories — what the case IS decides: people/ a person, events/ " +
      "something that happened (date-anchored), things/ an object or work, " +
      "places/ a place, orgs/ an organization, research/ an investigation, " +
      "hypotheses/ a judgment still to be verified (state what would " +
      "falsify it), tasks/ a commitment to " +
      "carry out. people/user and self/ are the reflection unit's alone — " +
      "it reads the record and keeps those; your pen never lands there. Semantics: if " +
      "the case does not exist yet it is OPENED — body becomes the case's " +
      "index.md (the case name is permanent; name it for the QUESTION, " +
      "specific enough that a scope change means a new case). If it ALREADY " +
      "exists, pass pieceTitle to ADD one dated piece (the date prefix is " +
      "stamped mechanically — pass the bare title); a pieceTitle on the OPEN " +
      "call also lands that first piece in the same call (one commit). " +
      "Omitting pieceTitle on an existing case is refused — this tool never " +
      "rewrites an index. What you write is exactly what lands: no machine " +
      "fields are added (dates and the updated stamp are stamped " +
      "mechanically). If the piece should say where it came from (which " +
      "conversation, when), say it in prose. " +
      DOC_WRITE_WINDOW_RULE +
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
          "What the case IS decides the category (see the tool description). " +
          "Defaults to research.",
        ),
      caseName: z
        .string()
        .min(1)
        .describe(
          "The case's name (no category prefix): specific enough that a " +
          "scope change means a NEW case. Undated names ('手机调研') and dated " +
          "names ('2026-11-05-屏幕供应商') both legal; never start a title " +
          "with four digits.",
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
          "mechanically — pass the bare title, e.g. '报价篇'). On an existing " +
          "case it adds the piece; on the OPEN call it also lands that first " +
          "piece in the same call. Omit for a bare open.",
        ),
    }),
    contextSchema: toolContextSchema,
    execute: writeCaseExecute,
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
      "Make THIS conversation leave something behind — your one way to turn " +
      "what just happened into a document that outlives this chat. Call it the " +
      "moment any of these happens (do not wait for the conversation to end):\n" +
      "1. The user mentions something that will come up again — a project, a " +
      "decision, a thing or person in their world that deserves its own " +
      "entity or research document (kind 'sediment').\n" +
      "2. You dug something up that is worth keeping — a search result, a " +
      "comparison, a conclusion reached across several turns that should " +
      "become a research document (kind 'sediment').\n" +
      "3. The user states a date-anchored commitment or arrangement — " +
      "\"我 8 号要去 on-site\", \"下周三提醒我…\" — which must become a tracked " +
      "task document (kind 'task', ALWAYS pass dateAnchor).\n" +
      "4. An open thread surfaces that deserves a proper investigation later — " +
      "a question too big for this reply (kind 'question').\n" +
      "It appends ONE marker line to THIS slice's mailbox; the document itself " +
      "is written later, when HQ archives this slice (the passes that read " +
      "these markers run on HQ's archive) — so after calling it, keep " +
      "answering and treat the matter as NOT yet recorded. Not for things belonging to the current conversation (they " +
      "already live in this slice), and not for one-off trivia that will never " +
      "be mentioned again. Title = the document's title: specific enough that " +
      "a scope change would mean a NEW document.",
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
          "The document's title (naming discipline: specific enough that a scope change means a new document).",
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
          "('存下这个') — the scribe opens the case with this verbatim, origin stamped. " +
          "Omit for ordinary markers.",
        ),
    }),
    contextSchema: toolContextSchema,
    execute: noteForSedimentExecute,
  }),
  describeRoom: tool({
    description:
      "Describe the hotel room a time slice opens onto in the game view — " +
      "an engine-computed outline of what the room CONTAINS: world class and " +
      "archetype, size and scale notation, floor plan, module/template layout, " +
      "palette and light register, furnishing kits, water, doors and windows. " +
      "The outline is derived from the world seed by the same pure modules " +
      "that render the room, so it is exact and deterministic — quote it " +
      "freely, it cannot disagree with what the user sees. Use it when the " +
      "user asks what is in the room they are standing in (omit sliceId for " +
      "the current slice's room) or what a past slice's room looks like. " +
      "Strand-door PLACEMENTS additionally depend on the runtime strand " +
      "graph: pass strandDoors + corridorSide only if you know them; " +
      "otherwise the outline reports the permitted walls and measured " +
      "capacity instead of positions.",
    inputSchema: z.object({
      sliceId: z
        .string()
        .optional()
        .describe(
          "Slice ID in YYYY-MM-DD-HHMM format. Defaults to the current slice.",
        ),
      strandDoors: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe(
          "The runtime strand-door count for this slice, when known. Steers " +
          "layout selection exactly as the real count does at render time.",
        ),
      corridorSide: z
        .enum(["north", "south"])
        .optional()
        .describe(
          "Which side of the corridor the room's entrance door sits on " +
          "(the room's mirror). Required together with strandDoors for exact " +
          "door placements.",
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
      "Hand a research question to a search-desk copy of yourself — a sub-agent " +
      "that searches the live web AND reads the most promising pages itself, " +
      "then returns a real answer that combines what it found with its own " +
      "knowledge (web claims carry source mentions), plus its confidence " +
      "assessment (what is solid, what is uncertain or conflicting) and a few " +
      "suggested pages for your own follow-up. Use it for current or external " +
      "information — news, releases, prices, docs, anything time-sensitive or " +
      "beyond the user's memory. Do not use it for things already in memory " +
      "or that you reliably know. " +
      "For comparative / evaluation / survey-shaped questions, decompose the " +
      "question yourself into 2–4 non-overlapping sub-queries and issue the " +
      "calls in the SAME step with mode 'scout' (tool calls within one step " +
      "run concurrently). Push source diversity — different angles, vendors, " +
      "or regions where relevant. When all reports return, synthesize and " +
      "cross-validate; where researchers conflict, say so explicitly. " +
      "Simple factual questions get ONE standard call — never fan out. " +
      "Max 4 parallel researchers.",
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
      "in one turn — break it into one self-contained question per direction " +
      "and dispatch all of them in the SAME step (tool calls within one step " +
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

/** Cloud and local BYOK share the same tool surface. */
export function getChatTools(): typeof chatTools { return chatTools; }

// ─── toolsContext builders ───────────────────────────────────────────────

/** Same serializable chat context, fanned out to every chat tool by name. */
export function buildChatToolsContext(
  ctx: ToolContext,
): Record<keyof typeof chatTools, ToolContext> {
  const contexts: Record<keyof typeof chatTools, ToolContext> = {
    recallRecent: ctx,
    recallFind: ctx,
    recallSearch: ctx,
    recallRead: ctx,
    recallSince: ctx,
    writeCase: ctx,
    startLongTask: ctx,
    noteForSediment: ctx,
    describeRoom: ctx,
    currentTime: ctx,
    webSearch: ctx,
    webFetch: ctx,
    viewImage: ctx,
    thinkDeep: ctx,
  };
  // Keep the context map in lockstep with getChatTools(): a registered tool
  // must never lack its context entry.
  return contexts;
}

