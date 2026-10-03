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
  readSliceSummaryExecute,
  readTimelineWindowExecute,
  listSlicesExecute,
  readTimelineExecute,
  readStrandExecute,
  listStrandsExecute,
  readAgentTimelineExecute,
  readPreviouslyExecute,
  webSearchExecute,
  webFetchExecute,
  recallExecute,
  thinkDeepExecute,
  currentTimeExecute,
  describeRoomExecute,
  delegateTaskExecute,
  viewImageExecute,
  listDocsExecute,
  readDocExecute,
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
  // The turn's resolved MAIN model — all sub-agents (thinkDeep, recall, …)
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
      "Open a time slice's original conversation record (core timeline). " +
      "VERIFICATION CHANNEL ONLY — past memory is recall's job: ask it in " +
      "natural language and it reads the slices for you. Open a slice " +
      "yourself only to verify one of recall's references or when you need " +
      "the verbatim original text. " +
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
  readSliceSummary: tool({
    description:
      "Read a slice's summary (frontmatter only): focus, summary, tags, tone, " +
      "turn count, open loops, decisions. The CHEAPEST way to check what a " +
      "slice is about before reading any turns. Prefer this over readSlice for " +
      "relevance checks; only read turns (readSlice with a range) when the " +
      "summary says the exact content matters.",
    inputSchema: z.object({
      sliceId: z
        .string()
        .describe("Slice ID in YYYY-MM-DD-HHMM format, e.g. '2026-07-24-1500'."),
    }),
    contextSchema: toolContextSchema,
    execute: readSliceSummaryExecute,
  }),
  readTimelineWindow: tool({
    description:
      "Read the timeline catalog over a date window (inclusive, YYYY-MM-DD) — " +
      "one compact pointer line per slice (id · focus · tags · turns). " +
      "Use this to orient by time: 'what happened this week / last month', or " +
      "when the user references a period. A line is a pointer, not content — " +
      "open a slice with readSliceSummary / readSlice when it looks relevant.",
    inputSchema: z.object({
      from: z
        .string()
        .optional()
        .describe("Start date YYYY-MM-DD (inclusive). Omit for 'from the beginning'."),
      to: z
        .string()
        .optional()
        .describe("End date YYYY-MM-DD (inclusive). Omit for 'up to now'."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe("Max slices to list (default 20)."),
    }),
    contextSchema: toolContextSchema,
    execute: readTimelineWindowExecute,
  }),
  listSlices: tool({
    description:
      "Browse time slice directories to see what slices exist. " +
      "Use this to explore available time slices for a given year and month.",
    inputSchema: z.object({
      year: z
        .number()
        .int()
        .min(2000)
        .max(2100)
        .optional()
        .describe("Year. Defaults to the current year."),
      month: z
        .number()
        .min(1)
        .max(12)
        .optional()
        .describe("Month (1-12). Defaults to the current month."),
    }),
    contextSchema: toolContextSchema,
    execute: listSlicesExecute,
  }),
  readTimeline: tool({
    description:
      "Read a monthly timeline index — lists every slice in that month " +
      "with its focus, summary, and tags. Use this to get a high-level " +
      "overview before deciding which slices to read in full.",
    inputSchema: z.object({
      year: z.number().int().min(2000).max(2100),
      month: z.number().min(1).max(12),
    }),
    contextSchema: toolContextSchema,
    execute: readTimelineExecute,
  }),
  readStrand: tool({
    description:
      "Follow a strand — a keyword tag that threads through multiple " +
      "time slices. Returns all slice paths carrying that tag. " +
      "Use this to trace a topic across time.",
    inputSchema: z.object({
      strand: z
        .string()
        .describe("The strand (tag) to follow, e.g. 'rust', 'loop-testing'."),
    }),
    contextSchema: toolContextSchema,
    execute: readStrandExecute,
  }),
  listStrands: tool({
    description:
      "List all known strands — every keyword tag that has been " +
      "woven through time slices. Use this to discover what topics exist.",
    inputSchema: z.object({}),
    contextSchema: toolContextSchema,
    execute: listStrandsExecute,
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
// The CHAT agent owns the TIME AXIS of memory AND the document layer
// (v0.15 design §4.2 — there is no recall-style sub-agent between the main
// agent and memory on the read path).
//
// Memory surface:
//   - readTimelineWindow: scan the timeline catalog over a date window
//     (inclusive YYYY-MM-DD), one compact pointer line per slice. This is YOUR
//     tool when the user's question carries an explicit time anchor ("last
//     week", "September 3rd", "in March"). Scope the window, then open the
//     specific slice with readSlice.
//   - readSlice: point-read the original slice text — the VERIFICATION
//     channel and the only source for specific facts (numbers, dates, quotes,
//     promises). Use `range` to fetch only the turns you need.
//   - readSliceSummary: the cheapest relevance check (frontmatter only) —
//     prefer it over readSlice when you only need to know what a slice is
//     about.
//   - readAgentTimeline: your own past cognition for a slice. listSlices /
//     readTimeline / readStrand / listStrands: directory-level browse of the
//     slice archive and the strand (tag) index.
//   - listDocs / readDoc: the DOCUMENT layer — directory listing and
//     path-agnostic point-read by file name. Documents are the amortized
//     products of past investigation; slices remain the evidence.
//   - noteForSediment: the sediment mailbox — the reply segment's ONE write
//     (只读 + 记账, design §4.3): drop a marker line for the slice-close
//     scribe/librarian passes. Bookkeeping, never document-writing.
//
// Topic-axis / unanchored questions go DIRECTLY to recall — never investigate
// first and then escalate. If the question has NO time anchor ("did we ever
// talk about apples?", fuzzy memories, cross-topic synthesis), call recall
// immediately. If you realize mid-scan that the time axis can't settle it,
// stop and call recall rather than continuing to dig.
export const chatTools = {
  readSlice: conceptTools.readSlice,
  readTimelineWindow: conceptTools.readTimelineWindow,
  readPreviously: conceptTools.readPreviously,
  // Slice-level browse tools reclaimed by the main agent (v0.15 design §4.2 —
  // the charter always said "you own the time axis"; recall's retirement is
  // adjudicated by the §7 signal, but the read surface is the main agent's
  // now, not a sub-agent's). listStrands/readStrand fold into
  // listDocs("topic")/readDoc over time; they stay exposed meanwhile.
  readSliceSummary: conceptTools.readSliceSummary,
  readAgentTimeline: conceptTools.readAgentTimeline,
  listSlices: conceptTools.listSlices,
  readTimeline: conceptTools.readTimeline,
  readStrand: conceptTools.readStrand,
  listStrands: conceptTools.listStrands,
  // Document-system readers (v0.15 design §4.2): the filesystem IS the index
  // — listDocs is a plain directory listing, readDoc a path-agnostic
  // point-read by file name.
  listDocs: tool({
    description:
      "List the documents in one document-type directory — a plain directory " +
      "listing, nothing more. The nine types (closed set): event, person, " +
      "object, place, org, research, hypothesis, task (file name = " +
      "<birth-date>-<title>.md) and topic (file name = <name>.md, the topic " +
      "homes). File names are returned in ascending order — for the dated " +
      "kinds that IS birth order. There is no ranking and no relevance " +
      "score: the list itself (date + title) is the index, read it yourself. " +
      "Use this to discover what documents exist: listDocs('research') shows " +
      "every investigation on file; listDocs('topic') lists every topic home " +
      "(the semantic strand index — a home's prose says what it is also " +
      "called); listDocs('task') shows tracked tasks. Then open the document " +
      "you want with readDoc. An empty list means the type has no documents " +
      "yet — that is normal while the doc layer is young.",
    inputSchema: z.object({
      kind: z
        .enum(["event", "person", "object", "place", "org", "research", "hypothesis", "task", "topic"])
        .describe("The document-type directory to list."),
      filter: z
        .string()
        .optional()
        .describe(
          "Optional case-insensitive substring filter on the file name, e.g. '手机'. Mechanical match only — no semantics.",
        ),
    }),
    contextSchema: toolContextSchema,
    execute: listDocsExecute,
  }),
  readDoc: tool({
    description:
      "Read a whole document by its FILE NAME (the file name IS the identity " +
      "— pass '2026-09-05-手机购买调研' or '用户手机', with or without .md, " +
      "never a path). Resolution is path-agnostic: the file is found " +
      "wherever it lives under docs/. Documents are small files — the whole " +
      "file is returned: the machine header (status / opened / updated), the " +
      "截至 block stating what the document currently believes, and the " +
      "dated entry stream. Judge freshness yourself from those dates — " +
      "contradictions between documents are time, read them newest-first. " +
      "Grounding rule applies: a document may summarize, but specific facts " +
      "(numbers, dates, quotes, promises) enter your answers only from the " +
      "original slice text — the document's job is to point you at the right " +
      "slice fast. If the name resolves nowhere you get a dead-link error " +
      "saying so — not blocking; run listDocs to see what exists.",
    inputSchema: z.object({
      fileName: z
        .string()
        .describe(
          "Document file name, e.g. '2026-09-05-手机购买调研' or '用户手机' (with or without .md).",
        ),
    }),
    contextSchema: toolContextSchema,
    execute: readDocExecute,
  }),
  // The sediment mailbox PRODUCER (v0.15 design §3.1/§4.3). The reply segment
  // is "只读 + 记账" — this tool is the 记账, the ONE memory write the main
  // agent is granted: a single structured marker line into the current slice's
  // agent.md, consumed by the scribe/librarian passes at slice close.
  noteForSediment: tool({
    description:
      "Jot a note for LATER sedimentation — BOOKKEEPING, NOT writing a document. " +
      "Use it the moment you think, mid-conversation, \"this is worth " +
      "sedimenting\" or \"this should become a task\": a search/recall worth " +
      "keeping as a research or entity document (kind: 'sediment'), something " +
      "the user said that anchors a date — \"我 8 号要去 on-site\", " +
      "\"下周三提醒我…\" — which must become a tracked task document (kind: " +
      "'task', always pass dateAnchor), or an open thread the background " +
      "research colleague should investigate later (kind: 'question'). It " +
      "appends ONE structured marker line to THIS slice's agent.md mailbox; " +
      "the actual document gets written at slice close by the scribe/librarian " +
      "passes that read these markers — so after calling this, keep answering " +
      "and do NOT treat the thing as recorded yet. Do NOT use it for anything " +
      "in the current conversation (that lives in the slice itself), and do " +
      "NOT call it for trivia — a one-off mention stays in the slices. " +
      "title follows the document naming discipline: specific enough that a " +
      "scope change would mean a NEW document.",
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
          "sediment only: an EXISTING document file name to append to " +
          "(from a listDocs/readDoc), when this updates one rather than opening one.",
        ),
      dateAnchor: z
        .string()
        .optional()
        .describe("task only: the date the user stated, YYYY-MM-DD."),
      topics: z
        .array(z.string())
        .optional()
        .describe(
          "Existing topic strands (strands.json keys) this belongs to — only names you have seen.",
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
  recall: tool({
    description:
      "Ask the recall colleague — a sub-agent who owns the TOPIC AXIS of " +
      "memory and deep investigation. Use recall DIRECTLY for questions with " +
      "NO explicit time anchor: topic-shaped queries (\"did we ever talk about " +
      "apples?\"), fuzzy memories, cross-topic synthesis, or anything the time " +
      "axis cannot settle. Do NOT browse memory first and then escalate — if " +
      "the question is hard for readTimelineWindow + readSlice, recall is the " +
      "first move, not the fallback. For questions WITH an explicit time anchor " +
      "(\"last week\", \"September 3rd\", \"in March\"), use readTimelineWindow + " +
      "readSlice yourself; if you realize mid-scan that the time axis can't " +
      "answer it, stop and call recall. Ask in natural language, colleague to " +
      "colleague, and refer to the user in the THIRD PERSON — the colleague is " +
      "not the user, and it describes the user back to you in the third person " +
      "too. Every situational claim in its answer carries a reference with a " +
      "VERBATIM quote and the slice id — those references are attached for your " +
      "audit. An honest \"we haven't talked about this\" is a valid, definitive " +
      "answer: when it says so, do NOT call recall again for the same topic. " +
      "Open a slice yourself (readSlice) only when you need to verify one of its " +
      "references or need more of the original text.",
    inputSchema: z.object({
      question: z
        .string()
        .describe("A natural-language question about past conversations, asked colleague to colleague. Be specific about the topic, person, event, or period you are asking about."),
      context: z
        .string()
        .optional()
        .describe(
          "What you already established on the core timeline before asking: " +
          "windows you scanned, pointer lines you saw, and why that is not " +
          "enough. Saves the recall colleague from redoing your work.",
        ),
    }),
    contextSchema: toolContextSchema,
    execute: recallExecute,
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
      "use an http(s) URL or `attachment:N` where N is the attachment number " +
      "from the placeholder in the user's message. NOT for pages — use webFetch " +
      "for those.",
    inputSchema: z.object({
      source: z
        .string()
        .describe(
          "Image source: an http(s) URL, or 'attachment:N' referring to the Nth " +
          "image attachment of the current turn.",
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
// never identity). Chat-only, like recall/webSearch.
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
    readTimelineWindow: ctx,
    readPreviously: ctx,
    readSliceSummary: ctx,
    readAgentTimeline: ctx,
    listSlices: ctx,
    readTimeline: ctx,
    readStrand: ctx,
    listStrands: ctx,
    listDocs: ctx,
    readDoc: ctx,
    noteForSediment: ctx,
    describeRoom: ctx,
    currentTime: ctx,
    recall: ctx,
    webSearch: ctx,
    webFetch: ctx,
    viewImage: ctx,
    thinkDeep: ctx,
  };
  // Keep the context map in lockstep with getChatTools(): a registered tool
  // must never lack its context entry.
  return isClientMode() ? { ...contexts, delegateTask: ctx } : contexts;
}

