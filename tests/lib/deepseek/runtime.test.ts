import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { requestDeepSeek } from "../../../src/lib/deepseek/http";
import { readSse } from "../../../src/lib/deepseek/sse";
import { generateText, streamText } from "../../../src/lib/deepseek/generate";
import { tool, isStepCount } from "../../../src/lib/deepseek/tools";
import { toNativeMessages } from "../../../src/lib/deepseek/messages";
import type { ModelRequest, ModelCallStreamPart, StepResult } from "../../../src/lib/deepseek/types";

const encoder = new TextEncoder();
const event = (delta: unknown, finish_reason: string | null = null, usage?: unknown) =>
  ({ choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}) });
function response(events: unknown[], fragment = 7): Response {
  const bytes = encoder.encode(": keep-alive\r\n\r\n" + events.map((item) => `data: ${JSON.stringify(item)}\r\n\r\n`).join("") + "data: [DONE]\r\n\r\n");
  return new Response(new ReadableStream<Uint8Array>({ start(controller) {
    for (let i = 0; i < bytes.length; i += fragment) controller.enqueue(bytes.slice(i, i + fragment));
    controller.close();
  } }), { headers: { "Content-Type": "text/event-stream" } });
}
const base: ModelRequest = { messages: [{ role: "user", content: "fixture" }], thinking: true, reasoningEffort: "high", callId: "fixture" };

describe("DeepSeek native protocol", () => {
  it("decodes split UTF-8, CRLF, keep-alive comments and multiline data", async () => {
    const bytes = encoder.encode(": ping\r\n\r\ndata: 你🙂\r\ndata: second\r\n\r\n");
    const body = new ReadableStream<Uint8Array>({ start(controller) { for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); controller.close(); } });
    const out = [];
    for await (const value of readSse(body)) out.push(value);
    expect(out).toEqual(["你🙂\nsecond"]);
  });

  it("discards an unterminated final SSE frame", async () => {
    const body = new Response('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}').body!;
    const out = [];
    for await (const value of readSse(body)) out.push(value);
    expect(out).toEqual([]);
  });

  it("cancels a stalled body reader when the owning request is aborted", async () => {
    const controller = new AbortController();
    const cancelled = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel: cancelled });
    const reader = readSse(body, { signal: controller.signal });
    const pending = reader.next();
    controller.abort(new Error("fixture stop"));
    await expect(pending).rejects.toThrow("fixture stop");
    expect(cancelled).toHaveBeenCalledTimes(1);
  });

  it("preserves thinking, indexed tool fragments, final-block usage and fixed settings", async () => {
    let sent: Record<string, unknown> = {};
    const chunks: ModelCallStreamPart[] = [];
    const fetcher = vi.fn(async (_url, init) => {
      sent = JSON.parse(init!.body as string);
      return response([
        event({ reasoning_content: "思考🙂" }),
        event({ content: "Checking", tool_calls: [{ index: 1, id: "b", function: { name: "beta", arguments: '{"n":' } }, { index: 0, id: "a", function: { name: "alpha", arguments: '{"x":"' } }] }),
        event({ tool_calls: [{ index: 0, function: { arguments: '汉字"}' } }, { index: 1, function: { arguments: "2}" } }] }),
        event({}, "tool_calls", { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_cache_hit_tokens: 80, prompt_cache_miss_tokens: 20, completion_tokens_details: { reasoning_tokens: 15 } }),
      ], 1);
    }) as typeof fetch;
    const result = await requestDeepSeek(base, (part) => { chunks.push(part); }, { fetch: fetcher, apiKey: "fixture" });
    expect(sent.model).toBe("deepseek-flash");
    expect(sent.reasoning_effort).toBe("high");
    expect(sent).not.toHaveProperty("max_tokens");
    expect(sent.thinking).toEqual({ type: "enabled" });
    expect(result.message.reasoning_content).toBe("思考🙂");
    expect(result.toolCalls.map((call) => [call.id, call.function.arguments])).toEqual([["a", '{"x":"汉字"}'], ["b", '{"n":2}']]);
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 20, totalTokens: 120, reasoningTokens: 15, cachedInputTokens: 80, uncachedInputTokens: 20 });
    expect(chunks.find((part) => part.type === "reasoning-delta")).toMatchObject({ text: "思考🙂", delta: "思考🙂", id: "fixture:reasoning" });
  });

  it("retries throttles before any output and honors retry-after", async () => {
    const wait = vi.fn(async () => {});
    const fetcher = vi.fn().mockResolvedValueOnce(new Response('{"error":{"message":"busy"}}', { status: 429, headers: { "Retry-After": "3" } }))
      .mockResolvedValueOnce(response([event({ content: "ok" }), event({}, "stop")]));
    await requestDeepSeek(base, () => {}, { fetch: fetcher, apiKey: "fixture", wait });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledWith(3000, undefined);
  });

  it("does not retry invalid requests or malformed/partial streams", async () => {
    const badRequest = vi.fn(async () => new Response('{"error":{"message":"invalid input"}}', { status: 400 }));
    await expect(requestDeepSeek(base, () => {}, { fetch: badRequest, apiKey: "fixture" })).rejects.toMatchObject({ statusCode: 400 });
    expect(badRequest).toHaveBeenCalledTimes(1);
    const partial = vi.fn(async () => response([event({ content: "partial" })]));
    const seen: string[] = [];
    await expect(requestDeepSeek(base, (part) => { if (part.text) seen.push(part.text); }, { fetch: partial, apiKey: "fixture" })).rejects.toThrow("before a finish reason");
    expect(partial).toHaveBeenCalledTimes(1);
    expect(seen).toEqual(["partial"]);
  });

  it("aborts before dispatch without spending a request", async () => {
    const fetcher = vi.fn();
    const signal = AbortSignal.abort(new Error("fixture cancelled"));
    await expect(requestDeepSeek(base, () => {}, { fetch: fetcher, apiKey: "fixture", signal })).rejects.toThrow("fixture cancelled");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("redacts provider-echoed credentials and bounds exhausted network retries", async () => {
    const secret = "secret-fixture-key";
    const bad = vi.fn(async () => new Response(JSON.stringify({ error: { message: `Rejected ${secret}` } }), { status: 401 }));
    await expect(requestDeepSeek(base, () => {}, { fetch: bad, apiKey: secret })).rejects.toThrow("Rejected [redacted]");
    const stream = vi.fn(async () => response([{ error: { message: `Rejected ${secret}` } }]));
    await expect(requestDeepSeek(base, () => {}, { fetch: stream, apiKey: secret })).rejects.toThrow("Rejected [redacted]");
    const unavailable = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    await expect(requestDeepSeek(base, () => {}, { fetch: unavailable, apiKey: secret, wait: async () => {} })).rejects.toMatchObject({ name: "DeepSeekError", message: "fetch failed" });
    expect(unavailable).toHaveBeenCalledTimes(3);
  });

  it("keeps images and exact historical native assistant data", () => {
    const native = { role: "assistant" as const, content: "earlier", reasoning_content: "complete earlier reasoning" };
    expect(toNativeMessages([
      { role: "assistant", content: "display text", deepseek: native },
      { role: "user", content: [{ type: "image", image: new Uint8Array([1, 2, 3]), mediaType: "image/png" }] },
    ])).toEqual([native, { role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AQID" } }] }]);
  });
});

describe("DeepSeek tool loop", () => {
  it("executes validated tools then returns the full original thinking to the next call", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const execute = vi.fn(async (input: { query: string }, { context }: { context: { timezone: string } }) => `${input.query}:${context.timezone}`);
    const fetcher = vi.fn(async (_url, init) => {
      requests.push(JSON.parse(init!.body as string));
      return requests.length === 1 ? response([
        event({ reasoning_content: "Original full reasoning" }),
        event({ tool_calls: [{ index: 0, id: "call-original", function: { name: "lookup", arguments: '{"query":"hello"}' } }] }),
        event({}, "tool_calls"),
      ]) : response([event({ reasoning_content: "now answer" }), event({ content: "done" }), event({}, "stop")]);
    }) as typeof fetch;
    const result = await generateText({ system: "fixed prefix", prompt: "question", stopWhen: isStepCount(3), tools: {
      lookup: tool({ inputSchema: z.object({ query: z.string() }), contextSchema: z.object({ timezone: z.string() }), execute }),
    }, toolsContext: { lookup: { timezone: "Asia/Shanghai" } } }, { fetch: fetcher, apiKey: "fixture" });
    expect(execute).toHaveBeenCalledTimes(1);
    expect((requests[1].messages as unknown[])[2]).toEqual({ role: "assistant", content: "", reasoning_content: "Original full reasoning",
      tool_calls: [{ id: "call-original", type: "function", function: { name: "lookup", arguments: '{"query":"hello"}' } }] });
    expect((requests[1].messages as unknown[])[3]).toEqual({ role: "tool", tool_call_id: "call-original", content: "hello:Asia/Shanghai" });
    expect(result.text).toBe("done");
    expect(result.steps).toHaveLength(2);
    expect(result.messages[0]).toEqual({ role: "system", content: "fixed prefix" });
    expect(result.messages[2].deepseek?.reasoning_content).toBe("Original full reasoning");
  });

  it("never executes invalid arguments and lets the next round repair them", async () => {
    const execute = vi.fn(async () => "landed");
    const requests: Array<Record<string, unknown>> = [];
    const fetcher = vi.fn(async (_url, init) => {
      requests.push(JSON.parse(init!.body as string));
      return requests.length === 1 ? response([event({ tool_calls: [{ index: 0, id: "bad", function: { name: "write", arguments: '{"count":"oops"}' } }] }), event({}, "tool_calls")])
        : response([event({ content: "cannot write" }), event({}, "stop")]);
    }) as typeof fetch;
    const result = await generateText({ prompt: "fixture", stopWhen: isStepCount(2), tools: {
      write: tool({ inputSchema: z.object({ count: z.number() }), execute }),
    } }, { fetch: fetcher, apiKey: "fixture" });
    expect(execute).not.toHaveBeenCalled();
    expect(result.steps[0].toolCalls[0].invalid).toBe(true);
    expect(JSON.stringify(requests[1].messages)).toContain("Invalid input");
  });

  it("does not execute tool calls when the provider reports truncation", async () => {
    const execute = vi.fn();
    const fetcher = vi.fn(async () => response([event({ tool_calls: [{ index: 0, id: "cut", function: { name: "write", arguments: "{}" } }] }), event({}, "length")]));
    const result = await generateText({ prompt: "fixture", tools: { write: tool({ inputSchema: z.object({}), execute }) } }, { fetch: fetcher, apiKey: "fixture" });
    expect(execute).not.toHaveBeenCalled();
    expect(result.finishReason).toBe("length");
    expect(toNativeMessages(result.messages).at(-1)).not.toHaveProperty("tool_calls");
    expect(result.steps[0].response.messages[0]).not.toHaveProperty("deepseek.tool_calls");
  });

  it("checkpoints partial text and thinking before surfacing a stream failure", async () => {
    const execute = vi.fn();
    const snapshots: StepResult[] = [];
    const chunks: ModelCallStreamPart[] = [];
    const fetcher = vi.fn(async () => response([
      event({ reasoning_content: "received reasoning", content: "partial answer", tool_calls: [{ index: 0, id: "incomplete", function: { name: "write", arguments: '{"text":' } }] }),
      { choices: [], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5, prompt_cache_hit_tokens: 1, completion_tokens_details: { reasoning_tokens: 2 } } },
    ]));
    await expect(generateText({ prompt: "fixture", tools: { write: tool({ inputSchema: z.object({ text: z.string() }), execute }) },
      onStepEnd: (step) => { snapshots.push(step); }, onChunk: ({ chunk }) => { chunks.push(chunk); },
    }, { fetch: fetcher, apiKey: "fixture" })).rejects.toMatchObject({ name: "DeepSeekError" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({ text: "partial answer", reasoningText: "received reasoning", finishReason: "error", toolCalls: [], toolResults: [] });
    expect(toNativeMessages(snapshots[0].response.messages)).toEqual([
      { role: "assistant", content: "partial answer", reasoning_content: "received reasoning" },
    ]);
    expect(chunks.findIndex((chunk) => chunk.type === "data-deepseek-step")).toBeLessThan(chunks.findIndex((chunk) => chunk.type === "error"));
    expect(chunks.filter((chunk) => chunk.type === "finish")).toHaveLength(0);
    expect(snapshots[0].usage).toEqual({ inputTokens: 2, outputTokens: 3, totalTokens: 5, reasoningTokens: 2, cachedInputTokens: 1, uncachedInputTokens: 1 });
    expect(chunks).toContainEqual(expect.objectContaining({ type: "tool-input-error", toolCallId: "incomplete" }));
  });

  it("returns validated report-only tools and disables thinking only when requested", async () => {
    const onToolExecutionStart = vi.fn();
    let sent: Record<string, unknown> = {};
    const fetcher = vi.fn(async (_url, init) => {
      sent = JSON.parse(init!.body as string);
      return response([event({ tool_calls: [{ index: 0, id: "report", function: { name: "report", arguments: '{"answer":"yes"}' } }] }), event({}, "tool_calls")]);
    }) as typeof fetch;
    const result = await generateText({ prompt: "fixture", thinking: false, toolChoice: "required", role: "summary", onToolExecutionStart,
      tools: { report: tool({ inputSchema: z.object({ answer: z.string() }) }) } }, { fetch: fetcher, apiKey: "fixture" });
    expect(result.toolCalls[0].input).toEqual({ answer: "yes" });
    expect(sent.thinking).toEqual({ type: "disabled" });
    expect(sent.tool_choice).toBe("required");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(onToolExecutionStart).toHaveBeenCalledWith({ toolCall: expect.objectContaining({ toolName: "report", input: { answer: "yes" } }) });
  });

  it("cancels the HTTP reader and retains the final partial when a caller aborts", async () => {
    const cancelled = vi.fn();
    const controller = new AbortController();
    const onStepEnd = vi.fn();
    const body = new ReadableStream<Uint8Array>({ start(stream) {
      stream.enqueue(encoder.encode(`data: ${JSON.stringify(event({ content: "received" }))}\n\n`));
    }, cancel: cancelled });
    const fetcher = vi.fn(async () => new Response(body));
    const stream = streamText({ prompt: "fixture", abortSignal: controller.signal, onStepEnd }, { fetch: fetcher, apiKey: "fixture" });
    for await (const chunk of stream.fullStream) if (chunk.type === "text-delta") break;
    controller.abort(new DOMException("cancelled by caller", "AbortError"));
    await expect(stream.result).rejects.toMatchObject({ name: "DeepSeekError", message: "cancelled by caller" });
    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(onStepEnd).toHaveBeenCalledWith(expect.objectContaining({ text: "received", finishReason: "error" }));
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("streams immediately with stable unique part ids and a single terminal event", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(response([event({ content: "one", tool_calls: [{ index: 0, id: "t", function: { name: "lookup", arguments: "{}" } }] }), event({}, "tool_calls")]))
      .mockResolvedValueOnce(response([event({ content: "two" }), event({}, "stop")]));
    const stream = streamText({ prompt: "fixture", stopWhen: isStepCount(2), tools: { lookup: tool({ inputSchema: z.object({}), execute: async () => "value" }) } }, { fetch: fetcher, apiKey: "fixture" });
    const events: ModelCallStreamPart[] = [];
    for await (const part of stream.fullStream) events.push(part);
    expect(events.filter((part) => part.type === "text-start").map((part) => part.id)).toEqual(["agent:0:text", "agent:1:text"]);
    expect(events.filter((part) => part.type === "finish")).toHaveLength(1);
    expect(events.filter((part) => part.type === "data-deepseek-step")).toHaveLength(2);
    expect(events.find((part) => part.type === "data-deepseek-step")).toMatchObject({
      id: "agent:0:replay", data: { messages: [
        expect.objectContaining({ role: "assistant", deepseek: expect.objectContaining({ tool_calls: [expect.objectContaining({ id: "t", function: { name: "lookup", arguments: "{}" } })] }) }),
        expect.objectContaining({ role: "tool" }),
      ] },
    });
    expect(await stream.text).toBe("two");
  });

  it("runs independent tools concurrently and keeps model history in tool-call order", async () => {
    let release!: () => void;
    const bothStarted = new Promise<void>((resolve) => { release = resolve; });
    const starts: string[] = [];
    const first = vi.fn(async () => { starts.push("first"); await bothStarted; return "first result"; });
    const second = vi.fn(async () => { starts.push("second"); release(); return "second result"; });
    const fetcher = vi.fn(async () => response([event({ tool_calls: [
      { index: 0, id: "a", function: { name: "first", arguments: "{}" } },
      { index: 1, id: "b", function: { name: "second", arguments: "{}" } },
    ] }), event({}, "tool_calls")]));
    const result = await generateText({ prompt: "fixture", tools: {
      first: tool({ inputSchema: z.object({}), execute: first }), second: tool({ inputSchema: z.object({}), execute: second }),
    } }, { fetch: fetcher, apiKey: "fixture" });
    expect(starts).toEqual(["first", "second"]);
    expect(result.toolResults.map((item) => item.output)).toEqual(["first result", "second result"]);
    expect(result.messages.filter((message) => message.role === "tool").map((message) => message.content)).toEqual([
      [expect.objectContaining({ toolCallId: "a" })], [expect.objectContaining({ toolCallId: "b" })],
    ]);
  });

  it("returns ordinary tool failures as paired results instead of losing successful reads", async () => {
    const fetcher = vi.fn(async () => response([event({ tool_calls: [
      { index: 0, id: "failure", function: { name: "read", arguments: "{}" } },
    ] }), event({}, "tool_calls")]));
    const result = await generateText({ prompt: "fixture", tools: {
      read: tool({ inputSchema: z.object({}), execute: async () => { throw new Error("page unavailable"); } }),
    } }, { fetch: fetcher, apiKey: "fixture" });
    expect(result.toolResults[0].error).toBe("page unavailable");
    expect(result.messages.at(-1)).toMatchObject({ role: "tool", content: [{ toolCallId: "failure", output: { type: "error-json", value: { error: "page unavailable" } } }] });
  });
});
