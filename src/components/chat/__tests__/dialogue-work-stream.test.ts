import { describe, expect, it, vi } from "vitest";
import {
  applyDialogueWorkStreamEvent,
  emptyDialogueWorkStream,
  parseDialogueWorkStreamEvent,
  readDialogueWorkStream,
  streamDialogueWork,
  type DialogueWorkStreamEvent,
} from "../dialogue-work-stream";

const event = (value: Record<string, unknown>) => ({ workId: "work-1", runId: "run-1", ...value });
const response = (events: Record<string, unknown>[]) => {
  const bytes = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const value of events) {
        const text = JSON.stringify(value);
        // Split inside JSON to exercise UTF-8/network-boundary independence.
        controller.enqueue(bytes.encode(`id: ${value.cursor}\ndata: ${text.slice(0, 12)}`));
        controller.enqueue(bytes.encode(`${text.slice(12)}\n\n`));
      }
      controller.enqueue(bytes.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
};

describe("dialogue work stream's safe projection", () => {
  it("assembles deltas and keyed tool states without retaining credentials or arguments", () => {
    const parsed = parseDialogueWorkStreamEvent(event({
      type: "tool", cursor: 1, toolCallId: "call-1", toolName: "readDoc", state: "running",
      input: { token: "must-not-enter-the-view" }, reasoning_content: "private",
    }));
    expect(parsed).toEqual({ type: "tool", cursor: 1, toolCallId: "call-1", toolName: "readDoc", state: "running" });
    expect(JSON.stringify(parsed)).not.toContain("must-not-enter-the-view");
    expect(() => parseDialogueWorkStreamEvent(event({ type: "reasoning", cursor: 2, reasoning_content: "private" }))).toThrow("Invalid");

    let state = applyDialogueWorkStreamEvent(emptyDialogueWorkStream, { type: "text", cursor: 2, delta: "Safe <b>text</b>" });
    state = applyDialogueWorkStreamEvent(state, parsed);
    state = applyDialogueWorkStreamEvent(state, { type: "tool", cursor: 3, toolCallId: "call-1", toolName: "readDoc", state: "completed" });
    state = applyDialogueWorkStreamEvent(state, { type: "status", cursor: 3, status: "live", retryAfterMs: 10 });
    expect(state).toMatchObject({ cursor: 3, text: "Safe <b>text</b>", status: "live", tools: [{ id: "call-1", name: "readDoc", status: "completed" }] });
    expect(applyDialogueWorkStreamEvent(state, { type: "text", cursor: 3, delta: "duplicate" })).toBe(state);
    expect(applyDialogueWorkStreamEvent(state, { type: "status", cursor: 2, status: "waiting" })).toBe(state);
  });

  it("keeps safe detail through start, completion and replay on the same tool ID", () => {
    const start = parseDialogueWorkStreamEvent(event({
      type: "tool", cursor: 1, toolCallId: "search-1", toolName: "webSearch", state: "running",
    }));
    const detail = parseDialogueWorkStreamEvent(event({
      type: "tool", cursor: 2, toolCallId: "search-1", toolName: "webSearch", state: "running",
      subject: "故宫开放时间", input: { query: "故宫开放时间", extra: "do not forward" },
    }));
    const complete = parseDialogueWorkStreamEvent(event({
      type: "tool", cursor: 3, toolCallId: "search-1", toolName: "webSearch", state: "completed",
      subject: "故宫开放时间", outcome: "found", resultCount: 2,
      output: { answer: "do not forward", sources: [] },
    }));
    const state = [start, detail, complete].reduce(applyDialogueWorkStreamEvent, emptyDialogueWorkStream);
    expect(state.tools).toEqual([{
      id: "search-1", name: "webSearch", status: "completed", subject: "故宫开放时间", outcome: "found", resultCount: 2,
    }]);
    expect(applyDialogueWorkStreamEvent(state, complete)).toBe(state);
    expect(JSON.stringify(state)).not.toContain("do not forward");
  });

  it("keeps the remaining parallel call in the activity caption when another finishes", () => {
    const events: DialogueWorkStreamEvent[] = [
      { type: "tool", cursor: 1, toolCallId: "recall", toolName: "recallSearch", state: "running", subject: "上次参观" },
      { type: "tool", cursor: 2, toolCallId: "search", toolName: "webSearch", state: "running", subject: "故宫开放时间" },
      { type: "tool", cursor: 3, toolCallId: "search", toolName: "webSearch", state: "completed", outcome: "found", resultCount: 2 },
    ];
    const state = events.reduce(applyDialogueWorkStreamEvent, emptyDialogueWorkStream);
    expect(state.activity).toEqual({ type: "tool", toolCallId: "recall" });
    expect(state.tools[1]).toMatchObject({ status: "completed", resultCount: 2 });
  });

  it("reads split SSE frames from the authorized replay endpoint without a cancel request", async () => {
    const request = vi.fn(async () => response([
      event({ type: "status", cursor: 0, status: "live", retryAfterMs: 25 }),
      event({ type: "text", cursor: 2, delta: "first second" }),
      event({ type: "tool", cursor: 3, toolCallId: "call-1", toolName: "readDoc", state: "running" }),
    ]));
    const events: DialogueWorkStreamEvent[] = [];
    const controller = new AbortController();
    const latest = await readDialogueWorkStream({ workId: "work-1", runId: "run-1", persona: "user", signal: controller.signal,
      onEvent: event => events.push(event), request });
    expect(events).toEqual([
      { type: "status", cursor: 0, status: "live", retryAfterMs: 25 },
      { type: "text", cursor: 2, delta: "first second" },
      { type: "tool", cursor: 3, toolCallId: "call-1", toolName: "readDoc", state: "running" },
    ]);
    expect(latest).toEqual({ type: "status", cursor: 0, status: "live", retryAfterMs: 25 });
    expect(request).toHaveBeenCalledWith("/api/chat/dialogue/work/work-1/stream?workId=work-1&persona=user&startIndex=0&runId=run-1",
      expect.objectContaining({ credentials: "same-origin", redirect: "error", signal: controller.signal }));
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("uses the accepted thoughts URL without changing the safe event schema", async () => {
    const request = vi.fn(async () => response([event({ type: "status", cursor: 0, status: "completed" })]));
    const controller = new AbortController();
    await readDialogueWorkStream({ workId: "work-1", runId: "parent-1", thoughtsUrl: "/api/chat/parent-1/thoughts?lease=ok",
      persona: "user", signal: controller.signal, onEvent: () => {}, request });
    expect(request).toHaveBeenCalledWith("/api/chat/parent-1/thoughts?lease=ok&workId=work-1&persona=user&startIndex=0&runId=parent-1",
      expect.objectContaining({ credentials: "same-origin", redirect: "error" }));
  });

  it("reconnects a bounded live attachment at the raw cursor and stops on terminal status", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(response([
        event({ type: "text", cursor: 1, delta: "kept" }),
        event({ type: "status", cursor: 1, status: "live", retryAfterMs: 25 }),
      ]))
      .mockResolvedValueOnce(response([
        event({ type: "text", cursor: 2, delta: " once" }),
        event({ type: "status", cursor: 2, status: "completed" }),
      ]));
    const events: DialogueWorkStreamEvent[] = [];
    const wait = vi.fn(async () => {});
    const controller = new AbortController();
    await streamDialogueWork({ workId: "work-1", runId: "run-1", persona: "user", signal: controller.signal,
      onEvent: event => events.push(event), request, wait });
    expect(wait).toHaveBeenCalledWith(25, controller.signal);
    expect(request.mock.calls[1]?.[0]).toBe("/api/chat/dialogue/work/work-1/stream?workId=work-1&persona=user&startIndex=1&runId=run-1");
    expect(events.filter(event => event.type === "text").map(event => event.delta)).toEqual(["kept", " once"]);
    expect(request).toHaveBeenCalledTimes(2);
  });
});
