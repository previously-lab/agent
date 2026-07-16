/**
 * Web search — provider adapters behind a neutral contract.
 *
 * The webSearch tool's interface (query in → answer + sources out) is OURS;
 * nothing DeepSeek- or Anthropic-shaped may leak out of this module. Today
 * there is one adapter: DeepSeek V4 Flash's native server-side search, reached
 * through DeepSeek's Anthropic-compatible endpoint (the OpenAI-compatible /v1
 * endpoint cannot express provider-executed tools). Future adapters (Claude
 * native webSearch, Tavily for keyless demo) drop in behind the same contract.
 *
 * Model roles: this is an INFRASTRUCTURE model call (like Flash recall in
 * lib/router/flash.ts) — the user-facing Pro model choice is not affected.
 */
import { createAnthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";

export interface WebSearchResult {
  answer: string;
  sources: Array<{ title: string; url: string }>;
}

/** Server-side search rounds Flash may use per query. */
const MAX_SEARCHES_PER_QUERY = 3;

/**
 * DeepSeek's Anthropic-compatible endpoint has one spec deviation (verified
 * 2026-07-17, scripts/smoke-search.mjs): web_search_tool_result ERRORS come
 * wrapped in an array ("content":[{error}]) where the Anthropic spec — and
 * @ai-sdk/anthropic's response schema — expect a bare object. Normalize at
 * the fetch boundary so the SDK can parse the response.
 */
const normalizingFetch: typeof fetch = async (url, init) => {
  const res = await fetch(url, init);
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return new Response(text, res);
  }
  const content = (body as { content?: unknown })?.content;
  if (Array.isArray(content)) {
    for (const block of content as Array<Record<string, unknown>>) {
      if (
        block?.type === "web_search_tool_result" &&
        Array.isArray(block.content)
      ) {
        const err = (block.content as Array<Record<string, unknown>>).find(
          (c) => c?.type === "web_search_tool_result_error"
        );
        if (err) block.content = err;
      }
    }
  }
  return new Response(JSON.stringify(body), {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  });
};

/**
 * Adapter #1: DeepSeek V4 Flash native search. Flash decides what to search
 * and how many rounds (up to MAX_SEARCHES_PER_QUERY), reads results on
 * DeepSeek's servers, and returns a cited digest — we run no search
 * infrastructure and need no extra API key.
 */
export async function searchViaFlash(query: string): Promise<WebSearchResult> {
  const provider = createAnthropic({
    baseURL: "https://api.deepseek.com/anthropic",
    apiKey: process.env.DEEPSEEK_API_KEY,
    fetch: normalizingFetch,
  });

  const today = new Date().toISOString().slice(0, 10);
  const result = await generateText({
    model: provider("deepseek-v4-flash"),
    tools: {
      web_search: provider.tools.webSearch_20260209({
        maxUses: MAX_SEARCHES_PER_QUERY,
      }),
    },
    prompt: `Today is ${today}. Search the web to answer the query below. Be factual and concise; ground every claim in what you actually found and mention the source. Answer in the query's language.

Query: ${query}`,
  });

  const sources = (result.sources ?? [])
    .filter(
      (s): s is typeof s & { sourceType: "url"; url: string } =>
        s.sourceType === "url" && typeof s.url === "string"
    )
    .map((s) => ({ title: s.title ?? s.url, url: s.url }));

  return { answer: result.text, sources };
}
