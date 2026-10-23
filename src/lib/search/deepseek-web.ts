import { z } from "zod";
import { deepseekApiKey } from "@/lib/deepseek/credentials";

const SEARCH_URL = "https://api.deepseek.com/v1/tools/search";
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 3;
const MAX_RETRY_DELAY_MS = 5_000;

/** DeepSeek counts Unicode characters, not JavaScript UTF-16 code units. */
export const webSearchInputSchema = z.object({
  query: z.string().refine(
    (query) => query.trim().length > 0 && Array.from(query).length <= 128,
    "Search query must contain 1-128 Unicode characters and cannot be all whitespace.",
  ).describe("Search query, 1-128 Unicode characters. Search operators are preserved."),
  count: z.number().int().min(1).max(50).optional()
    .describe("Number of results, 1-50 (default 10)."),
});

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
const responseSchema = z.object({ results: z.array(resultSchema).max(50) });
export type DeepSeekSearchResult = z.infer<typeof responseSchema>;

function retryDelay(response: Response, attempt: number): number | null {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    const delay = Number.isFinite(seconds)
      ? Math.max(0, seconds * 1_000)
      : Math.max(0, Date.parse(retryAfter) - Date.now());
    // A long server cooldown is returned to the caller, never shortened.
    if (Number.isFinite(delay)) return delay <= MAX_RETRY_DELAY_MS ? delay : null;
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

/** Read-only native Search API; credentials are resolved at each HTTP boundary.
 * Contract: https://api-docs.deepseek.com/guides/search/
 * Page content stays behind the researcher's separate guarded webFetch quota.
 * Only explicit retryable HTTP failures are retried; successful paid requests,
 * invalid responses, auth/balance failures and ambiguous network failures are not.
 */
export async function deepseekWebSearch(
  input: z.infer<typeof webSearchInputSchema>,
  signal?: AbortSignal,
): Promise<DeepSeekSearchResult> {
  const { query, count = 10 } = webSearchInputSchema.parse(input);
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    signal?.throwIfAborted();
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const response = await fetch(SEARCH_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${deepseekApiKey()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, count, need_content: false }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      // Never forward the credential to a redirected endpoint.
      redirect: "error",
    });
    if (response.ok) {
      // A malformed successful response must not be billed a second time.
      return responseSchema.parse(await response.json());
    }
    const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
    const delay = retryable && attempt + 1 < MAX_ATTEMPTS ? retryDelay(response, attempt) : null;
    await response.body?.cancel();
    if (delay === null) {
      // Provider bodies can contain sensitive diagnostics; keep them out of
      // tool results and logs. The status is enough for the user to act on.
      throw new Error(`DeepSeek search failed (HTTP ${response.status}).`);
    }
    await waitForRetry(delay, signal);
  }
  throw new Error("DeepSeek search failed.");
}
