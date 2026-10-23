import { requestDeepSeek, recoverPartialResponse, type HttpDependencies } from "./http";
import { runAgent } from "./runner";
import type { AgentOptions, AgentResult, ModelCallStreamPart, ToolSet } from "./types";

/** Buffered only until a consumer catches up; unused streams hold no token copies. */
class EventChannel<T> implements AsyncIterable<T> {
  private values: T[] = [];
  private offset = 0;
  private ended = false;
  private active = false;
  private wake?: () => void;
  activate() { this.active = true; return this; }
  push(value: T) { if (this.active) this.values.push(value); this.wake?.(); this.wake = undefined; }
  close() { this.ended = true; this.wake?.(); this.wake = undefined; }
  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    try {
    for (;;) {
      if (this.offset < this.values.length) {
        const next = this.values[this.offset++];
        if (this.offset > 256) { this.values.splice(0, this.offset); this.offset = 0; }
        yield next;
      } else if (this.ended) return;
      else await new Promise<void>((resolve) => { this.wake = resolve; });
    }
    } finally {
      // A caller may stop consuming while still awaiting the final result.
      // Do not retain the rest of that model response without a reader.
      this.active = false; this.values = []; this.offset = 0; this.wake = undefined;
    }
  }
}

export interface StreamingResult<Tools extends ToolSet = ToolSet> {
  text: Promise<string>; reasoningText: Promise<string>; toolCalls: Promise<AgentResult<Tools>["toolCalls"]>;
  sources: Promise<AgentResult<Tools>["sources"]>; warnings: Promise<unknown[]>;
  finishReason: Promise<string>; usage: Promise<AgentResult<Tools>["usage"]>;
  steps: Promise<AgentResult<Tools>["steps"]>; response: Promise<{ messages: AgentResult<Tools>["messages"] }>;
  fullStream: AsyncIterable<ModelCallStreamPart>; textStream: AsyncIterable<string>;
  result: Promise<AgentResult<Tools>>;
}

/** Ordinary step-local call, also used for ephemeral companion narration. */
export function streamText<Tools extends ToolSet = ToolSet>(options: AgentOptions<Tools>, dependencies: HttpDependencies = {}): StreamingResult<Tools> {
  const events = new EventChannel<ModelCallStreamPart>();
  const timeout = options.timeout === undefined ? undefined : AbortSignal.timeout(options.timeout);
  const signals = [options.abortSignal, dependencies.signal, timeout].filter((signal): signal is AbortSignal => !!signal);
  const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
  const emit = async (part: ModelCallStreamPart) => {
    events.push(part);
    await options.onChunk?.({ chunk: part });
  };
  // Begin on the next microtask, so callers can attach to the stream first.
  const result = Promise.resolve().then(() => runAgent(options, async (request) => {
    await emit({ type: "start-step" });
    return requestDeepSeek(request, emit, { ...dependencies, signal }).catch(recoverPartialResponse);
  }, emit)).catch(async (error) => {
    await options.onError?.({ error });
    await emit({ type: signal?.aborted ? "abort" : "error", error,
      errorText: error instanceof Error ? error.message : String(error) });
    throw error;
  }).finally(() => events.close());
  // Hooks/stream-only consumers need no unused rejected promises in the process.
  void result.catch(() => {});
  const mapped = <T>(pick: (value: AgentResult<Tools>) => T): Promise<T> => {
    const promise = result.then(pick); void promise.catch(() => {}); return promise;
  };
  const textStream: AsyncIterable<string> = { async *[Symbol.asyncIterator]() {
    for await (const event of events) {
      if (event.type === "text-delta" && event.text) yield event.text;
      if (event.type === "error" || event.type === "abort") throw event.error;
    }
  } };
  return { result, text: mapped((value) => value.text), reasoningText: mapped((value) => value.reasoningText),
    toolCalls: mapped((value) => value.toolCalls), sources: mapped((value) => value.sources), warnings: mapped((value) => value.warnings),
    finishReason: mapped((value) => value.finishReason), usage: mapped((value) => value.usage), steps: mapped((value) => value.steps),
    response: mapped((value) => ({ messages: value.messages })),
    get fullStream() { return events.activate(); }, get textStream() { events.activate(); return textStream; } };
}
export async function generateText<Tools extends ToolSet = ToolSet>(options: AgentOptions<Tools>, dependencies?: HttpDependencies): Promise<AgentResult<Tools>> {
  return streamText(options, dependencies).result;
}
