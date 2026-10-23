import { applyChatEvent, createChatAssembly, readChatEvents, snapshotChatMessage } from "./client-stream";
import type { UIMessage, UIMessageChunk } from "./protocol";

export interface DurableStreamOptions {
  runId: string | null;
  assistantId: string;
  signal: AbortSignal;
  response?: Response;
  fetch?: typeof fetch;
  onMessage: (message: UIMessage) => void;
  onData?: (chunk: UIMessageChunk) => void;
  /** Override only in isolated tests; production reconnects back off. */
  retryDelayMs?: number;
}

function waitForReconnect(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

/** Reconnect only to the durable GET route. Rebuilding from index zero is
 * intentionally independent of transport chunk boundaries and model attempts. */
export async function readDurableChat(options: DurableStreamOptions): Promise<UIMessage> {
  const request = options.fetch ?? fetch;
  let response = options.response;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (options.signal.aborted) throw new DOMException("Aborted", "AbortError");
    const assembly = createChatAssembly(options.assistantId);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const publish = () => {
      clearTimeout(timer);
      timer = undefined;
      if (!options.signal.aborted) options.onMessage(snapshotChatMessage(assembly));
    };
    try {
      if (!response && !options.runId) throw Object.assign(new Error("Run not available"), { terminal: true });
      response ??= await request(`/api/chat/${encodeURIComponent(options.runId!)}/stream?startIndex=0`, { cache: "no-store", signal: options.signal });
      if (!response.ok || !response.body) {
        throw Object.assign(new Error(`Chat stream HTTP ${response.status}`), {
          terminal: response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429,
        });
      }
      for await (const chunk of readChatEvents(response.body, options.signal)) {
        if (chunk.type === "error") throw Object.assign(new Error(chunk.errorText || "Chat failed"), { terminal: true });
        applyChatEvent(assembly, chunk);
        if (chunk.type.startsWith("data-")) options.onData?.(chunk);
        timer ??= setTimeout(publish, 50);
        if (assembly.finished) break;
      }
      if (options.signal.aborted) throw new DOMException("Aborted", "AbortError");
      if (!assembly.finished) throw new Error("Chat stream disconnected before completion");
      publish();
      return snapshotChatMessage(assembly);
    } catch (cause) {
      // Preserve visible output, including the last batch before disconnection.
      if (assembly.message.parts.length) publish();
      if (options.signal.aborted || (cause as { terminal?: boolean })?.terminal || !options.runId || attempt === 3) throw cause;
      response = undefined;
      await waitForReconnect((options.retryDelayMs ?? 500) * 2 ** attempt, options.signal);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error("Chat stream could not be resumed");
}
