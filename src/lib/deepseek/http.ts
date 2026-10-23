import { deepseekApiKey } from "./credentials";
import { readSse } from "./sse";
import { DEEPSEEK_MODEL, type ModelRequest, type ModelResponse, type ModelCallStreamPart, type NativeToolCall, type TokenUsage } from "./types";

const ENDPOINT = "https://api.deepseek.com/chat/completions";
const FIRST_RESPONSE_MS = 90_000;

export class DeepSeekError extends Error {
  constructor(message: string, readonly statusCode?: number, readonly retryAfterMs?: number, readonly partial?: ModelResponse) {
    super(message); this.name = "DeepSeekError";
  }
}
/** Keep partial model output serializable across a completed durable step. */
export function recoverPartialResponse(error: unknown): ModelResponse {
  if (error instanceof DeepSeekError && error.partial) return error.partial;
  throw error;
}
export function emptyUsage(): TokenUsage {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0, reasoningTokens: 0, cachedInputTokens: 0, uncachedInputTokens: 0 };
}
function usageFrom(raw: Record<string, unknown>): TokenUsage {
  const num = (key: string) => typeof raw[key] === "number" ? raw[key] as number : 0;
  const details = raw.completion_tokens_details as { reasoning_tokens?: number } | undefined;
  return { inputTokens: num("prompt_tokens"), outputTokens: num("completion_tokens"), totalTokens: num("total_tokens"),
    reasoningTokens: details?.reasoning_tokens ?? 0, cachedInputTokens: num("prompt_cache_hit_tokens"),
    uncachedInputTokens: typeof raw.prompt_cache_miss_tokens === "number" ? num("prompt_cache_miss_tokens") : num("prompt_tokens") - num("prompt_cache_hit_tokens") };
}
function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); reject(signal?.reason); };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
function retryable(error: unknown): boolean {
  if (error instanceof DeepSeekError) return error.statusCode === 408 || error.statusCode === 429 || (error.statusCode !== undefined && error.statusCode >= 500 && error.statusCode <= 599);
  return error instanceof TypeError || (error instanceof Error && /ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket|fetch failed/i.test(error.message));
}
export type HttpDependencies = {
  fetch?: typeof fetch; apiKey?: string; signal?: AbortSignal;
  wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
};

/** One HTTP model call. A partial response is never automatically requested again. */
export async function requestDeepSeek(
  request: ModelRequest,
  emit: (part: ModelCallStreamPart) => void | Promise<void>,
  deps: HttpDependencies = {},
): Promise<ModelResponse> {
  const apiKey = deps.apiKey ?? deepseekApiKey();
  const safeMessage = (value: string) => (apiKey ? value.split(apiKey).join("[redacted]") : value).slice(0, 2000);
  const timeoutSignal = request.timeoutMs === undefined ? undefined : AbortSignal.timeout(request.timeoutMs);
  const signals = [deps.signal, timeoutSignal].filter((signal): signal is AbortSignal => !!signal);
  const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
  const nativeToolChoice = typeof request.toolChoice === "object"
    ? { type: "function", function: { name: request.toolChoice.toolName } } : request.toolChoice;
  if (request.thinking && (nativeToolChoice === "required" || typeof nativeToolChoice === "object")) {
    throw new DeepSeekError("DeepSeek thinking mode requires auto or none tool choice.", 400);
  }
  const body = JSON.stringify({
    model: DEEPSEEK_MODEL, messages: request.messages, stream: true, stream_options: { include_usage: true },
    thinking: { type: request.thinking ? "enabled" : "disabled" },
    ...(request.thinking ? { reasoning_effort: request.reasoningEffort } : {}),
    ...(request.tools?.length ? { tools: request.tools, tool_choice: nativeToolChoice ?? "auto" } : {}),
    ...(!request.thinking && request.temperature !== undefined ? { temperature: request.temperature } : {}),
  });
  const maxRetries = request.maxRetries ?? 2;
  let response: Response | undefined;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    signal?.throwIfAborted();
    const headerController = new AbortController();
    const headerTimer = setTimeout(() => headerController.abort(new DOMException("DeepSeek response headers timed out", "TimeoutError")), FIRST_RESPONSE_MS);
    try {
      response = await (deps.fetch ?? fetch)(ENDPOINT, {
        method: "POST", redirect: "error", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body, signal: signal ? AbortSignal.any([signal, headerController.signal]) : headerController.signal,
      });
      clearTimeout(headerTimer);
      if (response.ok) break;
      const retryAfter = response.headers.get("retry-after");
      const retryMs = retryAfter === null ? undefined : /^\d+(\.\d+)?$/.test(retryAfter)
        ? Number(retryAfter) * 1000 : Math.max(0, Date.parse(retryAfter) - Date.now());
      // Provider errors are data, never interpolate request bodies or keys.
      const errorBody = safeMessage(await response.text());
      let message = `DeepSeek request failed (${response.status})`;
      try { const parsed = JSON.parse(errorBody); if (typeof parsed.error?.message === "string") message += `: ${parsed.error.message}`; } catch { /* status remains useful */ }
      throw new DeepSeekError(message, response.status, retryMs);
    } catch (error) {
      clearTimeout(headerTimer);
      if (signal?.aborted) throw signal.reason;
      if (attempt === maxRetries || !retryable(error)) {
        if (error instanceof DeepSeekError || (error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name))) throw error;
        throw new DeepSeekError(safeMessage(error instanceof Error ? error.message : "DeepSeek request failed"));
      }
      const waitMs = error instanceof DeepSeekError && Number.isFinite(error.retryAfterMs)
        ? Math.min(60_000, Math.max(0, error.retryAfterMs!)) : Math.min(8000, 500 * 2 ** attempt);
      await (deps.wait ?? abortableDelay)(waitMs, signal);
    }
  }
  if (!response?.body) throw new DeepSeekError("DeepSeek returned no response body");

  let text = "";
  let reasoning = "";
  let textStarted = false;
  let reasoningStarted = false;
  let finishReason = "";
  let usage = emptyUsage();
  const calls = new Map<number, NativeToolCall>();
  const textId = `${request.callId}:text`;
  const reasoningId = `${request.callId}:reasoning`;
  const idleController = new AbortController();
  const streamSignal = signal ? AbortSignal.any([signal, idleController.signal]) : idleController.signal;
  let idleTimer: ReturnType<typeof setTimeout>;
  const activity = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => idleController.abort(new DOMException("DeepSeek stream activity timed out", "TimeoutError")), FIRST_RESPONSE_MS);
  };
  activity();
  try {
  for await (const event of readSse(response.body, { signal: streamSignal, onActivity: activity })) {
    signal?.throwIfAborted();
    if (event === "[DONE]") break;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(event);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    } catch { throw new DeepSeekError("DeepSeek returned an invalid SSE JSON event"); }
    if (parsed.error) {
      const error = parsed.error as { message?: unknown; status?: number };
      throw new DeepSeekError(typeof error.message === "string" ? safeMessage(error.message) : "DeepSeek stream failed", error.status);
    }
    if (parsed.usage && typeof parsed.usage === "object") usage = usageFrom(parsed.usage as Record<string, unknown>);
    const choices = parsed.choices as Array<{ delta?: { content?: string | null; reasoning_content?: string | null; tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> }; finish_reason?: string | null }> | undefined;
    const choice = choices?.[0];
    if (!choice) continue;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const delta = choice.delta;
    if (!delta) continue;
    if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
      if (!reasoningStarted) { reasoningStarted = true; await emit({ type: "reasoning-start", id: reasoningId }); }
      reasoning += delta.reasoning_content;
      await emit({ type: "reasoning-delta", id: reasoningId, delta: delta.reasoning_content, text: delta.reasoning_content });
    }
    if (typeof delta.content === "string" && delta.content) {
      if (!textStarted) { textStarted = true; await emit({ type: "text-start", id: textId }); }
      text += delta.content;
      await emit({ type: "text-delta", id: textId, delta: delta.content, text: delta.content });
    }
    for (const fragment of delta.tool_calls ?? []) {
      const index = fragment.index ?? 0;
      if (!Number.isInteger(index) || index < 0) throw new DeepSeekError("DeepSeek returned an invalid tool index");
      let call = calls.get(index);
      if (!call) {
        if (!fragment.id || !fragment.function?.name) throw new DeepSeekError("DeepSeek tool call is missing its id or name");
        call = { id: fragment.id, type: "function", function: { name: fragment.function.name, arguments: "" } };
        calls.set(index, call);
        await emit({ type: "tool-input-start", toolCallId: call.id, toolName: call.function.name });
      } else if ((fragment.id && fragment.id !== call.id) || (fragment.function?.name && fragment.function.name !== call.function.name)) {
        throw new DeepSeekError("DeepSeek changed a tool identity within one streamed call");
      }
      if (fragment.function?.arguments) {
        call.function.arguments += fragment.function.arguments;
        await emit({ type: "tool-input-delta", toolCallId: call.id, inputTextDelta: fragment.function.arguments });
      }
    }
  }
  if (!finishReason) throw new DeepSeekError("DeepSeek stream ended before a finish reason; partial output is incomplete");
  } catch (error) {
    const message = safeMessage(error instanceof Error ? error.message : "DeepSeek stream failed");
    const statusCode = error instanceof DeepSeekError ? error.statusCode : undefined;
    // Settle visible fragments as failed even though they cannot enter model
    // history. A disconnected output writer must not prevent the checkpoint.
    try {
      if (reasoningStarted) await emit({ type: "reasoning-end", id: reasoningId });
      if (textStarted) await emit({ type: "text-end", id: textId });
      for (const call of calls.values()) await emit({ type: "tool-input-error", toolCallId: call.id,
        toolName: call.function.name, errorText: "The model response ended before this tool call completed." });
    } catch { /* The partial response remains available without its UI stream. */ }
    // An interrupted tool fragment is never a real assistant tool call. Keep
    // only received prose/thinking so continuation cannot execute or replay it.
    const partial: ModelResponse | undefined = text || reasoning ? {
      message: { role: "assistant", content: text, reasoning_content: reasoning },
      toolCalls: [], finishReason: "error", usage, error: { message, ...(statusCode === undefined ? {} : { statusCode }) },
    } : undefined;
    if (!partial && error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name)) throw error;
    throw new DeepSeekError(message, statusCode, undefined, partial);
  } finally { clearTimeout(idleTimer!); }
  if (reasoningStarted) await emit({ type: "reasoning-end", id: reasoningId });
  if (textStarted) await emit({ type: "text-end", id: textId });
  const toolCalls = [...calls].sort(([a], [b]) => a - b).map(([, call]) => call);
  return { message: { role: "assistant", content: text, reasoning_content: reasoning, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) },
    toolCalls, finishReason, usage };
}
