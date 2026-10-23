import type { UIMessage, UIMessageChunk, UIMessagePart } from "./protocol";

/** Read SSE without assuming network chunks coincide with UTF-8 characters,
 * lines, or events. A disconnect is not a successful completed answer. */
export async function* readChatEvents(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<UIMessageChunk> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    for (;;) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        const frame = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        const data = frame.split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).replace(/^ /, "")).join("\n");
        if (!data) continue;
        if (data === "[DONE]") return;
        const event: unknown = JSON.parse(data);
        if (!event || typeof event !== "object" || typeof (event as UIMessageChunk).type !== "string") {
          throw new Error("Invalid chat stream event");
        }
        yield event as UIMessageChunk;
      }
      if (done) return;
    }
  } finally {
    signal?.removeEventListener("abort", cancel);
    try { await reader.cancel(); } catch { /* closed or disconnected */ }
    reader.releaseLock();
  }
}

export interface ChatAssembly {
  message: UIMessage;
  blocks: Map<string, number>;
  toolInputs: Map<string, string>;
  finished: boolean;
}

export function createChatAssembly(id: string): ChatAssembly {
  return { message: { id, role: "assistant", parts: [] }, blocks: new Map(), toolInputs: new Map(), finished: false };
}

/** A fresh assembly is used for a full durable replay. Block IDs are scoped to
 * that replay, so reconnects replace the partial answer instead of doubling it. */
export function applyChatEvent(state: ChatAssembly, chunk: UIMessageChunk): void {
  const parts = state.message.parts;
  if (chunk.type === "error") throw new Error(chunk.errorText || "Chat failed");
  if (chunk.type === "start") {
    if (chunk.messageId) state.message.id = chunk.messageId;
    if (chunk.messageMetadata !== undefined) state.message.metadata = chunk.messageMetadata;
    return;
  }
  if (chunk.type === "message-metadata") {
    state.message.metadata = chunk.messageMetadata;
    return;
  }
  if (chunk.type === "finish" || chunk.type === "abort") {
    state.finished = true;
    for (const part of parts) if (part.type === "text" || part.type === "reasoning") part.state = "done";
    return;
  }
  if (chunk.type === "start-step") { parts.push({ type: "step-start" }); return; }
  if (chunk.type.startsWith("data-")) {
    if (chunk.transient) return;
    const part = { type: chunk.type as `data-${string}`, id: chunk.id, data: chunk.data };
    const previous = chunk.id ? parts.findIndex((p) => p.type === chunk.type && "id" in p && p.id === chunk.id) : -1;
    if (previous < 0) parts.push(part); else parts[previous] = part;
    return;
  }
  const block = /^(text|reasoning)-(start|delta|end)$/.exec(chunk.type);
  if (block) {
    const type = block[1] as "text" | "reasoning";
    const key = `${type}:${chunk.id ?? type}`;
    let at = state.blocks.get(key);
    if (at === undefined) {
      at = parts.length;
      state.blocks.set(key, at);
      parts.push({ type, text: "", state: "streaming" });
    }
    const part = parts[at] as Extract<UIMessagePart, { type: "text" | "reasoning" }>;
    if (block[2] === "delta") part.text += chunk.delta ?? chunk.text ?? "";
    if (block[2] === "end") part.state = "done";
    if (chunk.providerMetadata) part.providerMetadata = { ...part.providerMetadata, ...chunk.providerMetadata };
    return;
  }
  if (chunk.type.startsWith("tool-") && chunk.toolCallId) {
    let at = parts.findIndex((part) => "toolCallId" in part && part.toolCallId === chunk.toolCallId);
    if (at < 0) {
      at = parts.length;
      parts.push({ type: `tool-${chunk.toolName ?? "tool"}`, toolCallId: chunk.toolCallId, toolName: chunk.toolName ?? "tool", state: "input-streaming" });
    }
    const part = parts[at] as Extract<UIMessagePart, { toolCallId: string }>;
    if (chunk.toolName) { part.toolName = chunk.toolName; part.type = `tool-${chunk.toolName}`; }
    if (chunk.type === "tool-input-delta") {
      const text = (state.toolInputs.get(chunk.toolCallId) ?? "") + (chunk.inputTextDelta ?? "");
      state.toolInputs.set(chunk.toolCallId, text);
      try { part.input = JSON.parse(text); } catch { /* Wait for a complete argument. */ }
    } else if (chunk.type === "tool-input-available") {
      part.input = chunk.input;
      part.state = "input-available";
    } else if (chunk.type === "tool-output-available") {
      part.output = chunk.output;
      part.state = "output-available";
    } else if (chunk.type === "tool-output-error" || chunk.type === "tool-input-error") {
      part.errorText = chunk.errorText;
      part.state = "output-error";
    } else if (chunk.type === "tool-output-denied") part.state = "output-denied";
  }
}

export function snapshotChatMessage(state: ChatAssembly): UIMessage {
  return { ...state.message, parts: state.message.parts.map((part) => ({ ...part })) };
}

/** Regeneration retains the original user ID and drops only its answer/tail. */
export function regenerationMessages(messages: readonly UIMessage[], messageId?: string): UIMessage[] {
  let at = messageId ? messages.findIndex((message) => message.id === messageId) : messages.length - 1;
  if (at < 0) throw new Error("Message is no longer available");
  while (at >= 0 && messages[at].role !== "user") at--;
  if (at < 0) throw new Error("No user message to regenerate");
  return messages.slice(0, at + 1);
}
