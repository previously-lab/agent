import { describe, expect, it, vi } from "vitest";
import { applyChatEvent, createChatAssembly, readChatEvents, regenerationMessages, snapshotChatMessage } from "@/lib/chat/client-stream";
import { buildStream } from "@/lib/chat/build-stream";
import type { UIMessage, UIMessageChunk } from "@/lib/chat/protocol";

function bytes(text: string, size = 1) {
  const encoded = new TextEncoder().encode(text);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < encoded.length; i += size) controller.enqueue(encoded.slice(i, i + size));
      controller.close();
    },
  });
}

describe("project chat SSE", () => {
  it("decodes byte-split UTF-8, CRLF, comments, and multiline data", async () => {
    const result = [];
    for await (const event of readChatEvents(bytes(': keep-alive\r\n\r\ndata: {"type":"text-delta",\r\ndata: "id":"a","delta":"你好 🌱"}\r\n\r\ndata: {"type":"finish"}\r\n\r\ndata: [DONE]\r\n\r\n'))) result.push(event);
    expect(result).toEqual([{ type: "text-delta", id: "a", delta: "你好 🌱" }, { type: "finish" }]);
  });

  it("cancels and releases the upstream reader after the consumer sees finish", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode('data: {"type":"finish"}\n\n')); }, cancel });
    for await (const event of readChatEvents(stream)) { expect(event.type).toBe("finish"); break; }
    expect(cancel).toHaveBeenCalledOnce();
    expect(stream.locked).toBe(false);
  });

  it("does not silently discard malformed events or turn EOF into completion", async () => {
    await expect(async () => { for await (const _event of readChatEvents(bytes('data: broken\n\n'))) { /* consume */ } }).rejects.toThrow();
    const state = createChatAssembly("a");
    for await (const event of readChatEvents(bytes('data: {"type":"text-delta","id":"t","delta":"partial"}\n\n'))) applyChatEvent(state, event);
    expect(state.finished).toBe(false);
    expect(state.message.parts).toEqual([{ type: "text", text: "partial", state: "streaming" }]);
  });

  it("aborts an idle reader without leaking its lock", async () => {
    const controller = new AbortController();
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ cancel });
    const reading = (async () => { for await (const _event of readChatEvents(stream, controller.signal)) { /* consume */ } })();
    controller.abort();
    await reading;
    expect(cancel).toHaveBeenCalledOnce();
    expect(stream.locked).toBe(false);
  });
});

describe("project chat assembly", () => {
  it("keeps reasoning, parallel tool identities and multiple answer blocks in order", () => {
    const state = createChatAssembly("answer");
    const events: UIMessageChunk[] = [
      { type: "start-step" },
      { type: "reasoning-start", id: "r1" },
      { type: "reasoning-delta", id: "r1", delta: "Read memory" },
      { type: "reasoning-end", id: "r1" },
      { type: "tool-input-start", toolCallId: "one", toolName: "listFiles" },
      { type: "tool-input-start", toolCallId: "two", toolName: "readMemory" },
      { type: "tool-input-delta", toolCallId: "one", inputTextDelta: '{"path":' },
      { type: "tool-input-delta", toolCallId: "one", inputTextDelta: '"memory"}' },
      { type: "tool-input-available", toolCallId: "two", toolName: "readMemory", input: { name: "user" } },
      { type: "tool-output-available", toolCallId: "two", output: "known" },
      { type: "tool-output-available", toolCallId: "one", output: ["a.md"] },
      { type: "finish-step" },
      { type: "text-delta", id: "a1", delta: "First" },
      { type: "text-end", id: "a1" },
      { type: "text-start", id: "a2" },
      { type: "text-delta", id: "a2", delta: "Second" },
      { type: "finish" },
    ];
    events.forEach((event) => applyChatEvent(state, event));
    const rendered = buildStream(state.message.parts, false);
    expect(rendered.filter((item) => item.kind === "tool")).toEqual([
      expect.objectContaining({ toolCallId: "one", toolName: "listFiles", input: { path: "memory" }, output: ["a.md"], state: "output-available" }),
      expect.objectContaining({ toolCallId: "two", toolName: "readMemory", output: "known", state: "output-available" }),
    ]);
    expect(rendered[0]).toEqual({ kind: "reasoning", text: "Read memory" });
    expect(state.finished).toBe(true);
    expect(state.message.parts.filter((part) => part.type === "text").map((part) => part.text)).toEqual(["First", "Second"]);
  });

  it("updates data IDs, excludes transient receipts, and preserves published snapshots", () => {
    const state = createChatAssembly("a");
    applyChatEvent(state, { type: "data-phase", id: "phase", data: { running: true } });
    applyChatEvent(state, { type: "text-delta", id: "text", delta: "a" });
    const before = snapshotChatMessage(state);
    applyChatEvent(state, { type: "data-phase", id: "phase", data: { running: false } });
    applyChatEvent(state, { type: "data-persistence-handoff", transient: true, data: { summaryRunId: "s" } });
    applyChatEvent(state, { type: "text-delta", id: "text", delta: "b" });
    expect(state.message.parts).toHaveLength(2);
    expect(state.message.parts[0]).toMatchObject({ data: { running: false } });
    expect(before.parts[1]).toMatchObject({ text: "a" });
    expect(state.message.parts[1]).toMatchObject({ text: "ab" });
  });

  it("full replay rebuilds exactly one answer instead of appending partial text", () => {
    const partial = createChatAssembly("same-answer");
    applyChatEvent(partial, { type: "text-delta", id: "t", delta: "Hello" });
    const replay = createChatAssembly(partial.message.id);
    [{ type: "text-delta", id: "t", delta: "Hello" }, { type: "text-delta", id: "t", delta: " world" }, { type: "finish" }].forEach((chunk) => applyChatEvent(replay, chunk));
    expect(replay.message.id).toBe("same-answer");
    expect(replay.message.parts).toEqual([{ type: "text", text: "Hello world", state: "done" }]);
  });

  it("regeneration retains the original question identity and excludes its previous answer", () => {
    const messages: UIMessage[] = [
      { id: "q1", role: "user", parts: [{ type: "text", text: "question" }] },
      { id: "a1", role: "assistant", parts: [{ type: "text", text: "old answer" }] },
      { id: "q2", role: "user", parts: [{ type: "text", text: "next question" }] },
    ];
    expect(regenerationMessages(messages, "a1")).toEqual([messages[0]]);
    expect(regenerationMessages(messages, "a1")[0].id).toBe("q1");
    expect(() => regenerationMessages(messages, "missing")).toThrow("no longer available");
  });
});
