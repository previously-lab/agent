import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acceptPersistenceRecovery, readPendingPersistence, rememberTurnRun, rememberSummaryRun, subscribePersistenceCommits } from "@/lib/chat/persistence";
import { recoveredTurnIds, recoveryMessages, mergeRecoveredMessages, mergeSavedTurns } from "@/lib/chat/reconnect";
import { Chat } from "@ai-sdk/react";
import type { UIMessage, UIMessageChunk } from "ai";
const record = { turnId: "u1", sliceId: "s", at: "2026-10-22T00:00:00Z", userText: "question", replyText: "answer", cognition: "" };
beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) });
});
afterEach(() => vi.unstubAllGlobals());

describe("pending persistence acknowledgement", () => {
  it("keeps pending run identifiers until the server confirms coverage, publishing each commit once", () => {
    rememberTurnRun("run");
    const callback = vi.fn();
    const unsubscribe = subscribePersistenceCommits(callback);
    const base = { activeRunIds: [], unavailableRunIds: [], failures: [] };
    acceptPersistenceRecovery({ ...base, records: [{ runId: "run", record }], receipts: [], savedRunIds: [] });
    expect(readPendingPersistence().runIds).toEqual(["run"]);
    expect(callback).not.toHaveBeenCalled();
    const result = { ...base, records: [], savedRunIds: ["run"], receipts: [{ version: 1 as const, commitSha: "one-real-commit", records: [{ sliceId: "s", turnIds: ["u1"] }] }] };
    acceptPersistenceRecovery(result);
    acceptPersistenceRecovery(result);
    expect(readPendingPersistence().runIds).toEqual([]);
    expect(callback).toHaveBeenCalledOnce();
    unsubscribe();
  });

  it("restores pending answers once and omits records already in the arrival slice", () => {
    expect(recoveryMessages([record, record]).map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(recoveryMessages([record], new Set(["u1"]))).toEqual([]);
    expect(recoveryMessages([record])[1].parts).toEqual([{ type: "text", text: "answer" }]);
    expect([...recoveredTurnIds(recoveryMessages([record]))]).toEqual(["u1"]);
  });

  it("retains every unacknowledged dependency beyond one query batch", () => {
    for (let index = 0; index < 40; index++) { rememberTurnRun(`run-${index}`); rememberSummaryRun(`summary-${index}`); }
    expect(readPendingPersistence().runIds).toHaveLength(40);
    expect(readPendingPersistence().summaryRunIds).toHaveLength(40);
  });

  it("publishes different coverage at the same Git HEAD, while deduping reordered coverage", () => {
    const callback = vi.fn();
    const unsubscribe = subscribePersistenceCommits(callback);
    const base = { records: [], activeRunIds: [], savedRunIds: [], unavailableRunIds: [], failures: [] };
    const first = { version: 1 as const, commitSha: "same-head", records: [{ sliceId: "s", turnIds: ["a"] }] };
    const second = { ...first, records: [{ sliceId: "s", turnIds: ["b", "a"] }] };
    acceptPersistenceRecovery({ ...base, receipts: [first, second] });
    acceptPersistenceRecovery({ ...base, receipts: [{ ...second, records: [{ sliceId: "s", turnIds: ["a", "b"] }] }] });
    expect(callback).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it("seats one original question and both regenerated answers", () => {
    const original = { ...record, clientMessageId: "question-id" };
    const regenerated = { ...original, turnId: "regen", regenerate: true, at: "2026-10-22T00:01:00Z", replyText: "new answer" };
    expect(recoveryMessages([original, regenerated]).map((message) => message.role)).toEqual(["user", "assistant", "assistant"]);
    expect(recoveryMessages([regenerated], new Set(), new Set(["question-id"])).map((message) => message.role)).toEqual(["assistant"]);
  });

  it("keeps a completed bypass answer when the real chat SDK resumes the main run", async () => {
    const stored: UIMessage[] = [{ id: "main-question", role: "user", parts: [{ type: "text", text: "main question" }] }];
    const bypass = { ...record, clientMessageId: "bypass-question" };
    const messages = mergeRecoveredMessages(stored, [bypass]);
    const chat = new Chat<UIMessage>({ messages, transport: {
      sendMessages: async () => { throw new Error("must not rerun the model"); },
      reconnectToStream: async () => new ReadableStream<UIMessageChunk>({ start(controller) {
        for (const chunk of [
          { type: "start", messageId: "main-answer" }, { type: "text-start", id: "text" },
          { type: "text-delta", id: "text", delta: "resumed answer" }, { type: "text-end", id: "text" }, { type: "finish" },
        ] as UIMessageChunk[]) controller.enqueue(chunk);
        controller.close();
      } }),
    } });
    await chat.resumeStream();
    expect(chat.error).toBeUndefined();
    expect(chat.messages.map((message) => message.id)).toEqual(["main-question", "bypass-question", "recovery-agent-u1", "main-answer"]);
    expect(chat.messages.flatMap((message) => message.parts).filter((part) => part.type === "text").map((part) => part.text)).toEqual(["main question", "question", "answer", "resumed answer"]);
  });

  it("restores an already acknowledged bypass from the slice while the main run reconnects", () => {
    const stored: UIMessage[] = [
      { id: "old-question", role: "user", parts: [{ type: "text", text: "old question" }] },
      { id: "old-answer", role: "assistant", parts: [{ type: "text", text: "old answer" }] },
      { id: "main-question", role: "user", parts: [{ type: "text", text: "main question" }] },
    ];
    const turns = [
      { role: "user" as const, turnId: "old", clientMessageId: "old-question", content: "old question", timestamp: "2026-10-22T00:00:00Z" },
      { role: "agent" as const, turnId: "old", content: "old answer", timestamp: "2026-10-22T00:00:00Z" },
      { role: "user" as const, turnId: "bypass", clientMessageId: "bypass-question", content: "bypass question", timestamp: "2026-10-22T00:01:00Z" },
      { role: "agent" as const, turnId: "bypass", content: "saved bypass answer", timestamp: "2026-10-22T00:01:00Z" },
    ];
    const recovered = mergeSavedTurns(stored, turns);
    expect(recovered.map((message) => message.id)).toEqual(["old-question", "old-answer", "main-question", "bypass-question", "saved-agent-bypass"]);
    expect(mergeSavedTurns(recovered, turns)).toEqual(recovered);
    expect(recovered.flatMap((message) => message.parts).filter((part) => part.type === "text").map((part) => part.text)).toEqual(["old question", "old answer", "main question", "bypass question", "saved bypass answer"]);
  });
});
