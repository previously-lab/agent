import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeepSeekError, requestDeepSeek } from "@/lib/deepseek/http";
import { deepseekWebSearch } from "@/lib/search/deepseek-web";
import type { ModelRequest } from "@/lib/deepseek/types";

const baseRequest: ModelRequest = {
  messages: [{ role: "user", content: "hello" }], thinking: false,
  reasoningEffort: "low", temperature: 0.2, callId: "fixture:0", maxRetries: 0,
};

function sse(events: unknown[]): Response {
  const body = events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}
function simpleResponse(text = "ok"): Response {
  return sse([
    { choices: [{ delta: { content: text }, finish_reason: "stop" }] },
    { choices: [], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } },
  ]);
}

beforeEach(() => {
  vi.stubEnv("PREVIOUSLY_MODE", "cloud");
  vi.stubEnv("DEEPSEEK_API_KEY", "primary-test-key");
  vi.stubEnv("CHAT_API_HOST", "");
  vi.stubEnv("CHAT_API_KEY", "");
  vi.stubEnv("CHAT_API_MODEL", "");
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("production model transport metrics", () => {
  it("times meaningful deltas and logs only low-cardinality fields and actual provider counts", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("CHAT_API_HOST", "https://opencode.ai/inference/go/openai/v1/");
    vi.stubEnv("CHAT_API_KEY", "secret-example");
    let now = 100;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(JSON.parse(init!.body as string)).not.toHaveProperty("publicWording");
      now = 125;
      return sse([
        { choices: [{ delta: { role: "assistant", content: "" } }] },
        { choices: [{ delta: { reasoning_content: "private thought" } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "tool-private", function: { name: "fixture", arguments: "{}" } }] }, finish_reason: "tool_calls" }] },
        { choices: [], usage: { prompt_tokens: 10, completion_tokens: 7, completion_tokens_details: { reasoning_tokens: 5 } } },
      ]);
    });
    await requestDeepSeek({ ...baseRequest, publicWording: true, sessionId: "private-session" }, event => {
      if (event.type === "reasoning-delta") now += 80;
      if (event.type === "tool-input-delta") now += 15;
    }, { fetch: fetchMock });
    expect(log.mock.calls).toEqual([[`[model-request] ${JSON.stringify({
      service: "opencode", phase: "public", elapsedMs: 120, firstDeltaMs: 25, lastDeltaMs: 105,
      inputTokens: 10, outputTokens: 7, reasoningTokens: 5,
    })}`]]);
  });

  it("distinguishes empty output, missing usage fields, and explicitly reported zero", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const fetchMock = vi.fn(async () => sse([{ choices: [{ delta: { content: "" }, finish_reason: "stop" }], usage: { completion_tokens: 0 } }]));
    await requestDeepSeek(baseRequest, () => {}, { fetch: fetchMock });
    const metric = JSON.parse((log.mock.calls[0][0] as string).slice("[model-request] ".length));
    expect(metric).toMatchObject({ phase: "other", firstDeltaMs: null, lastDeltaMs: null, inputTokens: null, outputTokens: 0, reasoningTokens: null });
  });
});

describe("selectable OpenAI-compatible Chat transport", () => {
  it("keeps the default DeepSeek endpoint, model and credential unchanged", async () => {
    const calls: Request[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(new Request(input, init));
      return simpleResponse();
    });
    const result = await requestDeepSeek({ ...baseRequest, sessionId: "fixture-session" }, () => {}, { fetch: fetchMock });
    expect(calls[0]?.url).toBe("https://api.deepseek.com/chat/completions");
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer primary-test-key");
    expect(calls[0]?.headers.get("x-opencode-session")).toBeNull();
    expect(JSON.parse(await calls[0]!.text()).model).toBe("deepseek-flash");
    expect(result.message.content).toBe("ok");
  });

  it("uses the alternate host, model and key, preserving session, usage and tool SSE", async () => {
    vi.stubEnv("CHAT_API_HOST", "https://opencode.ai/inference/go/openai/v1/");
    vi.stubEnv("CHAT_API_KEY", "alternate-test-key");
    vi.stubEnv("CHAT_API_MODEL", "deepseek-v4.1-flash");
    const calls: Request[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(new Request(input, init));
      return sse([
        { choices: [{ delta: { content: "答案", reasoning_content: "分析" }, finish_reason: null }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "call-1", function: { name: "lookup", arguments: "{\"q\":1}" } }] }, finish_reason: "tool_calls" }] },
        { choices: [], usage: {
          prompt_tokens: 10, completion_tokens: 4, total_tokens: 14,
          prompt_tokens_details: { cached_tokens: 8 },
        } },
      ]);
    });
    const result = await requestDeepSeek({
      ...baseRequest, thinking: true, sessionId: "slice-2026-11-17-0100",
      tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }],
    }, () => {}, { fetch: fetchMock });
    expect(calls[0]?.url).toBe("https://opencode.ai/inference/go/openai/v1/chat/completions");
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer alternate-test-key");
    expect(calls[0]?.headers.get("x-opencode-session")).toBe("slice-2026-11-17-0100");
    expect(calls[0]?.headers.get("user-agent")).toBe("previously-agent/0.10.0");
    expect(JSON.parse(await calls[0]!.text()).model).toBe("deepseek-v4.1-flash");
    expect(result.message).toMatchObject({ content: "答案", reasoning_content: "分析" });
    expect(result.toolCalls).toHaveLength(1);
    expect(result.usage).toMatchObject({ cachedInputTokens: 8, uncachedInputTokens: 2, totalTokens: 14 });
  });

  it("does not retry a quota-exhausted 429 or leak the alternate key", async () => {
    vi.stubEnv("CHAT_API_HOST", "https://proxy.example/v1");
    vi.stubEnv("CHAT_API_KEY", "alternate-secret-key");
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      error: { message: "monthly allowance exhausted: insufficient_quota" },
    }), { status: 429 }));
    const failure = await requestDeepSeek({ ...baseRequest, maxRetries: 3 }, () => {}, { fetch: fetchMock }).catch(error => error);
    expect(failure).toBeInstanceOf(DeepSeekError);
    expect(failure.quotaExceeded).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(failure.message).not.toContain("alternate-secret-key");
  });

  it("keeps native DeepSeek Search on the official host and primary key", async () => {
    vi.stubEnv("CHAT_API_HOST", "https://proxy.example/v1");
    vi.stubEnv("CHAT_API_KEY", "alternate-test-key");
    const calls: Request[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(new Request(input, init));
      return Response.json({ results: [] });
    }));
    await deepseekWebSearch({ query: "fixture", count: 1 });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.deepseek.com/v1/tools/search");
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer primary-test-key");
  });
});
