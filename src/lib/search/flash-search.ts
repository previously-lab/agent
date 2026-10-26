/**
 * DeepSeek research with explicit search results, bounded page/image reads,
 * and a structured answer shared by chat and scout research.
 */
import { tool } from "@/lib/deepseek/tools";
import type { PrepareStepFunction, ToolSet } from "@/lib/deepseek/types";
import { webSearchInputSchema } from "@/lib/search/deepseek-web";
import {
  SearchRunPolicy,
  SCOUT_SEARCH_OPERATION_LIMIT,
  STANDARD_SEARCH_OPERATION_LIMIT,
  type SearchRunStats,
} from "@/lib/search/search-policy";
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
  /** Per-run accounting supplied by searchViaFlash. Legacy outer fallbacks
   *  omit it because their request counts are unknown. */
  searchStats?: SearchRunStats;
  /** True iff a NEW request was rejected by the per-run operation cap. Optional
   *  for the same legacy fallbacks; actual searchViaFlash results supply it. */
  truncated?: boolean;
}

/** Search calls allowed per query. Page reads, total steps and the outer
 * platform timeout also bound each research run. */
const MAX_SEARCHES_PER_QUERY = 50;

/** Pages the researcher may read in full per run. Reading pages is the
 *  expensive leg (fetch + context); a model that keeps "just one more page"
 *  would burn the whole step budget on reading. After the quota, webFetch
 *  returns a note and the researcher synthesizes from what it has. */
export const MAX_PAGE_READS = 6;

/** Images the researcher may look at per run. Separate from page reads. */
const MAX_IMAGE_READS = 2;

const WEB_FETCH_TIMEOUT_MS = 30_000;
const WEB_FETCH_MAX_CHARS = 15_000;

/** Range filter for the researcher's guarded page reader. */
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
 *  final report. The paid-search and page/image quotas fit with synthesis
 *  headroom; the final report-only step also catches duplicate/no-op loops
 *  before they can consume the whole run without filing a report. */
const MAX_SEARCH_STEPS = 32;

/**
 * prepareStep factory: the step wall is the classic "never filed the report"
 * case — the model burns its budget searching/reading and runs out of steps
 * before searchReport. On the LAST permitted step, swap the instructions for
 * an urgent report-now directive. toolChoice is deliberately NOT forced:
 * DeepSeek thinking mode does not accept a forced tool choice.
 */
function finalStepReportDirective(
  systemPrompt: string,
): PrepareStepFunction<ToolSet> {
  return ({ stepNumber }) =>
    stepNumber >= MAX_SEARCH_STEPS - 1
      ? {
          system:
            `${systemPrompt}\n\n# FINAL STEP — REPORT NOW\n\n` +
            "This is your last step: the run's step budget is exhausted after it. " +
            "You MUST call searchReport in this step with whatever you already have — " +
            "a partial report beats a lost one. Do NOT start new searches or page reads.",
          activeTools: ["searchReport"],
          toolChoice: "auto",
        }
      : {};
}

/**
 * Build the research sub-agent's role block for a specific run mode. The
 * system prompt is `buildSubAgentSystem(buildSearchRole(r, p, o))` (shared
 * static base + this block). The shared base is fully static, so provider
 * prompt caches still hit across runs of the SAME mode; only the effective
 * cap numbers differ between standard and scout runs. The per-call
 * `Today is …` date anchor, the scout scoping note, and the query live in
 * the user prompt.
 */
function buildSearchRole(
  maxSearchRounds: number,
  maxPageReads: number,
  maxSearchOperations: number,
): string {
  return `You are an independent researcher: the main agent hands you a topic, and you come back with a real answer.

You both search AND read. web_search returns DeepSeek Search result titles, URLs and summaries; webFetch reads the most promising pages yourself — the search digest alone is often too thin to answer well. Pages come back as Markdown (headings, lists, links and tables preserved). You may read at most ${maxPageReads} pages per run — spend them on the strongest sources. When a promising page's key content is an image, viewImage can look at it for you (up to ${MAX_IMAGE_READS} images per run).

Budgets: you may issue up to ${maxSearchRounds} web_search rounds AND start at most ${maxSearchOperations} NEW search operations per run. Repeating the exact normalized query with the same result count reuses that earlier successful result for free (quoted phrases stay exact). A different count, including a larger request, is a new operation rather than free reuse. Prefer complementary, independent sources over more hits on the same site, and preserve your operator intent (site:, -site:, lang:, after:, before:, OR, quotes, negation) through reformulations. When you have enough evidence to answer, stop searching and start writing — extra rounds rarely change the answer.

Process:
1. Plan your search: each query must contain 1-128 Unicode characters; reformulate long topics into focused queries. Round 1 may use the query as-is; every later round must either reformulate based on what you have learned or chase a new lead discovered in the material you have already read. Before issuing a new search round, state (in thinking) what is still missing.
2. Search, then read the most promising pages with webFetch between rounds when it sharpens your next query (use its range filters to keep reads focused).
3. When you have enough, call searchReport with:
   - answer: a real answer to the query (2-5 paragraphs), synthesizing what you found with your own knowledge. Every claim that comes from the web must mention its source. Answer in the query's language — it reaches the user, so it overrides the shared base's English default.
   - recommendation: your researcher's assessment — how confident you are, what is solid, what is uncertain or conflicting between sources.
   - suggested_reads: 0-3 pages worth a follow-up look (your colleague's own verification, or further reading for the user).

If the new-search-operation budget runs out, web_search tells you so: do not keep re-trying fresh queries — synthesize your report from the evidence you have already gathered, and note in the report that coverage is limited to that evidence and a separate, deliberately scoped follow-up run is needed for deeper coverage. Reserve your last steps for synthesis: a report filed beats a perfect search lost.

searchReport is the ONLY channel your work reaches the main agent through — a prose final message is thrown away. Every run MUST end with a searchReport call, even a partial one: if you are running out of steps, time, or search rounds, stop researching and report what you already have. A thin report beats a lost one.

Distinguish what the sources SAY from what YOU know — never blend the two silently. If the search found nothing usable, say so plainly in the answer instead of papering over it.`;
}

/** The OUTER webSearch tool wall: tool-executors wraps the whole search call
 *  in withStepTimeout (the run itself carries no budget since v0.34 修订 A —
 *  execution budgets are deleted repo-wide). 600s, raised out of the way but
 *  NOT deleted: this is a backstop against the platform's 800s invocation wall
 *  (which kills the turn and re-executes the step), not a work budget — a
 *  stuck step must time out well before the platform wall, and 600s leaves the
 *  search/step caps as the budgets that actually bind. */
export const SEARCH_TIMEOUT_MS = 600_000;

/** The researcher uses the fixed search role and an explicit Search API tool.
 * The shared runner loads its SOP and streams progress. Search sources are
 * collected from successful API results, including partial-report recovery.
 */
export async function searchViaFlash(
  query: string,
  progress?: SubAgentProgressRef,
  opts?: { scout?: boolean },
): Promise<WebSearchResult> {
  const scout = opts?.scout ?? false;
  // Effective caps: scout is a lean fan-out leg with half the page-read quota
  // and fewer search rounds; standard mode keeps the exported constants.
  const effectiveMaxSearchRounds = scout ? 20 : MAX_SEARCHES_PER_QUERY;
  const effectiveMaxPageReads = scout ? 3 : MAX_PAGE_READS;
  // New-search-operation cap: a fresh policy instance per run — no module or
  // cross-run state. Reusing a successfully-searched query stays free after
  // the cap; only NEW operations consume slots.
  const effectiveSearchOperationLimit = scout
    ? SCOUT_SEARCH_OPERATION_LIMIT
    : STANDARD_SEARCH_OPERATION_LIMIT;
  const searchPolicy = new SearchRunPolicy(effectiveSearchOperationLimit, query);

  const today = new Date().toISOString().slice(0, 10);
  const scoutBlock = scout
    ? "\n\nYou are one of several researchers working in parallel on different sub-questions — stay tightly scoped to your query."
    : "";
  let searchRounds = 0;
  const observedSources = new Map<string, { title: string; url: string }>();
  // Per-run page-read quota (effectiveMaxPageReads).
  let pageReads = 0;
  // Per-run image-read quota (MAX_IMAGE_READS).
  let imageReads = 0;
  const systemPrompt = buildSubAgentSystem(
    buildSearchRole(effectiveMaxSearchRounds, effectiveMaxPageReads, effectiveSearchOperationLimit),
  );
  const res = await runSubAgent<SearchReport>({
    role: "search",
    system: systemPrompt,
    selfSop: "search",
    prompt: `Today is ${today}.\n\nQuery: ${query}${scoutBlock}`,
    tools: {
      web_search: tool({
        description: "Search the web with DeepSeek. Returns source URLs, titles and summaries. " +
          `Up to ${effectiveMaxSearchRounds} search rounds per run, of which at most ` +
          `${effectiveSearchOperationLimit} may be NEW search operations — repeating the ` +
          "same normalized query with the same effective result count reuses that successful result. " +
          "A larger count may expand within the remaining budget. Use webFetch for page contents.",
        inputSchema: webSearchInputSchema,
        execute: async (input, options) => {
          if (searchRounds >= effectiveMaxSearchRounds) {
            return { results: [], note: "Search quota exhausted. Report what you have already found." };
          }
          searchRounds += 1;
          const out = await searchPolicy.search(input, options?.abortSignal);
          for (const source of out.results) {
            if (!observedSources.has(source.url)) {
              observedSources.set(source.url, { title: source.title || source.url, url: source.url });
            }
          }
          return out;
        },
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
    progress,
    onToolProgress: ({ toolName, input: toolInput }) => {
      if (toolName === "web_search") {
        // Progress uses the same normalized-query-plus-count identity as the
        // policy, so a count expansion is never mislabeled as free reuse.
        const q =
          typeof toolInput === "object" && toolInput !== null && "query" in toolInput
            ? String((toolInput as { query?: unknown }).query ?? "")
            : "";
        const count =
          typeof toolInput === "object" && toolInput !== null && "count" in toolInput &&
          typeof (toolInput as { count?: unknown }).count === "number"
            ? (toolInput as { count: number }).count
            : undefined;
        const round = Math.min(searchRounds + 1, effectiveMaxSearchRounds);
        if (searchPolicy.hasSeen(q, count)) {
          return {
            line: `Searching the web (round ${round}, reusing an earlier result — no new search operation)…`,
            stage: "running",
          };
        }
        const operationsStarted = searchPolicy.getStats().operationsStarted;
        if (operationsStarted >= effectiveSearchOperationLimit) {
          return {
            line: `Search operation budget exhausted; round ${round} will not start a new search…`,
            stage: "running",
          };
        }
        return {
          line: `Searching the web (round ${round}, new search operation ${operationsStarted + 1} of ${effectiveSearchOperationLimit})…`,
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

  const sources = [...observedSources.values()];
  const searchStats = searchPolicy.getStats();
  const truncated = searchStats.exhausted;
  // Appended to the recommendation whenever the run ended with the
  // new-search-operation cap rejecting a query: the answer is limited to the
  // evidence already gathered, and it must never read as an ordinary result.
  const exhaustionLimitation = truncated
    ? "Search budget exhausted during this run — the answer is limited to " +
      "the evidence already gathered; a separate, deliberately scoped " +
      "follow-up research run is needed for deeper coverage."
    : "";
  const withLimitation = (recommendation: string): string =>
    exhaustionLimitation
      ? recommendation
        ? `${recommendation}\n\n${exhaustionLimitation}`
        : exhaustionLimitation
      : recommendation;

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
          recommendation: withLimitation(
            "The research run hit its time budget and was cut off — this answer was recovered from the interrupted run's partial text; treat it as lower-confidence and unverified.",
          ),
          suggestedReads: [],
          sources,
          searchStats,
          truncated,
        };
      }
    }
    throw new Error(res.error ?? "Web search failed");
  }

  const report = res.report;
  if (report) {
    return {
      answer: report.answer ?? res.text ?? "",
      recommendation: withLimitation(report.recommendation ?? ""),
      suggestedReads: (report.suggested_reads ?? [])
        .filter((s) => typeof s?.url === "string" && s.url.length > 0)
        .slice(0, 3)
        .map((s) => ({
          url: s.url as string,
          title: typeof s.title === "string" ? s.title : (s.url as string),
          reason: typeof s.reason === "string" ? s.reason : "",
        })),
      sources,
      searchStats,
      truncated,
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
    recommendation: withLimitation(
      "The researcher ended its run without filing the structured searchReport — " +
      "this answer was recovered verbatim from its final message; treat it as " +
      "lower-confidence and unverified.",
    ),
    suggestedReads: [],
    sources,
    searchStats,
    truncated,
  };
}
