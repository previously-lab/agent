/**
 * Web research — provider adapters behind a neutral contract.
 *
 * The webSearch tool's interface (query in → answer + sources + researcher's
 * confidence/controversies out) is OURS; nothing DeepSeek- or
 * Anthropic-shaped may leak out of this module. Today there is one adapter:
 * DeepSeek V4 Flash's native server-side search, reached through DeepSeek's
 * Anthropic-compatible endpoint (the OpenAI-compatible /v1 endpoint cannot
 * express provider-executed tools). Future adapters (Claude native webSearch,
 * Tavily for keyless demo) drop in behind the same contract and MUST also
 * produce the `recommendation` field.
 *
 * The search sub-agent is an independent RESEARCHER (v1.0): it searches
 * (web_search, provider-executed on DeepSeek's servers), then reads the most
 * promising pages ITSELF with its own quota-bounded `webFetch` tool
 * (implemented in-module via fetch-utils + the Document Segment Read
 * helpers), and synthesizes a real answer that combines the found material
 * with its own knowledge — web claims always carry a source mention.
 *
 * DeepSeek adapter specifics (not the contract — just this adapter):
 * - `web_search` is executed on DeepSeek's servers, which ingest the full
 *   page content during inference; the caller only ever sees the model's
 *   synthesized answer + citation URLs. The sub-agent's own `webFetch` closes
 *   the depth gap: pages that matter get read directly, on our side.
 * - `webSearch_20260209` is the @ai-sdk/anthropic SDK's method name for the
 *   provider-executed search tool, not our versioning — the SDK version is
 *   the authority for when to update it.
 *
 * @security — provider coupling. webSearch is currently a DEEPSEEK-ONLY
 * capability: this adapter always reaches `api.deepseek.com` and always needs
 * a `DEEPSEEK_API_KEY`, INDEPENDENT of the user's chosen chat model. If a
 * deployment's user selects Anthropic/OpenAI as the main model but omits
 * `DEEPSEEK_API_KEY`, webSearch will error rather than silently degrade.
 * A non-DeepSeek deployment must either (a) provide a `DEEPSEEK_API_KEY` for
 * this infra call, or (b) add a new adapter behind the `WebSearchResult`
 * contract (e.g. Claude native webSearch, Tavily) and dispatch on it here.
 * Do NOT let a missing key crash the turn — `webSearchExecute` gates on it
 * and returns a user-facing error string before any model call runs.
 *
 * Model roles: this is an INFRASTRUCTURE model call (like recall in
 * lib/episodic/flash/recall.ts) — the user-facing Pro model choice is not
 * affected. The call itself runs on the unified sub-agent runner
 * (src/lib/agents/sub-agent-runner.ts): thinking ON at effort "low" (via the
 * Anthropic-shaped effort mapping — this adapter speaks the Anthropic
 * protocol), EXPLICIT output/thinking budgets (the compat endpoint's 4096 /
 * 1024 defaults silently truncated reports — see SEARCH_MAX_OUTPUT_TOKENS),
 * a 50-step cap, and a 240s wall-clock budget (sized for the 6-page read
 * quota). The provider path is unchanged: the runner receives a PRE-BUILT
 * model instance so the custom endpoint + normalizing fetch stay exactly as
 * they were.
 */
import { createAnthropic } from "@ai-sdk/anthropic";
import { tool, type PrepareStepFunction, type ToolSet } from "ai";
import { z } from "zod";
import {
  runSubAgent,
  type SubAgentProgressRef,
} from "@/lib/agents/sub-agent-runner";
import { buildSubAgentSystem } from "@/lib/agents/prompts";
import {
  fetchWithGuard,
  extractText,
  isPrivateHost,
  readBodyCapped,
  FETCH_BODY_MAX_BYTES,
} from "@/lib/search/fetch-utils";
import { describeImage } from "@/lib/vision/describe-image";
import {
  splitParagraphs,
  segmentSearch,
  textLines,
  searchResultToString,
} from "@/lib/retrieval/doc-segments";

export interface WebSearchResult {
  answer: string;
  sources: Array<{ title: string; url: string }>;
  /** The researcher's confidence and open controversies: what is solid, what
   *  is uncertain or conflicting between sources. Part of the neutral
   *  contract. */
  recommendation: string;
  /** Pages worth a follow-up look (the main agent's own verification, or a
   *  link to hand the user). */
  suggestedReads: Array<{ url: string; title: string; reason: string }>;
}

/** Server-side search rounds Flash may use per query. 5 (was 3): a real run
 *  died on `max_uses_exceeded` at 3 — legitimate multi-angle research
 *  (reformulate after each read) hit the ceiling, and the provider's error
 *  variant then took the whole stream down (see normalizingFetch). 5 matches
 *  Anthropic's own default max_uses and pairs with the 6-page read quota; the
 *  50-step cap and 240s budget still bound the run. */
const MAX_SEARCHES_PER_QUERY = 5;

/** Explicit generation budgets for the research run (pinned 2026-11 after a
 *  production failure): DeepSeek's Anthropic-compatible endpoint does not
 *  recognize `deepseek-v4-flash`, so an absent max_tokens falls back to 4096
 *  and thinking to a 1024-token budget — the searchReport JSON was truncated
 *  mid-call and temperature dropped with a warning. 16K output leaves ample
 *  room for the cited answer after a 4K thinking budget. This is the
 *  sanctioned exception to the runner's no-maxOutputTokens default: here the
 *  ABSENT field is the silent truncator, not the cap. */
const SEARCH_MAX_OUTPUT_TOKENS = 16_000;
const SEARCH_THINKING_BUDGET_TOKENS = 4_096;

/** Pages the researcher may read in full per run. Reading pages is the
 *  expensive leg (fetch + context); a model that keeps "just one more page"
 *  would burn the whole step budget on reading. After the quota, webFetch
 *  returns a note and the researcher synthesizes from what it has. */
export const MAX_PAGE_READS = 6;

/** Images the researcher may look at per run. Separate from page reads. */
const MAX_IMAGE_READS = 2;

const WEB_FETCH_TIMEOUT_MS = 30_000;
const WEB_FETCH_MAX_CHARS = 15_000;

/**
 * DeepSeek's Anthropic-compatible endpoint deviates from the spec on
 * web_search_tool_result ERRORS (verified 2026-07-17, scripts/archive/smoke-search.mjs;
 * re-diagnosed 2026-11 on a production stream crash): the error comes wrapped
 * in an array ("content":[{error}]) where the Anthropic spec — and
 * @ai-sdk/anthropic's response AND stream-event schemas — expect a bare
 * object. Left as-is, the streamed variant fails schema validation
 * (AI_TypeValidationError) and kills the whole research stream; the
 * half-written step then 400s the provider's NEXT request ("tool_use ids
 * were found without tool_result blocks"). Normalize at the fetch boundary —
 * BOTH whole-body JSON and SSE `data:` event payloads (streamText streams) —
 * so the SDK always sees the spec shape: a failed round becomes an ordinary
 * provider-executed tool error (isError), the tool_use keeps its paired
 * tool_result, and the run continues with the rounds it has left.
 */

/**
 * Replace DeepSeek's array-wrapped web_search error with the spec's bare
 * error object, anywhere in a parsed payload (message content blocks, stream
 * event content_blocks). Logs each rewritten failure — a provider-side search
 * failure must be visible in the server log, not silent. Returns true when a
 * block was rewritten.
 */
function normalizeWebSearchErrors(node: unknown): boolean {
  if (Array.isArray(node)) {
    let hit = false;
    for (const item of node) hit = normalizeWebSearchErrors(item) || hit;
    return hit;
  }
  if (node === null || typeof node !== "object") return false;
  const record = node as Record<string, unknown>;
  let hit = false;
  if (record.type === "web_search_tool_result" && Array.isArray(record.content)) {
    const err = (record.content as Array<Record<string, unknown> | null>).find(
      (c) => c?.type === "web_search_tool_result_error",
    );
    if (err) {
      // Rebuild rather than reuse: the SDK schema requires error_code — an
      // error item missing it would still fail validation downstream.
      record.content = {
        type: "web_search_tool_result_error",
        error_code:
          typeof err.error_code === "string" ? err.error_code : "unavailable",
      };
      hit = true;
      console.warn(
        "[WebSearch] search round failed provider-side:",
        (record.content as { error_code: string }).error_code,
      );
    }
  }
  for (const value of Object.values(record)) {
    hit = normalizeWebSearchErrors(value) || hit;
  }
  return hit;
}

const normalizingFetch: typeof fetch = async (url, init) => {
  const res = await fetch(url, init);
  const text = await res.text();
  const rebuild = (body: string) =>
    new Response(body, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });

  // Streaming path (streamText): an SSE event stream — normalize the JSON
  // payload of each `data:` line, pass everything else through untouched.
  const contentType = res.headers.get("content-type") ?? "";
  if (
    contentType.includes("text/event-stream") ||
    text.startsWith("event:") ||
    text.startsWith("data:")
  ) {
    let touched = false;
    const out = text.split("\n").map((line) => {
      const eol = line.endsWith("\r") ? "\r" : "";
      const body = eol ? line.slice(0, -1) : line;
      if (!body.startsWith("data:")) return line;
      const payload = body.slice(5).trimStart();
      if (!payload || payload === "[DONE]") return line;
      let parsed: unknown;
      try {
        parsed = JSON.parse(payload);
      } catch {
        return line;
      }
      if (!normalizeWebSearchErrors(parsed)) return line;
      touched = true;
      return `data: ${JSON.stringify(parsed)}${eol}`;
    });
    return rebuild(touched ? out.join("\n") : text);
  }

  // Non-streaming path: whole-body JSON.
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return rebuild(text);
  }
  normalizeWebSearchErrors(body);
  return rebuild(JSON.stringify(body));
};

// ─── Researcher tool: webFetch (in-module) ──────────────────────────────
//
// Mirrors webFetchExecute in tool-executors.ts (same SSRF guard, same
// Document Segment Read protocol) but as a PLAIN function — the whole
// research run already lives inside one step (webSearchExecute), so the
// page read must not become a step of its own.

/** Range filter for the researcher's webFetch — keyword search (misses
 *  degrade to the full text with a note) or a 1-indexed line range. */
type PageReadRange = {
  type: "search" | "lines";
  keywords?: string[];
  context?: number;
  start?: number;
  end?: number;
};

async function readPageImpl(url: string, range?: PageReadRange): Promise<string> {
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

// ─── Structured output schema: searchReport ───────────────────────

/** Zod input schema — also the runner's report-validation schema. */
const searchReportInputSchema = z.object({
  answer: z
    .string()
    .catch("")
    .describe("Concise cited answer (2-5 paragraphs), grounded in what you actually found and read."),
  recommendation: z
    .string()
    .catch("")
    .describe(
      "Your researcher's assessment: how confident you are in the answer, " +
      "what is solid (and why), and what remains uncertain or conflicting " +
      "between sources. One short paragraph."
    ),
  suggested_reads: z
    .array(
      z.object({
        url: z.string().catch("").describe("Full URL worth a follow-up look."),
        title: z.string().catch("").describe("Page title or short label."),
        reason: z.string().catch("").describe("One line: why this page is worth reading."),
      }),
    )
    .max(3)
    .catch([])
    .describe(
      "0-3 pages worth a follow-up look — for the main agent's own " +
      "verification, or to hand the user as further reading. Leave empty if " +
      "no single page adds value beyond your answer."
    ),
});

type SearchReport = z.infer<typeof searchReportInputSchema>;

/** The search report the researcher returns to the main agent. */
const searchReportSchema = tool({
  description:
    "Report your research findings to your colleague. " +
    "Call this ONCE after you have searched and read enough to answer.",
  inputSchema: searchReportInputSchema,
});

/** Total model steps for the research loop: search rounds + page reads + the
 *  final report. */
const MAX_SEARCH_STEPS = 50;

/**
 * prepareStep factory: the step wall is the classic "never filed the report"
 * case — the model burns its budget searching/reading and runs out of steps
 * before searchReport. On the LAST permitted step, swap the instructions for
 * an urgent report-now directive. toolChoice is deliberately NOT forced:
 * DeepSeek's thinking mode 400s on a forced tool_choice (see the runner's
 * deepseekDowngrade), and this run keeps thinking on.
 */
function finalStepReportDirective(
  systemPrompt: string,
): PrepareStepFunction<ToolSet> {
  return ({ stepNumber }) =>
    stepNumber >= MAX_SEARCH_STEPS - 1
      ? {
          instructions:
            `${systemPrompt}\n\n# FINAL STEP — REPORT NOW\n\n` +
            "This is your last step: the run's step budget is exhausted after it. " +
            "You MUST call searchReport in this step with whatever you already have — " +
            "a partial report beats a lost one. Do NOT start new searches or page reads.",
        }
      : {};
}

/**
 * Build the research sub-agent's role block for a specific run mode. The
 * system prompt is `buildSubAgentSystem(buildSearchRole(r, p))` (shared static
 * base + this block). The shared base is fully static, so provider prompt
 * caches still hit across runs of the SAME mode; only the effective cap
 * numbers differ between standard and scout runs. The per-call `Today is …`
 * date anchor, the scout scoping note, and the query live in the user prompt.
 */
function buildSearchRole(
  maxSearchRounds: number,
  maxPageReads: number,
): string {
  return `You are an independent researcher: the main agent hands you a topic, and you come back with a real answer.

You both search AND read. web_search (provider-executed) finds the material; webFetch reads the most promising pages yourself — the search digest alone is often too thin to answer well. Pages come back as Markdown (headings, lists, links and tables preserved). You may read at most ${maxPageReads} pages per run — spend them on the strongest sources. When a promising page's key content is an image, viewImage can look at it for you (up to ${MAX_IMAGE_READS} images per run).

Process:
1. Plan your search: you may use up to ${maxSearchRounds} search rounds. Round 1 may use the query as-is; every later round must either reformulate based on what you have learned or chase a new lead discovered in the material you have already read. Before issuing a new search round, state (in thinking) what is still missing.
2. Search, then read the most promising pages with webFetch between rounds when it sharpens your next query (use its range filters to keep reads focused).
3. When you have enough, call searchReport with:
   - answer: a real answer to the query (2-5 paragraphs), synthesizing what you found with your own knowledge. Every claim that comes from the web must mention its source. Answer in the query's language — it reaches the user, so it overrides the shared base's English default.
   - recommendation: your researcher's assessment — how confident you are, what is solid, what is uncertain or conflicting between sources.
   - suggested_reads: 0-3 pages worth a follow-up look (your colleague's own verification, or further reading for the user).

searchReport is the ONLY channel your work reaches the main agent through — a prose final message is thrown away. Every run MUST end with a searchReport call, even a partial one: if you are running out of steps, time, or search rounds, stop researching and report what you already have. A thin report beats a lost one.

Distinguish what the sources SAY from what YOU know — never blend the two silently. If the search found nothing usable, say so plainly in the answer instead of papering over it.`;
}

/** Wall-clock budget for one research run (runner SDK timeout + backstop).
 *  Sized for the page quota: 6 reads (MAX_PAGE_READS) at the 30s fetch cap
 *  alone can burn 180s, so the budget matches recall's 240s. */
export const SEARCH_TIMEOUT_MS = 240_000;

/**
 * Adapter #1: DeepSeek V4 Flash native search. Flash decides what to search
 * and how many rounds (up to MAX_SEARCHES_PER_QUERY), reads results on
 * DeepSeek's servers, and returns a cited digest — we run no search
 * infrastructure and need no extra API key.
 *
 * The researcher searches (web_search is provider-executed on DeepSeek's
 * side), reads the strongest pages itself (webFetch, quota-bounded,
 * implemented in-module above), then reports a cited answer + its confidence
 * assessment (searchReport, structured).
 *
 * Runs on the unified sub-agent runner with a PRE-BUILT model — the DeepSeek
 * Anthropic-compatible endpoint and its normalizing fetch are unchanged.
 * `progress` routes each tool start (each web_search round, each page read,
 * then the searchReport) onto the shared data-tool-progress channel as a live
 * "Searching round N…" / "Reading page …" subtitle. This is SHELL streaming —
 * the actual answer text is not streamed (it's produced inside the structured
 * searchReport tool call), and the web_search execution itself is a
 * DeepSeek-server black box.
 *
 * The researcher's SOP (self/search/index.md, v0.19 §C.2) is loaded by the
 * sub-agent runner itself (`selfSop: "search"`) — FULL text into the system
 * prompt at spawn; absent SOP → no block.
 *
 * Error contract: the runner never throws. Failed runs are re-thrown here as
 * a plain Error carrying the runner's message — EXCEPT a timeout that left
 * partial text behind, which degrades in place to a flagged low-confidence
 * answer (aligned with recall). webSearchExecute's withStepTimeout/triage
 * layer keeps classifying the thrown failures (step retry for transient,
 * error tool result for deterministic).
 */
export async function searchViaFlash(
  query: string,
  progress?: SubAgentProgressRef,
  opts?: { scout?: boolean },
): Promise<WebSearchResult> {
  const provider = createAnthropic({
    baseURL: "https://api.deepseek.com/anthropic",
    apiKey: process.env.DEEPSEEK_API_KEY,
    fetch: normalizingFetch,
  });

  const scout = opts?.scout ?? false;
  // Effective caps: scout is a lean fan-out leg with half the page-read quota
  // and fewer search rounds; standard mode keeps the exported constants.
  const effectiveMaxSearchRounds = scout ? 3 : MAX_SEARCHES_PER_QUERY;
  const effectiveMaxPageReads = scout ? 3 : MAX_PAGE_READS;

  const today = new Date().toISOString().slice(0, 10);
  const scoutBlock = scout
    ? "\n\nYou are one of several researchers working in parallel on different sub-questions — stay tightly scoped to your query."
    : "";
  let searchRounds = 0;
  // Per-run page-read quota (effectiveMaxPageReads).
  let pageReads = 0;
  // Per-run image-read quota (MAX_IMAGE_READS).
  let imageReads = 0;
  const systemPrompt = buildSubAgentSystem(
    buildSearchRole(effectiveMaxSearchRounds, effectiveMaxPageReads),
  );
  const res = await runSubAgent<SearchReport>({
    languageModel: provider("deepseek-v4-flash"),
    // The pre-built model speaks the Anthropic protocol — the effort mapping
    // must use the Anthropic provider-options shape, not DeepSeek's.
    effortSdk: "anthropic",
    system: systemPrompt,
    // Explicit budgets — the compat endpoint's defaults (4096 output / 1024
    // thinking) silently truncated reports; see the constants above.
    maxOutputTokens: SEARCH_MAX_OUTPUT_TOKENS,
    providerOptions: {
      anthropic: {
        thinking: {
          type: "enabled",
          budgetTokens: SEARCH_THINKING_BUDGET_TOKENS,
        },
      },
    },
    selfSop: "search",
    prompt: `Today is ${today}.\n\nQuery: ${query}${scoutBlock}`,
    tools: {
      web_search: provider.tools.webSearch_20260209({
        maxUses: effectiveMaxSearchRounds,
      }),
      webFetch: tool({
        description:
          "Fetch and read a specific page as Markdown (headings/lists/links/" +
          "tables preserved, boilerplate stripped, up to ~15K characters). " +
          `Costs one of your ${effectiveMaxPageReads} ` +
          "page-read slots — spend them on the strongest sources only. " +
          "Optional `range`: `search` matches keywords across the page " +
          "(misses return the full text — 15K-capped — with a note); `lines` reads a " +
          "1-indexed line range.",
        inputSchema: z.object({
          url: z
            .string()
            .describe("The full URL to fetch, e.g. 'https://example.com/article'."),
          range: z
            .object({
              type: z
                .enum(["search", "lines"])
                .describe(
                  "search = keyword match, returns matching paragraphs (+ context); " +
                  "if nothing matches, returns the full page text (capped at ~15K characters) with a note. " +
                  "lines = 1-indexed line range of the extracted text.",
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
            .describe("Optional selective read. When omitted, returns the full extracted text."),
        }),
        execute: async ({ url, range }: { url: string; range?: PageReadRange }) => {
          if (pageReads >= effectiveMaxPageReads) {
            return (
              `(Page-read quota exhausted — ${effectiveMaxPageReads} reads per run.) ` +
              "Answer from what you have already searched and read."
            );
          }
          pageReads += 1;
          return readPageImpl(url, range);
        },
      }),
      viewImage: tool({
        description:
          "Describe the contents of an image URL. Use when a promising page's " +
          "key content is an image, or when the user referenced an image link. " +
          `Costs one of your ${MAX_IMAGE_READS} image-read slots per run. ` +
          "Pass the full http(s) URL of the image and a question about what you " +
          "need to know.",
        inputSchema: z.object({
          url: z
            .string()
            .describe("The full http(s) URL of the image to describe."),
          question: z
            .string()
            .optional()
            .describe(
              "What you want to know about the image. Be specific. Omit for a " +
              "general structured description.",
            ),
        }),
        execute: async ({ url, question }: { url: string; question?: string }) => {
          if (imageReads >= MAX_IMAGE_READS) {
            return (
              `(Image-read quota exhausted — ${MAX_IMAGE_READS} reads per run.) ` +
              "Answer from what you have already searched and read."
            );
          }
          imageReads += 1;
          const result = await describeImage({ image: { url }, question });
          return result.ok ? result.description : result.error;
        },
      }),
      searchReport: searchReportSchema,
    },
    toolChoice: "auto",
    reportToolName: "searchReport",
    reportSchema: searchReportInputSchema,
    maxSteps: MAX_SEARCH_STEPS,
    // A run that burns its whole step budget on research must still file its
    // report — the final step's instructions become a report-now directive.
    prepareStep: finalStepReportDirective(systemPrompt),
    timeoutMs: SEARCH_TIMEOUT_MS,
    progress,
    onToolProgress: ({ toolName, input: toolInput }) => {
      if (toolName === "web_search") {
        searchRounds += 1;
        return {
          line: `Searching the web (round ${searchRounds})…`,
          stage: "running",
        };
      }
      if (toolName === "webFetch") {
        const url =
          typeof toolInput === "object" && toolInput !== null && "url" in toolInput
            ? String((toolInput as { url?: unknown }).url ?? "")
            : "";
        let host = url;
        try {
          host = new URL(url).hostname;
        } catch {
          /* keep the raw url as the label */
        }
        return {
          line: host ? `Reading page ${host}…` : "Reading a page…",
          stage: "running",
        };
      }
      if (toolName === "viewImage") {
        return { line: "Looking at an image…", stage: "running" };
      }
      if (toolName === "searchReport") {
        return { line: "Compiling the research report…", stage: "running" };
      }
      return undefined;
    },
  });

  const sources = (res.sources ?? [])
    .filter(
      (s): s is typeof s & { sourceType: "url"; url: string } =>
        s.sourceType === "url" && typeof s.url === "string"
    )
    .map((s) => ({ title: s.title ?? s.url, url: s.url }));

  if (!res.ok) {
    // Soft-timeout degradation, aligned with recall: a run cut off
    // mid-research still returns the partial text it accumulated — flagged
    // as truncated in the recommendation — instead of throwing it away. A
    // COMPLETELY empty timeout still throws, so the executor's triage keeps
    // classifying it (step retry vs error tool result).
    if (res.timedOut) {
      const partial = res.text?.trim();
      if (partial) {
        console.warn(`[WebSearch] ${res.error}`);
        return {
          answer: partial,
          recommendation:
            "The research run hit its time budget and was cut off — this answer was recovered from the interrupted run's partial text; treat it as lower-confidence and unverified.",
          suggestedReads: [],
          sources,
        };
      }
    }
    throw new Error(res.error ?? "Web search failed");
  }

  const report = res.report;
  if (report) {
    return {
      answer: report.answer ?? res.text ?? "",
      recommendation: report.recommendation ?? "",
      suggestedReads: (report.suggested_reads ?? [])
        .filter((s) => typeof s?.url === "string" && s.url.length > 0)
        .slice(0, 3)
        .map((s) => ({
          url: s.url as string,
          title: typeof s.title === "string" ? s.title : (s.url as string),
          reason: typeof s.reason === "string" ? s.reason : "",
        })),
      sources,
    };
  }

  // searchReport not called — DEGRADE, never drop: the final text still goes
  // back as the answer, flagged in the recommendation as an unfiled recovery
  // so the main agent treats it with care, and logged for the server console.
  console.warn(
    "[WebSearch] searchReport not called — degrading to the run's final text:",
    res.text?.slice(0, 200) ?? "(no text)",
  );
  return {
    answer: res.text ?? "",
    recommendation:
      "The researcher ended its run without filing the structured searchReport — " +
      "this answer was recovered verbatim from its final message; treat it as " +
      "lower-confidence and unverified.",
    suggestedReads: [],
    sources,
  };
}
