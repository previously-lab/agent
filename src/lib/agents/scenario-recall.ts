import matter from "gray-matter";
import { z } from "zod";
import { runSubAgent } from "@/lib/agents/sub-agent-runner";
import { buildSubAgentSystem } from "@/lib/agents/prompts";
import { tool } from "@/lib/deepseek/tools";
import type { PrepareStepFunction } from "@/lib/deepseek/types";
import { parseTurns, type ParsedTurn } from "@/lib/episodic/turn-parser";
import { parseNativeSections } from "@/lib/markdown/native-sections";
import {
  NATIVE_REPLY_OMISSION_MARKER,
  projectNativeReplySemantics,
} from "@/lib/markdown/native-reply-semantics";
import type { ModelConfig } from "@/lib/models/registry";
import type { RecallBackend } from "@/lib/memory/facade";
import type { ScenarioRecallRequest } from "@/lib/chat/scenario-recall-contract";

const RECORD_REF_RE = /^records\/(\d{4}-\d{2}-\d{2}-\d{4})$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const NEW_CORE_RE = /^memory\/records\/(\d{4})\/(\d{2})\/(\d{2})\/(\d{4})\/core\.md$/;
const LEGACY_CORE_RE = /^memory\/episodic\/slices\/(\d{4})\/(\d{2})\/(\d{2})\/(\d{4})\/timeline\/core\.md$/;
const MAX_RECORD_READ_ATTEMPTS = 12;
const MAX_TOOL_CALLS = 12;
const MAX_SEARCH_NEW_READS = 6;
const MAX_SEARCH_SNIPPET_CHARS = 500;
const SEARCH_SNIPPET_BEFORE_CHARS = 160;
const MAX_LIST_RESULTS = 24;
const MAX_RAW_RECORD_CHARS = 200_000;
const MAX_READ_CONTENT_CHARS = 16_000;
const MAX_TURN_CONTENT_CHARS = 4_000;
const MAX_READ_TURNS = 8;
const MAX_EVIDENCE = 8;
const MAX_QUOTE_CHARS = 1_200;
const MAX_ANSWER_CHARS = 4_000;
const MAX_STEPS = 8;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 240_000;

export type ScenarioRecallStatus = "ok" | "insufficient_evidence" | "cancelled" | "timeout" | "error";
export type ScenarioRecallRole = "user" | "assistant";

export interface ScenarioRecallEvidence {
  ref: string;
  turnId?: string;
  role: ScenarioRecallRole;
  timestamp?: string;
  quote: string;
  note: string;
}

export interface ScenarioRecallCoverage {
  discovered: number;
  searched: string[];
  read: string[];
  omitted: number;
  notes: string[];
}

export interface ScenarioRecallResult {
  status: ScenarioRecallStatus;
  answer: string;
  evidence: ScenarioRecallEvidence[];
  coverage: ScenarioRecallCoverage;
  truncated: boolean;
  uncertainty: string[];
  error?: string;
}

export interface ScenarioRecallInput extends ScenarioRecallRequest {
  backend: RecallBackend;
  model?: ModelConfig;
  timezone?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

type RecordTurn = ParsedTurn & {
  role: ScenarioRecallRole;
  semanticContent: string;
};

type LoadedRecord = {
  ref: string;
  raw: string;
  turns: RecordTurn[];
  summary: string;
  sourceTruncated: boolean;
};

type VisibleOriginal = {
  ref: string;
  turn: RecordTurn;
  fragment: string;
};

type ReadState = {
  attempts: number;
  discovered: Set<string>;
  searched: string[];
  records: Map<string, LoadedRecord>;
  visible: VisibleOriginal[];
  readViews: Set<string>;
  errors: string[];
  notes: string[];
  truncated: boolean;
  listed: boolean;
};

const reportSchema = z.object({
  answer: z.string().max(6_000),
  evidence: z.array(z.object({
    ref: z.string().max(256),
    turnId: z.string().max(256).optional(),
    role: z.enum(["user", "assistant"]),
    quote: z.string().max(2_000),
    note: z.string().max(400).optional(),
  }).strict()).max(12).catch([]),
  uncertainty: z.array(z.string().max(500)).max(8).catch([]),
}).strict();

type RecallReport = z.infer<typeof reportSchema>;

const RECALL_ROLE = `You are the record-only recollection colleague. Recover what bears on the main agent's current question from ORIGINAL conversation core records, not from semantic documents.

Method:
- If known record refs are supplied, read those first. Otherwise use searchRecords for record summaries and keyword hits, or listRecords to enumerate a bounded time window, then readRecord on the strongest candidates.
- Only the supplied record tools exist. Never request cases, research, self documents, user cards, attachments, agent cognition, external search, or another recall agent.
- Condition every part of the answer on the question. Do not produce a generic biography, a transcript dump, or an unrequested summary of everything read.
- Summaries and search snippets are discovery aids. Before returning an exact quote, read the original record containing its user/assistant turn.
- Specific numbers, dates, promises, decisions, and who said what require exact record evidence. Distinguish the user's statements from the assistant's claims.
- Native HTML/JavaScript, generated controls and values, and omission markers are presentation, never evidence. Assistant semantic reads omit native HTML automatically; user bytes are not rewritten.
- Stop when the question is answered or the bounded search is exhausted. No evidence is an honest result, never a cue to invent or generalize a memory. Incomplete coverage is not proof of absence.

Report through scenarioRecallReport. Keep answer focused and in the user's language. Each evidence item must name its records/YYYY-MM-DD-HHMM ref, exact turnId and role, and a contiguous VERBATIM quote from that raw turn. Quotes from frontmatter, summaries, generated HTML, or a different turn will be rejected. Use uncertainty for missing context, contradictions, failed reads, and bounded coverage. This is read-only recollection: return no write receipt and claim no document update or write authority.`;

const RECALL_SYSTEM = buildSubAgentSystem(RECALL_ROLE);

function emptyCoverage(): ScenarioRecallCoverage {
  return { discovered: 0, searched: [], read: [], omitted: 0, notes: [] };
}

function outcome(
  status: ScenarioRecallStatus,
  error: string,
  coverage: ScenarioRecallCoverage = emptyCoverage(),
): ScenarioRecallResult {
  return {
    status,
    answer: "",
    evidence: [],
    coverage,
    truncated: status !== "error",
    uncertainty: [error],
    error,
  };
}

function sliceIdFromPath(path: string): string | null {
  const match = NEW_CORE_RE.exec(path) ?? LEGACY_CORE_RE.exec(path);
  return match ? `${match[1]}-${match[2]}-${match[3]}-${match[4]}` : null;
}

function recordPaths(ref: string): [string, string] | null {
  const match = RECORD_REF_RE.exec(ref);
  if (!match) return null;
  const [year, month, day, minute] = match[1]!.split("-");
  const rel = `${year}/${month}/${day}/${minute}`;
  return [
    `memory/records/${rel}/core.md`,
    `memory/episodic/slices/${rel}/timeline/core.md`,
  ];
}

function inWindow(ref: string, after?: string, before?: string): boolean {
  const date = ref.slice("records/".length, "records/".length + 10);
  return (!after || date >= after) && (!before || date <= before);
}

function roleOf(turn: ParsedTurn): ScenarioRecallRole | null {
  const role = /\((\w+)\)/.exec(turn.header)?.[1];
  if (role === "user") return "user";
  if (role === "agent" || role === "assistant") return "assistant";
  return null;
}

function summaryOf(raw: string): string {
  try {
    const data = matter(raw).data as Record<string, unknown>;
    const parts = ["focus", "summary"].flatMap((key) => {
      const value = data[key];
      return typeof value === "string" && value.trim() ? [`${key}: ${value.trim()}`] : [];
    });
    return parts.join("\n").slice(0, 600);
  } catch {
    return "";
  }
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;
}

function isCancelled(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}

function throwIfCancelled(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}

function validateInput(input: ScenarioRecallInput): string | null {
  if (typeof input.question !== "string" || !input.question.trim() || input.question.trim().length > 4_000) {
    return "question must contain 1..4000 characters";
  }
  if (input.refs !== undefined && (!Array.isArray(input.refs) || input.refs.length > 4)) {
    return "refs must be an array of at most four original record refs";
  }
  for (const ref of input.refs ?? []) {
    if (typeof ref !== "string" || !RECORD_REF_RE.test(ref)) {
      return `Refused non-record ref ${JSON.stringify(String(ref))}; only records/YYYY-MM-DD-HHMM is allowed`;
    }
  }
  for (const [key, value] of [["after", input.after], ["before", input.before]] as const) {
    if (value !== undefined && (typeof value !== "string" || !DATE_RE.test(value))) {
      return `${key} must be YYYY-MM-DD`;
    }
  }
  if (input.after && input.before && input.after > input.before) return "after must not be later than before";
  return null;
}

async function discoverRecords(
  backend: RecallBackend,
  state: ReadState,
  after?: string,
  before?: string,
  signal?: AbortSignal,
): Promise<string[]> {
  throwIfCancelled(signal);
  const paths = await backend.listMemoryFiles();
  throwIfCancelled(signal);
  for (const path of paths) {
    if (typeof path !== "string") continue;
    const sliceId = sliceIdFromPath(path);
    if (sliceId) {
      const ref = `records/${sliceId}`;
      if (inWindow(ref, after, before)) state.discovered.add(ref);
    }
  }
  state.listed = true;
  return [...state.discovered]
    .filter((ref) => inWindow(ref, after, before))
    .sort((a, b) => b.localeCompare(a));
}

async function loadRecord(
  backend: RecallBackend,
  ref: string,
  state: ReadState,
  signal?: AbortSignal,
): Promise<{ record?: LoadedRecord; error?: string }> {
  throwIfCancelled(signal);
  const cached = state.records.get(ref);
  if (cached) return { record: cached };
  const paths = recordPaths(ref);
  if (!paths) return { error: "Only an exact records/YYYY-MM-DD-HHMM ref can be read" };
  let lastError = "record not found";
  for (const path of paths) {
    throwIfCancelled(signal);
    if (state.attempts >= MAX_RECORD_READ_ATTEMPTS) {
      state.truncated = true;
      return { error: `Record read cap exhausted (${MAX_RECORD_READ_ATTEMPTS} backend reads)` };
    }
    state.attempts += 1;
    try {
      const source = await backend.readFile(path);
      throwIfCancelled(signal);
      const sourceTruncated = source.length > MAX_RAW_RECORD_CHARS;
      const raw = sourceTruncated ? source.slice(0, MAX_RAW_RECORD_CHARS) : source;
      const turns = parseTurns(raw).turns.flatMap((turn): RecordTurn[] => {
        const role = roleOf(turn);
        return role ? [{ ...turn, role, semanticContent: projectNativeReplySemantics(turn.content, role) }] : [];
      });
      const record: LoadedRecord = { ref, raw, turns, summary: summaryOf(raw), sourceTruncated };
      state.records.set(ref, record);
      if (sourceTruncated) {
        state.truncated = true;
        state.notes.push(`${ref} exceeded the raw-read bound; only its prefix was available`);
      }
      return { record };
    } catch (error) {
      if (isCancelled(signal) || (error instanceof Error && error.name === "AbortError")) throw error;
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  const note = `${ref}: ${clip(lastError, 240)}`;
  state.errors.push(note);
  state.truncated = true;
  return { error: `Could not read original record ${note}` };
}

type RenderedRecord = {
  view: Record<string, unknown>;
  receipts: VisibleOriginal[];
  truncated: boolean;
};

type RecordReadRange = {
  startTurn?: number;
  charOffset?: number;
  turnCount?: number;
};

/** Only real source prose intersecting the returned semantic window can authorize quotes. */
function visibleOriginalFragments(turn: RecordTurn, start: number, end: number): string[] {
  if (end <= start) return [];
  if (turn.role === "user") return [turn.content.slice(start, end)];
  const fragments: string[] = [];
  let semanticOffset = 0;
  for (const section of parseNativeSections(turn.content)) {
    const length = section.kind === "native" ? NATIVE_REPLY_OMISSION_MARKER.length : section.raw.length;
    if (section.kind === "markdown") {
      const from = Math.max(start, semanticOffset);
      const to = Math.min(end, semanticOffset + length);
      if (to > from) fragments.push(section.raw.slice(from - semanticOffset, to - semanticOffset));
    }
    semanticOffset += length;
    if (semanticOffset >= end) break;
  }
  return fragments;
}

function renderRecord(record: LoadedRecord, range: RecordReadRange = {}): RenderedRecord {
  const startTurn = range.startTurn ?? 0;
  const charOffset = range.charOffset ?? 0;
  const turnCount = range.turnCount ?? MAX_READ_TURNS;
  const firstIndex = record.turns.findIndex((turn) => turn.index >= startTurn);
  const first = firstIndex >= 0 ? record.turns[firstIndex] : undefined;
  const invalid = !first
    ? `startTurn ${startTurn} is outside the record`
    : charOffset > 0 && first.index !== startTurn
      ? "charOffset requires the exact startTurn ordinal"
      : charOffset > first.semanticContent.length
        ? `charOffset ${charOffset} exceeds the selected turn's semantic length ${first.semanticContent.length}`
        : null;
  if (invalid) return { view: { ref: record.ref, error: invalid }, receipts: [], truncated: false };
  let remaining = MAX_READ_CONTENT_CHARS;
  let processed = 0;
  let next: { startTurn: number; charOffset: number } | null = null;
  const turns: Array<Record<string, unknown>> = [];
  const receipts: VisibleOriginal[] = [];
  for (let index = firstIndex; index < record.turns.length; index += 1) {
    const turn = record.turns[index]!;
    if (processed >= turnCount || remaining <= 0) {
      next = { startTurn: turn.index, charOffset: 0 };
      break;
    }
    const offset = processed === 0 ? charOffset : 0;
    const available = turn.semanticContent.length - offset;
    const budget = Math.min(MAX_TURN_CONTENT_CHARS, remaining);
    const clipped = available > budget;
    const endOffset = clipped ? offset + Math.max(0, budget - 1) : turn.semanticContent.length;
    const fragment = turn.semanticContent.slice(offset, endOffset);
    const content = clipped ? `${fragment}…` : fragment;
    remaining -= content.length;
    turns.push({
      turnId: turn.turnId,
      turnIndex: turn.index,
      role: turn.role,
      timestamp: turn.timestamp,
      charOffset: offset,
      endOffset,
      content,
      contentTruncated: clipped,
      hasMore: endOffset < turn.semanticContent.length,
    });
    for (const original of visibleOriginalFragments(turn, offset, endOffset)) {
      receipts.push({ ref: record.ref, turn, fragment: original });
    }
    processed += 1;
    if (clipped) {
      next = { startTurn: turn.index, charOffset: endOffset };
      break;
    }
  }
  const omittedTurns = Math.max(0, record.turns.length - firstIndex - processed);
  const truncated = record.sourceTruncated || firstIndex > 0 || charOffset > 0 || next !== null;
  return {
    view: {
      ref: record.ref,
      summary: record.summary || undefined,
      range: { startTurn, charOffset, turnCount },
      totalTurns: record.turns.length,
      skippedTurns: firstIndex,
      turns,
      omittedTurns,
      next,
      truncated,
      note: truncated ? "Targeted/bounded view; only returned fragments are citable. Follow next to read more." : undefined,
    },
    receipts,
    truncated,
  };
}

function verifyEvidence(report: RecallReport, state: ReadState): {
  evidence: ScenarioRecallEvidence[];
  rejected: number;
  overflow: number;
} {
  const evidence: ScenarioRecallEvidence[] = [];
  const seen = new Set<string>();
  let rejected = 0;
  let overflow = 0;
  for (const candidate of report.evidence) {
    if (evidence.length >= MAX_EVIDENCE) {
      overflow += 1;
      continue;
    }
    const quote = candidate.quote.trim();
    if (!quote || quote.length > MAX_QUOTE_CHARS) {
      rejected += 1;
      continue;
    }
    const matches = state.visible.filter((visible) =>
      visible.ref === candidate.ref &&
      visible.turn.role === candidate.role &&
      (!candidate.turnId || visible.turn.turnId === candidate.turnId) &&
      visible.turn.content.includes(quote) &&
      visible.turn.semanticContent.includes(quote) &&
      visible.fragment.includes(quote));
    const turn = matches[0]?.turn;
    if (!turn || matches.some((visible) => visible.turn !== turn)) {
      rejected += 1;
      continue;
    }
    const key = `${candidate.ref}\0${turn.index}\0${quote}`;
    if (seen.has(key)) continue;
    seen.add(key);
    evidence.push({
      ref: candidate.ref,
      ...(turn.turnId ? { turnId: turn.turnId } : {}),
      role: turn.role,
      ...(turn.timestamp ? { timestamp: turn.timestamp } : {}),
      quote,
      note: clip(candidate.note?.trim() || "Supports the focused recollection.", 300),
    });
  }
  return { evidence, rejected, overflow };
}

function finishCoverage(state: ReadState): ScenarioRecallCoverage {
  return {
    discovered: state.discovered.size,
    searched: [...state.searched],
    read: [...state.readViews],
    omitted: Math.max(0, state.discovered.size - state.readViews.size),
    notes: [...new Set(state.notes)].slice(0, 8).map((note) => clip(note, 300)),
  };
}

export async function runScenarioRecall(input: ScenarioRecallInput): Promise<ScenarioRecallResult> {
  const invalid = validateInput(input);
  if (invalid) return outcome("error", invalid);
  if (isCancelled(input.signal)) return outcome("cancelled", "Recollection was cancelled before it started; this is not evidence of absence");
  const question = input.question.trim();
  const knownRefs = [...new Set(input.refs ?? [])];
  const timeoutMs = Number.isFinite(input.timeoutMs)
    ? Math.min(MAX_TIMEOUT_MS, Math.max(1_000, Math.floor(input.timeoutMs!)))
    : DEFAULT_TIMEOUT_MS;
  const deadlineSignal = AbortSignal.timeout(timeoutMs);
  const signal = input.signal ? AbortSignal.any([input.signal, deadlineSignal]) : deadlineSignal;
  const state: ReadState = {
    attempts: 0,
    discovered: new Set(knownRefs.filter((ref) => inWindow(ref, input.after, input.before))),
    searched: [],
    records: new Map(),
    visible: [],
    readViews: new Set(),
    errors: [],
    notes: [],
    truncated: false,
    listed: false,
  };
  let toolCalls = 0;
  const takeToolCall = (): boolean => {
    if (toolCalls >= MAX_TOOL_CALLS) {
      state.truncated = true;
      return false;
    }
    toolCalls += 1;
    return true;
  };
  const candidates = async (after?: string, before?: string): Promise<string[]> => {
    throwIfCancelled(signal);
    if (!state.listed) {
      try {
        await discoverRecords(input.backend, state, input.after, input.before, signal);
      } catch (error) {
        state.errors.push(`record enumeration: ${clip(error instanceof Error ? error.message : String(error), 240)}`);
        state.truncated = true;
        throw error;
      }
    }
    return [...state.discovered]
      .filter((ref) => inWindow(ref, input.after, input.before) && inWindow(ref, after, before))
      .sort((a, b) => b.localeCompare(a));
  };
  const tools = {
    listRecords: tool({
      description: "Enumerate original conversation record refs only. No document refs or file paths are exposed. Dates are inclusive UTC slice-date bounds.",
      inputSchema: z.object({
        after: z.string().regex(DATE_RE).optional(),
        before: z.string().regex(DATE_RE).optional(),
        offset: z.number().int().min(0).max(10_000).optional(),
      }).strict(),
      execute: async ({ after, before, offset = 0 }: { after?: string; before?: string; offset?: number }) => {
        throwIfCancelled(signal);
        if (!takeToolCall()) return { error: `Tool call cap exhausted (${MAX_TOOL_CALLS})` };
        const refs = await candidates(after, before);
        const page = refs.slice(offset, offset + MAX_LIST_RESULTS);
        return {
          refs: page,
          total: refs.length,
          nextOffset: offset + page.length < refs.length ? offset + page.length : undefined,
          truncated: offset + page.length < refs.length,
        };
      },
    }),
    searchRecords: tool({
      description: "Scan a bounded set of original core records for a keyword and inspect their record summaries. Returns matches plus scanned summaries; a miss is not proof of absence.",
      inputSchema: z.object({
        query: z.string().trim().min(1).max(300),
        after: z.string().regex(DATE_RE).optional(),
        before: z.string().regex(DATE_RE).optional(),
      }).strict(),
      execute: async ({ query, after, before }: { query: string; after?: string; before?: string }) => {
        throwIfCancelled(signal);
        if (!takeToolCall()) return { error: `Tool call cap exhausted (${MAX_TOOL_CALLS})` };
        const refs = await candidates(after, before);
        const needle = query.toLocaleLowerCase();
        const entries: Array<Record<string, unknown>> = [];
        let newReads = 0;
        let skipped = 0;
        for (const ref of refs) {
          if (!state.records.has(ref) && newReads >= MAX_SEARCH_NEW_READS) {
            skipped += 1;
            continue;
          }
          const wasCached = state.records.has(ref);
          const loaded = await loadRecord(input.backend, ref, state, signal);
          if (!loaded.record) {
            if (loaded.error?.includes("read cap")) {
              state.truncated = true;
              skipped += 1;
              break;
            }
            continue;
          }
          if (!wasCached) newReads += 1;
          if (!state.searched.includes(ref)) state.searched.push(ref);
          const matchingTurns = loaded.record.turns.flatMap((turn) => {
            const matchOffset = turn.semanticContent.toLocaleLowerCase().indexOf(needle);
            return matchOffset >= 0 ? [{ turn, matchOffset }] : [];
          });
          const matched = loaded.record.summary.toLocaleLowerCase().includes(needle) || matchingTurns.length > 0;
          if (matched) {
            entries.push({
              ref,
              summary: loaded.record.summary || undefined,
              excerpts: matchingTurns.slice(0, 2).map(({ turn, matchOffset }) => {
                const snippetStart = Math.max(0, matchOffset - SEARCH_SNIPPET_BEFORE_CHARS);
                const snippetEnd = Math.min(turn.semanticContent.length, snippetStart + MAX_SEARCH_SNIPPET_CHARS);
                return {
                  turnIndex: turn.index,
                  turnId: turn.turnId,
                  role: turn.role,
                  matchOffset,
                  snippetStart,
                  snippetEnd,
                  snippet: turn.semanticContent.slice(snippetStart, snippetEnd),
                };
              }),
            });
          }
          if (entries.length >= 8) {
            skipped = Math.max(skipped, refs.length - state.searched.length);
            break;
          }
        }
        if (skipped > 0) state.truncated = true;
        return {
          query,
          matches: entries,
          scanned: state.searched.length,
          skipped,
          readAttemptsRemaining: Math.max(0, MAX_RECORD_READ_ATTEMPTS - state.attempts),
          note: "Summaries and excerpts locate candidates; call readRecord before citing. No match here is not absence.",
        };
      },
    }),
    readRecord: tool({
      description: "Read a bounded ORIGINAL core record view. startTurn is a 0-based source ordinal; charOffset is within that turn's semantic surface; turnCount max 8. Follow next to continue. Only returned fragments are citable.",
      inputSchema: z.object({
        ref: z.string().trim().min(1).max(256),
        startTurn: z.number().int().min(0).max(100_000).optional(),
        charOffset: z.number().int().min(0).max(200_000).optional(),
        turnCount: z.number().int().min(1).max(MAX_READ_TURNS).optional(),
      }).strict(),
      execute: async ({ ref, startTurn, charOffset, turnCount }: {
        ref: string;
        startTurn?: number;
        charOffset?: number;
        turnCount?: number;
      }) => {
        throwIfCancelled(signal);
        if (!takeToolCall()) return { error: `Tool call cap exhausted (${MAX_TOOL_CALLS})` };
        if (!RECORD_REF_RE.test(ref) || !inWindow(ref, input.after, input.before)) {
          return { error: "Refused: expected an in-window records/YYYY-MM-DD-HHMM ref; documents, paths and encoded traversal are not readable" };
        }
        state.discovered.add(ref);
        const loaded = await loadRecord(input.backend, ref, state, signal);
        if (!loaded.record) return { error: loaded.error };
        const rendered = renderRecord(loaded.record, { startTurn, charOffset, turnCount });
        if (rendered.view.error !== undefined) return rendered.view;
        throwIfCancelled(signal);
        state.readViews.add(ref);
        state.visible.push(...rendered.receipts);
        if (rendered.truncated) {
          state.truncated = true;
          state.notes.push(`${ref} targeted/bounded readRecord view; clipped or omitted turns and hidden text are not evidence`);
        }
        return rendered.view;
      },
    }),
    scenarioRecallReport: tool({
      description: "Finish with a focused answer, exact original-turn evidence, and explicit uncertainty. No write receipts.",
      inputSchema: reportSchema,
    }),
  };
  const prepareStep: PrepareStepFunction = ({ stepNumber }) => {
    throwIfCancelled(signal);
    return stepNumber >= MAX_STEPS - 1
      ? {
          system: `${RECALL_SYSTEM}\n\nThis is the final step. Call scenarioRecallReport now with the verified evidence already read and explicit gaps. Do not search or read again, and do not substitute prose for the report.`,
          activeTools: ["scenarioRecallReport"],
          toolChoice: "auto",
        }
      : undefined;
  };
  const prompt = `Main agent's focused question:\n${question}\n\n${knownRefs.length ? `Known original record refs (read these first): ${knownRefs.join(", ")}` : "No known record refs: locate candidates with searchRecords or listRecords."}\nUTC slice-date window: ${input.after ?? "unbounded"} through ${input.before ?? "unbounded"}.\n${input.timezone ? `User timezone context: ${input.timezone}. Do not reinterpret record refs as local wall-clock timestamps.` : ""}\n\nAnswer only what this question asks. Finish with scenarioRecallReport; if the evidence is insufficient, say so rather than inventing a memory.`;
  try {
    const result = await runSubAgent<RecallReport>({
      model: input.model,
      role: "recall",
      system: RECALL_SYSTEM,
      prompt,
      tools,
      toolChoice: "auto",
      reportToolName: "scenarioRecallReport",
      reportSchema,
      maxSteps: MAX_STEPS,
      prepareStep,
      timeoutMs,
      abortSignal: signal,
    });
    if (isCancelled(input.signal)) {
      return outcome("cancelled", "Recollection was cancelled; partial exploration is not evidence of absence", finishCoverage(state));
    }
    if (deadlineSignal.aborted) {
      return outcome("timeout", "Recollection timed out; partial exploration is not evidence of absence", finishCoverage(state));
    }
    if (!result.ok) {
      const status = result.timedOut ? "timeout" : "error";
      const error = result.timedOut
        ? "Recollection timed out; no completed evidence-checked report was produced"
        : `Recollection model failed: ${clip(result.error ?? "unknown error", 300)}`;
      return outcome(status, error, finishCoverage(state));
    }
    if (!result.report) {
      return outcome("error", "Recollection ended without a valid structured report; its prose was not promoted to memory", finishCoverage(state));
    }
    const verified = verifyEvidence(result.report, state);
    const citationGap = verified.rejected > 0 || verified.overflow > 0;
    const uncertainty = result.report.uncertainty
      .map((item) => clip(item.trim(), 300))
      .filter(Boolean)
      .slice(0, 2);
    if (verified.rejected > 0) uncertainty.push(`${verified.rejected} unverified evidence item(s) were discarded`);
    if (verified.overflow > 0) uncertainty.push(`${verified.overflow} evidence item(s) exceeded the output cap`);
    for (const note of state.notes.slice(0, 2)) uncertainty.push(note);
    for (const error of state.errors.slice(0, 2)) uncertainty.push(`Read failure: ${error}`);
    if (state.truncated) uncertainty.push("Coverage was bounded or truncated; absence is not established");
    if (state.readViews.size === 0) uncertainty.push("No original turn was returned by a successful readRecord view");
    let answer = result.report.answer.trim();
    if (citationGap) {
      answer = "";
      uncertainty.push("The derived answer was suppressed because not all citations passed visible-original verification");
    }
    if (answer.length > MAX_ANSWER_CHARS) {
      answer = clip(answer, MAX_ANSWER_CHARS);
      state.truncated = true;
      uncertainty.push("The answer exceeded the output bound and was shortened");
    }
    const failedWithoutEvidence = verified.evidence.length === 0 && state.errors.length > 0;
    const status: ScenarioRecallStatus = failedWithoutEvidence
      ? "error"
      : verified.evidence.length > 0 && !citationGap
        ? "ok"
        : "insufficient_evidence";
    if (status === "error") answer = "";
    if (status === "insufficient_evidence" && answer) {
      uncertainty.push("No fully verified grounded answer was produced; treat this narrative as unverified");
    }
    const coverage = finishCoverage(state);
    const truncated = state.truncated || coverage.omitted > 0 || verified.overflow > 0;
    return {
      status,
      answer,
      evidence: verified.evidence,
      coverage,
      truncated,
      uncertainty: [...new Set(uncertainty)].slice(0, 8),
      ...(status === "error" ? { error: "Original record reads failed; no reliable recollection was produced" } : {}),
    };
  } catch (error) {
    if (isCancelled(input.signal)) {
      return outcome("cancelled", "Recollection was cancelled; partial exploration is not evidence of absence", finishCoverage(state));
    }
    if (deadlineSignal.aborted || (error instanceof Error && (error.name === "TimeoutError" || error.name === "StepTimeoutError"))) {
      return outcome("timeout", "Recollection timed out before completion; this is not evidence of absence", finishCoverage(state));
    }
    return outcome("error", `Recollection failed: ${clip(error instanceof Error ? error.message : String(error), 300)}`, finishCoverage(state));
  }
}
