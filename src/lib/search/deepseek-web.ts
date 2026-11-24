import { readTextPage } from "@/lib/retrieval/text-page";
import { z } from "zod";
import { deepseekApiKey } from "@/lib/deepseek/credentials";

import { webSearchInputSchema, type WebFetchInput } from "./web-input";
import { isPrivateHost } from "./fetch-utils";
import { searchResultToString, segmentSearch, splitParagraphs, textLines } from "@/lib/retrieval/doc-segments";
export { webSearchInputSchema } from "./web-input";

const MAX_ATTEMPTS = 3;
const resultSchema = z.object({
  title: z.string(),
  url: z.string().url().refine((value) => {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password;
  }),
  snippet: z.string().optional(),
  summary: z.string().optional(),
  site_name: z.string().nullable().optional(),
  date: z.string().nullable().optional(),
  authority: z.number().optional(),
  rerank_score: z.number().optional(),
});
const responseSchema = z.object({ results: z.array(resultSchema) });
export type DeepSeekSearchResult = z.infer<typeof responseSchema>;

function retryDelay(response: Response, attempt: number): number {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    const delay = Number.isFinite(seconds)
      ? Math.max(0, seconds * 1_000)
      : Math.max(0, Date.parse(retryAfter) - Date.now());
    if (Number.isFinite(delay)) return delay;
  }
  return 250 * 2 ** attempt;
}

function waitForRetry(delay: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, delay);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

/** Retry explicit upstream failures only. Never replay an ambiguous 200 or follow a redirect with credentials. */
async function requestWebTool(operation: "search" | "fetch", body: object, signal?: AbortSignal): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    const response = await fetch(`https://api.deepseek.com/v1/tools/${operation}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${deepseekApiKey()}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      redirect: "error",
      signal,
    });
    if (response.ok) return response.json();
    await response.body?.cancel();
    const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
    if (!retryable || attempt + 1 >= MAX_ATTEMPTS) {
      throw new Error(`DeepSeek ${operation} failed (HTTP ${response.status}).`);
    }
    await waitForRetry(retryDelay(response, attempt), signal);
  }
}

export async function deepseekWebSearch(input: z.infer<typeof webSearchInputSchema>, signal?: AbortSignal): Promise<DeepSeekSearchResult> {
  const { query, count = 10 } = webSearchInputSchema.parse(input);
  return responseSchema.parse(await requestWebTool("search", { query, count, need_content: false }, signal));
}

const fetchedPage = z.object({ title: z.string(), content: z.string() });

export async function deepseekWebFetch({ url, range, offset = 0, revision }: WebFetchInput, signal?: AbortSignal): Promise<string> {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return "ERROR: Invalid URL. Supply an absolute public HTTP(S) URL."; }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "ERROR: Unsupported URL protocol.";
  if (parsed.username || parsed.password || isPrivateHost(parsed.hostname)) return "ERROR: Cannot fetch private or credentialed URLs.";
  if (Array.from(url).length > 8192) return "ERROR: The DeepSeek Fetch API accepts URLs up to 8192 characters.";
  const { content } = fetchedPage.parse(await requestWebTool("fetch", { url }, signal));
  let selected = content;
  if (range?.type === "lines") {
    const start = range.start ?? 1;
    const end = range.end ?? start;
    if (end < start) return "ERROR: The last line must follow the first.";
    selected = textLines(content, start, end).content;
  } else if (range?.type === "search") {
    const keywords = range.keywords ?? [];
    const context = range.context ?? 1;
    const hits = segmentSearch(splitParagraphs(content), keywords, context, context);
    selected = searchResultToString(parsed.hostname + parsed.pathname, keywords, hits, content);
  }
  const page = readTextPage(selected, { offset, revision }, 15_000);
  if (!page.ok) return `ERROR: ${page.error}`;
  return page.end === page.total ? page.text : page.text + `\n\n[Page continues. Call webFetch with the same URL and range, offset ${page.end}, revision "${page.revision}".]`;
}
