import { describe, expect, it, vi } from "vitest";
import { readDurableChat } from "@/lib/chat/client-transport";
import type { UIMessage, UIMessageChunk } from "@/lib/chat/protocol";
import type { ModelMessage } from "@/lib/deepseek/types";

const response = (...events: UIMessageChunk[]) => new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));

describe("durable chat transport", () => {
  it("reconnects to the same run after EOF without re-posting or doubling visible text", async () => {
    const requests = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => response(
      { type: "text-delta", id: "a", delta: "Hello" },
      { type: "text-delta", id: "a", delta: " world" },
      { type: "finish" },
    ));
    const snapshots: UIMessage[] = [];
    const answer = await readDurableChat({
      runId: "the-run", assistantId: "the-answer", signal: new AbortController().signal,
      response: response({ type: "text-delta", id: "a", delta: "Hello" }),
      fetch: requests, retryDelayMs: 0, onMessage: (message) => snapshots.push(message),
    });
    expect(requests).toHaveBeenCalledOnce();
    expect(requests.mock.calls[0][0]).toBe("/api/chat/the-run/stream?startIndex=0");
    expect(requests.mock.calls[0][1]?.method).toBeUndefined();
    expect(snapshots[0].parts[0]).toMatchObject({ text: "Hello" });
    expect(answer.parts).toEqual([{ type: "text", text: "Hello world", state: "done" }]);
    expect(answer.id).toBe("the-answer");
  });

  it("does not retry a vanished run or a terminal model error", async () => {
    for (const failed of [new Response("gone", { status: 404 }), response({ type: "error", errorText: "invalid credentials" })]) {
      const request = vi.fn();
      await expect(readDurableChat({ runId: "run", assistantId: "answer", signal: new AbortController().signal,
        response: failed, fetch: request, retryDelayMs: 0, onMessage: () => {} })).rejects.toThrow();
      expect(request).not.toHaveBeenCalled();
    }
  });

  it("retries transient HTTP failures within a finite budget", async () => {
    for (const status of [408, 429, 503]) {
      const request = vi.fn(async () => new Response("unavailable", { status }));
      await expect(readDurableChat({ runId: "run", assistantId: "a", signal: new AbortController().signal,
        fetch: request, retryDelayMs: 0, onMessage: () => {} })).rejects.toThrow(String(status));
      expect(request).toHaveBeenCalledTimes(4);
    }
  });

  it("retains exact native reasoning and tool argument strings through replay and saved UI JSON", async () => {
    const native: ModelMessage[] = [
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "call-1", toolName: "recall", input: { query: "朋友" } }], deepseek: { role: "assistant", content: null, reasoning_content: "Complete reasoning", tool_calls: [{ id: "call-1", type: "function", function: { name: "recall", arguments: '{ "query" : "朋友" }' } }] } },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "call-1", toolName: "recall", output: { type: "text", value: "memory receipt" } }] },
    ];
    const onData = vi.fn();
    const answer = await readDurableChat({ runId: "run", assistantId: "a", signal: new AbortController().signal,
      response: response({ type: "data-deepseek-step", data: { messages: native } }, { type: "data-persistence-handoff", transient: true, data: { summaryRunId: "summary" } }, { type: "finish" }),
      onData, onMessage: () => {} });
    const afterRefresh = JSON.parse(JSON.stringify(answer)) as UIMessage;
    expect(afterRefresh.parts).toEqual([{ type: "data-deepseek-step", data: { messages: native } }]);
    expect(onData).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(afterRefresh)).toContain('Complete reasoning');
  });

  it("an aborted reader never reconnects or publishes a completed answer", async () => {
    const controller = new AbortController();
    const cancel = vi.fn();
    const request = vi.fn();
    const publish = vi.fn();
    const reading = readDurableChat({ runId: "run", assistantId: "a", signal: controller.signal,
      response: new Response(new ReadableStream({ cancel })), fetch: request, onMessage: publish });
    controller.abort();
    await expect(reading).rejects.toMatchObject({ name: "AbortError" });
    expect(request).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
  });
});
