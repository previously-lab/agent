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
 * strands, timelines, and agent timelines — never file paths. Each tool
 * constructs its own path internally and only accesses its specific concept.
 */

import { tool } from "ai";
import { z } from "zod";
import { isClientMode } from "@/lib/mode";
import {
  readSliceExecute,
  readAgentTimelineExecute,
  readPreviouslyExecute,
  webSearchExecute,
  webFetchExecute,
  thinkDeepExecute,
  currentTimeExecute,
  describeRoomExecute,
  delegateTaskExecute,
  viewImageExecute,
  listTreeExecute,
  readDocExecute,
  writeCaseExecute,
  reportToHQExecute,
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
  sdk: z.enum(["deepseek", "anthropic", "openai", "bridge"]),
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
  // The turn's resolved MAIN model — all sub-agents (thinkDeep, webSearch, …)
  // use it directly (the same one injected for the main agent) instead of
  // re-resolving config from GitHub on every fragment step.
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

// ─── Concept tools ───────────────────────────────────────────────────────

export const conceptTools = {
  readSlice: tool({
    description:
      "Open a time slice's original conversation record (core timeline) — " +
      "the ONLY source for specific facts (numbers, dates, quotes, promises): " +
      "read FIRST, then answer. Use it to answer from a slice you located via " +
      "listTree, to follow a document's " +
      "evidence chain down to the original text, or whenever you need the " +
      "verbatim original of anything the user or a document claims about the " +
      "past. " +
      "Use the optional `range` parameter to fetch only specific turns instead " +
      "of the entire slice — a full slice is the most expensive option. " +
      "`search` matches keywords across the slice (misses return the full slice " +
      "with a note); `lines` reads a 1-indexed line range like a code file.",
    inputSchema: z.object({
      sliceId: z
        .string()
        .describe("Slice ID in YYYY-MM-DD-HHMM format, e.g. '2026-07-24-1500'."),
      range: z
        .object({
          type: z
            .enum(["turns", "last", "date", "search", "lines"])
            .describe(
              "turns = specific turn indices. last = most recent N turns. " +
              "date = turns after a given timestamp. " +
              "search = keyword match, returns matching turns (+ context); " +
              "if nothing matches, returns the full slice with a note. " +
              "lines = 1-indexed line range of the raw file.",
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
          "Optional range filter. When omitted, returns the full slice content.",
        ),
    }),
    contextSchema: toolContextSchema,
    execute: readSliceExecute,
  }),
  readAgentTimeline: tool({
    description:
      "Read your own cognitive record (Agent timeline) for a slice — " +
      "what you were thinking, which tools you called, and why. " +
      "Use this for self-reflection: to understand your past reasoning.",
    inputSchema: z.object({
      sliceId: z
        .string()
        .describe("Slice ID in YYYY-MM-DD-HHMM format."),
    }),
    contextSchema: toolContextSchema,
    execute: readAgentTimelineExecute,
  }),
  readPreviously: tool({
    description:
      "Read the previously.md (previously.md) for a specific slice — the agent's " +
      "impressions and understanding of the user at that moment in time. " +
      "The current slice's previously.md is already in your context; use this " +
      "only to read historical versions for comparison.",
    inputSchema: z.object({
      sliceId: z
        .string()
        .optional()
        .describe(
          "Slice ID in YYYY-MM-DD-HHMM format. Defaults to the current slice.",
        ),
    }),
    contextSchema: toolContextSchema,
    execute: readPreviouslyExecute,
  }),
};

// ─── Chat tool set ───────────────────────────────────────────────────────
//
// The reply segment's read surface (v0.19 §A.2.1, final shape). There is
// NO memory colleague: past-memory questions are YOURS.
//
// Memory surface:
//   - listTree: the WHOLE memory tree in one call, grouped by top-level
//     category (people/ events/ things/ … records/). A TRANSITIONAL
//     PLACEHOLDER — a dedicated retrieval tool will replace it. The paths
//     themselves are the index: category / case name / date all live on the
//     path. No ranking, no relevance score — read the list.
//   - readDoc: point-read a case document by TWO-SEGMENT reference —
//     `分类/case名` → the case's index.md; `分类/case名/篇名` → one dated
//     piece. Judge freshness from the opened/closed dates in the header.
//   - readSlice: point-read the original conversation record — the ONLY
//     source for specific facts (numbers, dates, quotes, promises): read
//     FIRST, then answer. `range` fetches only the turns you need.
//   - readAgentTimeline / readPreviously: your own cognition for a slice /
//     the user-card snapshot of that moment.
//   - noteForSediment: the sediment mailbox — the reply segment's ONE write
//     (只读 + 记账): drop a marker line for the boundary-run writers.
//
// How to find things: listTree first (what cases exist), readDoc into the
// promising ones, readSlice down to the evidence. If the question is
// genuinely fuzzy archaeology with no anchor at all, say what you found
// honestly or note it for a background task — no synchronous deep-search
// detour on the reply path.
export const chatTools = {
  readSlice: conceptTools.readSlice,
  readAgentTimeline: conceptTools.readAgentTimeline,
  readPreviously: conceptTools.readPreviously,
  // Case-tree readers (v0.19 §A.2.1): the filesystem IS the index.
  listTree: tool({
    description:
      "List the ENTIRE memory tree in one call — a transitional placeholder " +
      "until a dedicated retrieval tool exists. Returns every path under " +
      "memory/, GROUPED by top-level category (people / events / things / " +
      "places / orgs / research / hypotheses / tasks / self / records), with " +
      "config/ filtered out (engineering state, not documents). records/ " +
      "collapses to one line per conversation (YYYY/MM/DD/HHMM). " +
      "`truncated: true` means the listing may be incomplete (GitHub's tree " +
      "API cut it off) — trust the shape, re-ask narrowly if something is " +
      "missing. There is NO ranking and NO relevance score: the paths " +
      "themselves — category, case name, birth date — ARE the index; read " +
      "them yourself. Use this FIRST whenever the answer might already live " +
      "in memory: it is one call to see what cases exist, then readDoc into " +
      "the promising ones.",
    inputSchema: z.object({}),
    contextSchema: toolContextSchema,
    execute: listTreeExecute,
  }),
  readDoc: tool({
    description:
      "Read a case document by its TWO-SEGMENT reference (v0.19 §B.2): " +
      "`分类/case名` (e.g. 'research/手机调研') → that case's index.md — what " +
      "it is, where it stands, which pieces hang in it; `分类/case名/篇名` → " +
      "one dated piece. Case docs are small files — the whole file is " +
      "returned: the opened/closed dates (closed = sealed, 写完封口), the " +
      "正文, and the dated 尾部 lines. Judge freshness yourself from those " +
      "dates — contradictions between documents are time, read them " +
      "newest-first. Grounding rule applies: a document may summarize, but " +
      "specific facts (numbers, dates, quotes, promises) enter your answers " +
      "only from the original slice text — the document's job is to point " +
      "you at the right slice fast. If the reference resolves nowhere you " +
      "get a dead-link error saying so — not blocking; run listTree to see " +
      "what exists.",
    inputSchema: z.object({
      ref: z
        .string()
        .describe(
          "Two-segment reference: '分类/case名' or '分类/case名/篇名', e.g. 'research/手机调研' or 'tasks/8号on-site' (《》 marks and a .md suffix tolerated).",
        ),
    }),
    contextSchema: toolContextSchema,
    execute: readDocExecute,
  }),
  // The field agent's case write (v0.21 §2): open a case mid-reply so a
  // research/task turn writes the document FIRST and answers FROM it.
  // Categories are an enumerated set — research/ or tasks/ — validated in the
  // executor; people/user and self/ are never writable from here. Only open +
  // addPiece reach the shared case-write entry (per-case lock, fresh read in
  // lock). Nothing is stamped into the text — the case→slice link is semantic.
  writeCase: tool({
    description:
      "Write a case document — one of your tools as the field agent (v0.21 " +
      "§2), for turns that produce a DOCUMENT before the answer. Use it when " +
      "the 成篇判据 hits: the content will be CAME BACK TO (the user will " +
      "re-raise it / it has a date anchor / it is an ongoing thread) OR it " +
      "cost real effort this turn (web searches, several slice reads, " +
      "multi-step reasoning) — a finished piece worth keeping. One-off Q&A " +
      "that nobody will revisit stays in the slice; do NOT write it here. " +
      "Discipline: call writeCase FIRST, then base your answer on the case " +
      "you just wrote, and cite the case path (<category>/<caseName>[/篇名]) " +
      "in the reply, the way you would mention a file. Categories: research/ " +
      "for an investigation, tasks/ for a commitment the user asked you to " +
      "carry out; people/user and self/ are not yours to write. Semantics: if " +
      "the case does not exist yet it is OPENED — body becomes the case's " +
      "index.md (the case name is permanent; name it for the QUESTION, " +
      "specific enough that a scope change means a new case). If it ALREADY " +
      "exists, pass pieceTitle to ADD one dated piece (《日期》标题》 rules " +
      "apply); omitting pieceTitle on an existing case is refused — this tool " +
      "never rewrites an index. What you write is exactly what lands: no " +
      "machine fields are added. If the piece should say where it came from " +
      "(which conversation, when), say it in prose.",
    inputSchema: z.object({
      category: z
        .enum(["research", "tasks"])
        .optional()
        .describe(
          "research/ for an investigation, tasks/ for a commitment to carry " +
          "out. Defaults to research.",
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
          "The WHOLE content to write: for open — the case's index 正文; " +
          "for addPiece — the piece's full text. Written verbatim.",
        ),
      pieceTitle: z
        .string()
        .optional()
        .describe(
          "Required when adding to an EXISTING case: the dated piece's " +
          "title (《日期》规则由机械层处理 — pass the bare title, e.g. " +
          "'报价篇'). Omit when opening a new case.",
        ),
    }),
    contextSchema: toolContextSchema,
    execute: writeCaseExecute,
  }),
  // The field→HQ channel (v0.21 §4): one-way prose report. The payload is
  // what the field sees plus its own observations — no expectations, no
  // instructions, no template; the return address is attached mechanically.
  // HQ is the same agent working without a mouth: it judges independently
  // what (if anything) the report is worth.
  reportToHQ: tool({
    description:
      "Report to HQ — hand the scene over to the archive/evolution side of " +
      "the house. This is a one-way dispatch: your brief is a piece of PLAIN " +
      "PROSE describing the situation and your own observations, written for " +
      "a colleague who was not in this conversation. No expectations, no " +
      "instructions, no template — HQ decides for itself what your report " +
      "is worth and what to do about it. It may act on it, file it, or " +
      "decide it needs nothing. It MAY speak back into a later turn of this " +
      "conversation — treat any such return as a bonus, never as something " +
      "you are owed or should wait for. The result only tells you the " +
      "report was dispatched (or why it was not).",
    inputSchema: z.object({
      brief: z
        .string()
        .min(1)
        .describe(
          "The whole report: the scene and your observations, in prose. " +
          "Pointers (slice ids, case paths) are worth more than summaries — " +
          "HQ reads the original records itself.",
        ),
    }),
    contextSchema: toolContextSchema,
    execute: reportToHQExecute,
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
  // The sediment mailbox PRODUCER (v0.15 design §3.1/§4.3). The reply segment
  // is "只读 + 记账" — this tool is the 记账, the ONE memory write the main
  // agent is granted: a single structured marker line into the current slice's
  // agent.md, consumed by the scribe/librarian passes at slice close.
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
      "is written at slice close by the passes that read these markers — so " +
      "after calling it, keep answering and treat the matter as NOT yet " +
      "recorded. Not for things belonging to the current conversation (they " +
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
          "The document's title (命名纪律: specific enough that a scope change means a new document).",
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
          "sediment only: an EXISTING case reference to update (分类/case名, from listTree/readDoc), when this updates one rather than opening one.",
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
      "Hand a research question to the web-research colleague — a sub-agent " +
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
      "`doc:<分类>/<case名>/<附件名>` for an image attachment stored in a " +
      "memory case (v0.19 §C.1). NOT for pages — use webFetch for those.",
    inputSchema: z.object({
      source: z
        .string()
        .describe(
          "Image source: an http(s) URL, 'attachment:N' referring to the Nth " +
          "image attachment of the current turn, or 'doc:<分类>/<case名>/<附件名>' " +
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
      "medium or high effort because the effort setting matters. (b) Parallel " +
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
      "yourself and dispatch a finer question. Tag each question with the " +
      "right effort: low = simple verification, medium = comparison, high = " +
      "structural analysis. A question worth thinking about deserves the " +
      "effort it deserves. Synthesize what comes back into your answer in " +
      "your own voice.",
    inputSchema: z.object({
      question: z
        .string()
        .describe("Self-contained question for the thinking pod. Include all necessary context, facts, AND the user's decision criteria — it has no tools and cannot look anything up."),
      effort: z
        .enum(["low", "medium", "high"])
        .optional()
        .describe("Reasoning intensity: 'low' for simple logical verification, 'medium' for a comparison, 'high' for structural analysis. Defaults to 'low'."),
    }),
    contextSchema: toolContextSchema,
    execute: thinkDeepExecute,
  }),
};

// ─── Client-mode-only tools (subscription bridge) ────────────────────────
//
// Registered ONLY in client mode (PREVIOUSLY_MODE=client): the bridge command
// is a local operator-controlled executable and cloud deployments must never
// expose it (doc/design/v0.9-client.md §2 — mode changes "who do I talk to",
// never identity). Chat-only, like webSearch/thinkDeep.
const delegateTaskTool = tool({
  description:
    "Delegate a self-contained task to the local subscription bridge — an " +
    "operator-installed adapter process that executes the task with the " +
    "user's own local tools/subscriptions and returns its stdout as the " +
    "result. Use it for work that needs something local rather than doing it " +
    "yourself. Embed everything the task needs in `task` and `context` — the " +
    "bridge has no access to your memory. On failure you get a structured " +
    "error with a reason (bridge-not-found / spawn-failed / timeout / " +
    "exit-code / empty-output) — report it honestly, then decide whether to " +
    "retry, rephrase, or do the work yourself.",
  inputSchema: z.object({
    task: z
      .string()
      .describe("Self-contained task instruction for the bridge to execute."),
    context: z
      .string()
      .optional()
      .describe("Supporting context the bridge needs (facts, constraints, inputs)."),
  }),
  contextSchema: toolContextSchema,
  execute: delegateTaskExecute,
});

/**
 * The chat tool set for this process: `chatTools`, plus the bridge dispatch
 * tool when running in client mode. Called at agent construction, inside the
 * workflow body — process.env is a frozen per-run snapshot there, so the mode
 * read is deterministic. The union return type (not an optional key) keeps
 * tool-call inference free of `undefined` for consumers like turn-workflow.
 */
export function getChatTools():
  | typeof chatTools
  | (typeof chatTools & { delegateTask: typeof delegateTaskTool }) {
  return isClientMode() ? { ...chatTools, delegateTask: delegateTaskTool } : chatTools;
}

// ─── toolsContext builders ───────────────────────────────────────────────

/** Same serializable chat context, fanned out to every chat tool by name. */
export function buildChatToolsContext(
  ctx: ToolContext,
): Record<keyof typeof chatTools, ToolContext> & { delegateTask?: ToolContext } {
  const contexts: Record<keyof typeof chatTools, ToolContext> = {
    readSlice: ctx,
    readAgentTimeline: ctx,
    readPreviously: ctx,
    listTree: ctx,
    readDoc: ctx,
    writeCase: ctx,
    reportToHQ: ctx,
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
  return isClientMode() ? { ...contexts, delegateTask: ctx } : contexts;
}

