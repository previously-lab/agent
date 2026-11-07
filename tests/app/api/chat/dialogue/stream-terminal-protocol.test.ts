import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UIMessage, UIMessageChunk } from "@/lib/chat/protocol";

const h = vi.hoisted(() => ({
  chunks: [] as UIMessageChunk[],
  closed: false,
}));

vi.mock("workflow", () => ({
  getWorkflowMetadata: vi.fn(),
  getWritable: () => ({
    getWriter: () => ({
      write: async (chunk: UIMessageChunk) => { h.chunks.push(chunk); },
      releaseLock: () => {},
    }),
    close: async () => { h.closed = true; },
  }),
}));
vi.mock("workflow/api", () => ({ start: vi.fn() }));

import { closeDialogueStreamStep } from "@/app/api/chat/dialogue-transport-steps";
import { createMixedStreamTransform } from "@/app/api/chat/mixed-stream-transform";
import { createUIMessageStreamResponse } from "@/lib/chat/server-stream";
import { readDurableChat } from "@/lib/chat/client-transport";

function response(chunks: readonly unknown[] = h.chunks): Response {
  const stream = new ReadableStream<unknown>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  return createUIMessageStreamResponse({ stream: stream.pipeThrough(createMixedStreamTransform()) });
}

describe("native dialogue terminal stream protocol", () => {
  beforeEach(() => {
    h.chunks.length = 0;
    h.closed = false;
  });

  it.each([
    { error: undefined, reason: "stop", status: "done" },
    { error: "model failed", reason: "error", status: "error" },
  ])("delivers the $status terminal through mixed-stream replay", async ({ error, reason, status }) => {
    await closeDialogueStreamStep({ offerId: "work:reply", text: "answer", ...(error ? { error } : {}) });
    expect(h.closed).toBe(true);
    expect(h.chunks.at(-1)).toMatchObject({ type: "finish", protocol: "deepseek-v1", finishReason: reason });

    const request = vi.fn(async () => response());
    const onData = vi.fn();
    let published: UIMessage | undefined;
    const answer = await readDurableChat({
      runId: "child", assistantId: "answer", signal: new AbortController().signal,
      response: response(), fetch: request, retryDelayMs: 0, onData,
      onMessage: (message) => { published = message; },
    });

    expect(request).not.toHaveBeenCalled();
    expect(published).toEqual(answer);
    const terminal = answer.parts.find((part) => part.type === "data-turn-status");
    expect(terminal).toMatchObject({
      type: "data-turn-status",
      data: { status, turnId: "work:reply", offerId: "work:reply", ...(error ? { error } : {}) },
    });
    expect(onData).toHaveBeenCalledWith(expect.objectContaining({ type: "data-turn-status" }));
  });

  it.each([
    { status: "done", reason: "stop" },
    { status: "error", reason: "error" },
    { status: "interrupted", reason: "stop" },
  ])("settles an existing $status legacy stream without a new POST", async ({ status, reason }) => {
    const legacyChunks = [
      // A model attempt can finish before the native dialogue terminal. It
      // must not become the conversation finish during durable replay.
      { type: "finish", finishReason: "tool-calls", usage: { totalTokens: 3 } },
      { type: "text-delta", id: "reply", delta: "persisted answer" },
      {
        type: "data-turn-status",
        id: "turn-status-terminal",
        data: {
          status,
          turnId: "work:reply",
          offerId: "work:reply",
          updatedAt: "2026-11-07T00:00:00.000Z",
          ...(status === "error" ? { error: "model failed" } : {}),
        },
      },
      { type: "finish-step" },
      { type: "finish", finishReason: reason },
    ];
    const request = vi.fn(async () => response(legacyChunks));

    const answer = await readDurableChat({
      runId: "existing-child", assistantId: "answer", signal: new AbortController().signal,
      response: response(legacyChunks), fetch: request, retryDelayMs: 0, onMessage: () => {},
    });

    expect(request).not.toHaveBeenCalled();
    expect(answer.parts).toContainEqual({ type: "text", text: "persisted answer", state: "done" });
    expect(answer.parts).toContainEqual(expect.objectContaining({
      type: "data-turn-status",
      data: expect.objectContaining({ status, offerId: "work:reply" }),
    }));
  });
});
