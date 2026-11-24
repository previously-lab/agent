import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UIMessage, UIMessageChunk } from "@/lib/chat/protocol";
import type { DialogueRunInput } from "@/lib/dialogue/transport";

const h = vi.hoisted(() => ({
  chunks: [] as UIMessageChunk[],
  closed: false,
  getRun: vi.fn(),
  getRow: vi.fn(),
}));

vi.mock("workflow", () => ({
  getWorkflowMetadata: () => ({ workflowRunId: "wrun_ACTOR" }),
  getWritable: () => ({
    getWriter: () => ({
      write: async (chunk: UIMessageChunk) => { h.chunks.push(chunk); },
      releaseLock: () => {},
    }),
    close: async () => { h.closed = true; },
  }),
}));
vi.mock("workflow/runtime", () => ({ getWorld: () => ({ runs: { get: h.getRow } }) }));
vi.mock("workflow/api", () => ({ start: vi.fn(), getRun: h.getRun }));

import { closeDialogueStreamStep, openDialogueStreamStep, publishDialogueResultStep, reconcileDialogueOffersStep } from "@/app/api/chat/dialogue-transport-steps";
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

const context: DialogueRunInput["context"] = { scopeKey: "scope", parentRunId: "thought", workId: "work",
      sourceInputId: "A", sourceTurnId: "A", priorContext: [], locale: "en",
      source: { inputId: "A", clientMessageId: "A", acceptedAt: "2026-11-01T00:00:00Z", text: "Q", userSeq: 1, eventSeq: 1 },
      record: { useGithub: false, useDemo: false, owner: "local", repo: "local", timezone: "UTC",
        slicing: { idleGapMinutes: 30, maxSliceMinutes: 60, maxTurnsPerSlice: 20 } } };

describe("native dialogue terminal stream protocol", () => {
  beforeEach(() => {
    h.chunks.length = 0;
    h.closed = false;
    h.getRow.mockReset().mockResolvedValue({ status: "running" });
  });

  it("attributes only native final laps to their Actor and the exact eventual publication", async () => {
    const final: DialogueRunInput = { context, offerId: "a", text: "done", stage: "final", publicSeq: 1,
      publicationId: "a+b", publicationInputIds: ["A", "B"], publicationSourceResults: ["a", "b"].map(resultId =>
        ({ resultId, productRevision: 1, claimIds: [] })), orchestration: { offers: [], works: [], publications: [] } };
    await openDialogueStreamStep(final);
    const committed = await publishDialogueResultStep({ input: final, text: "Answer", artifacts: [] });
    expect(committed?.utteranceId).not.toBe(final.offerId);
    expect(h.chunks[1]?.data).toMatchObject({ phase: "final_answer", actorRunId: "wrun_ACTOR", parentRunId: "thought",
      inputIds: ["A", "B"], offerId: "a", utteranceId: committed?.utteranceId });
    for (const input of [{ ...final, stage: "checkpoint" as const }, { ...final, orchestration: undefined }]) {
      await openDialogueStreamStep(input);
      expect(h.chunks.at(-1)?.data).not.toHaveProperty("phase");
    }
  });

  it("rechecks every contributing parent after wording and before writing a public chunk", async () => {
    const final: DialogueRunInput = { context, offerId: "a", stage: "final", text: "done", publicSeq: 1,
      publicationParentRunIds: ["thought", "thoughtB"] };
    h.getRow.mockImplementation(async id => id === "thoughtB"
      ? { status: "completed", attributes: { dialogueStopped: "1" } } : { status: "running" });
    await expect(publishDialogueResultStep({ input: final, text: "Merged answer", artifacts: [] })).resolves.toBeUndefined();
    expect(h.chunks).toEqual([]);
    h.getRow.mockRejectedValueOnce(new Error("status unavailable"));
    await expect(publishDialogueResultStep({ input: final, text: "Merged answer", artifacts: [] })).rejects.toThrow("status unavailable");
    expect(h.chunks).toEqual([]);
    await expect(publishDialogueResultStep({ input: { ...final, publicationParentRunIds: ["thought"] }, text: "A alone", artifacts: [] }))
      .resolves.toMatchObject({ blocks: [{ text: "A alone" }] });
  });

  it("withholds checkpoint publication and reconciliation until the newer final can be read", async () => {
    const checkpoint = { type: "work_checkpoint", updateId: "a", workId: "work", sourceInputId: "A", runId: "thought",
      acceptedAt: context.source.acceptedAt, text: "Partial" };
    const final = { ...checkpoint, type: "work_completed", updateId: "b", text: "Complete" };
    let entries = [checkpoint];
    h.getRun.mockReturnValue({ getReadable: () => Object.assign(new ReadableStream({ start(controller) {
      for (const entry of entries) controller.enqueue(entry);
      controller.close();
    } }), { getTailIndex: async () => 1 }) });
    const input: DialogueRunInput = { context, offerId: "a", publicSeq: 1, stage: "checkpoint", text: "Partial" };
    const publish = () => publishDialogueResultStep({ input, text: input.text, artifacts: [] });
    await expect(publish()).rejects.toThrow("before its observed tail");
    await expect(reconcileDialogueOffersStep("thought")).rejects.toThrow("before its observed tail");
    entries = [checkpoint, final];
    await expect(publish()).resolves.toBeUndefined();
    expect((await reconcileDialogueOffersStep("thought")).map(offer => offer.offerId)).toEqual(["a", "b"]);
    expect(h.chunks).toEqual([]);
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
