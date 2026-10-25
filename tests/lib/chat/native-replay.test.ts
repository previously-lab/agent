import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { messagesWithNativeReplay, readNativeReplay, rememberNativeReplay, restoreNativeReplay } from "@/lib/chat/native-replay";
import { mergeSavedTurns, recoveryMessages } from "@/lib/chat/reconnect";
import { acceptPersistenceRecovery } from "@/lib/chat/persistence";
import { parseSlice, serializeSlice } from "@/lib/episodic/manager";
import type { UIMessage } from "@/lib/chat/protocol";
import type { TimeSlice, Turn } from "@/lib/episodic/types";
import type { ModelMessage } from "@/lib/deepseek/types";

const native: ModelMessage[] = [{ role: "assistant", content: "answer", deepseek: { role: "assistant", content: "answer", reasoning_content: "private original reasoning" } }];
const replay = { type: "data-deepseek-step" as const, id: "native-1", data: { messages: native } };
const user = (id = "u1", content = "question"): UIMessage => ({ id, role: "user", parts: [{ type: "text", text: content }] });
const answer = (id = "a1", content = "answer", raw = true): UIMessage => ({ id, role: "assistant", parts: [{ type: "text", text: content }, ...(raw ? [replay] : [])] });
const saved: Turn[] = [
  { role: "user", content: "question", timestamp: "t1", turnId: "turn1", clientMessageId: "u1" },
  { role: "agent", content: "answer", timestamp: "t2", turnId: "turn1" },
];
beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) });
});
afterEach(() => vi.unstubAllGlobals());

describe("bounded native replay after refresh", () => {
  it("restores the exact raw messages only when stable identity and both visible texts match", () => {
    rememberNativeReplay([user(), answer()]);
    expect(restoreNativeReplay([user(), answer("from-server", "answer", false)])[1].parts).toContainEqual(replay);
    for (const candidate of [[user("different-id"), answer("a", "answer", false)], [user("u1", "edited question"), answer("a", "answer", false)], [user(), answer("a", "edited answer", false)]]) {
      expect(restoreNativeReplay(candidate)[1].parts).toHaveLength(1);
    }
  });

  it("never invents a saved turn, and prefixes only the authoritative current slice before the new question", () => {
    rememberNativeReplay([user(), answer()]);
    expect(messagesWithNativeReplay([user("new", "next")], [])).toEqual([user("new", "next")]);
    const messages = messagesWithNativeReplay([user("new", "next")], saved);
    expect(messages.map((message) => message.id)).toEqual(["u1", "saved-agent-turn1", "new"]);
    expect(messages[1].parts).toContainEqual(replay);
  });

  it("does not duplicate an authoritative pair already present in live or recovered messages", () => {
    rememberNativeReplay([user(), answer()]);
    const working = [user(), answer("pending", "answer", false), user("next")];
    const result = messagesWithNativeReplay(working, saved);
    expect(result.map((message) => message.id)).toEqual(["u1", "pending", "next"]);
    expect(result[1].parts).toContainEqual(replay);
    expect(messagesWithNativeReplay([user(), answer(), user("next")], saved)[1].parts).toHaveLength(2);
  });

  it("matches exact text within steps and blank lines between assistant steps", () => {
    const streamed: UIMessage = { id: "multi", role: "assistant", parts: [{ type: "text", text: " Checking… " }, replay, { type: "text", text: "Final answer\n" }, { ...replay, id: "native-2" }] };
    rememberNativeReplay([user(), streamed]);
    const restored = restoreNativeReplay([user(), answer("saved", " Checking… \n\nFinal answer\n", false)]);
    expect(restored[1].parts).toHaveLength(3);
    expect(restored[1].parts.slice(1)).toEqual([replay, { ...replay, id: "native-2" }]);
  });

  it("keeps distinct regenerated answers attached to the original question", () => {
    rememberNativeReplay([user(), answer(), answer("regenerated", "new answer")]);
    expect(readNativeReplay()).toHaveLength(2);
    expect(restoreNativeReplay([user(), answer("old", "answer", false), answer("new", "new answer", false)]).slice(1).every((message) => message.parts.length === 2)).toBe(true);
  });

  it("retains at most 24 turns and silently ignores oversized raw transcripts", () => {
    for (let index = 0; index < 30; index++) rememberNativeReplay([user(`u${index}`), answer()]);
    expect(readNativeReplay()).toHaveLength(24);
    expect(readNativeReplay()[0].userId).toBe("u6");
    const huge = { ...replay, data: { messages: [{ role: "assistant", content: "x".repeat(600_000) }] } };
    rememberNativeReplay([user("too-big"), { ...answer(), parts: [{ type: "text", text: "answer" }, huge] }]);
    expect(readNativeReplay()).toHaveLength(24);
    expect(readNativeReplay().some((entry) => entry.userId === "too-big")).toBe(false);
  });

  it("falls back to visible text with corrupt, oversized or unavailable local storage", () => {
    for (const raw of ["not json", '{"parts":[]}', "[]".repeat(600_000)]) {
      vi.stubGlobal("localStorage", { getItem: () => raw, setItem: vi.fn() });
      expect(readNativeReplay()).toEqual([]);
    }
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("private"); }, setItem: () => { throw new Error("quota"); } });
    expect(() => rememberNativeReplay([user(), answer()])).not.toThrow();
    expect(restoreNativeReplay([user(), answer("plain", "answer", false)])[1].parts).toHaveLength(1);
  });

  it("carries completed Workflow nativeMessages through pending recovery into the archive", () => {
    const record = { turnId: "turn1", clientMessageId: "u1", sliceId: "slice", at: "t1", userText: "question", replyText: "answer", cognition: "", nativeMessages: native };
    const recovered = recoveryMessages([record]);
    expect(recovered[1].parts[1]).toEqual({ type: "data-deepseek-step", id: "recovery-native-turn1", data: { messages: native } });
    acceptPersistenceRecovery({ records: [{ runId: "run1", record }], activeRunIds: [], savedRunIds: [], unavailableRunIds: [], receipts: [], failures: [] });
    expect(readNativeReplay()[0].parts).toEqual([recovered[1].parts[1]]);
    expect(messagesWithNativeReplay([user("next")], saved)[1].parts[1]).toEqual(recovered[1].parts[1]);
  });

  it("attaches native parts to a rebuilt fence answer across disk-style outer trimming", () => {
    const fence = "```html live\r\n  <div class=\"room\">\r\n    <b>你好</b>\r\n  </div>\r\n```";
    rememberNativeReplay([user(), answer("live", fence)]);
    const rebuilt: UIMessage = { id: "saved-agent-turn1", role: "assistant", metadata: { recoveryTurnId: "turn1" }, parts: [{ type: "text", text: fence }] };
    const restored = restoreNativeReplay([user(), rebuilt]);
    expect(restored[1].parts).toEqual([{ type: "text", text: fence }, replay]);
    const diskNormalized: UIMessage = { ...rebuilt, id: "disk-normalized", parts: [{ type: "text", text: ` ${fence} ` }] };
    expect(restoreNativeReplay([user(), diskNormalized])[1].parts).toEqual([{ type: "text", text: ` ${fence} ` }, replay]);
  });

  it("passes fenced replyText through recovery with nativeMessages checkpoint identity intact", () => {
    const fence = "```html live\r\n  <div class=\"room\">\r\n  </div>\r\n```";
    const nativeFence: ModelMessage[] = [{ role: "assistant", content: fence, deepseek: { role: "assistant", content: fence, reasoning_content: "private reasoning" } }];
    const record = { turnId: "turn1", clientMessageId: "u1", sliceId: "slice", at: "t1", userText: "question", replyText: fence, cognition: "", nativeMessages: nativeFence };
    const recovered = recoveryMessages([record]);
    expect(recovered[1].parts[0]).toEqual({ type: "text", text: fence });
    expect(recovered[1].parts[1]).toEqual({ type: "data-deepseek-step", id: "recovery-native-turn1", data: { messages: nativeFence } });
    acceptPersistenceRecovery({ records: [{ runId: "run1", record }], activeRunIds: [], savedRunIds: [], unavailableRunIds: [], receipts: [], failures: [] });
    expect(readNativeReplay()[0].parts).toEqual([recovered[1].parts[1]]);
  });

  it("restores original checkpoints after a real disk trim without accepting internal or user edits", () => {
    const original = " \n```html live\r\n  <div class=\"room\">\r\n    <b>fictional</b>\r\n  </div>\r\n```\n";
    const checkpoint: ModelMessage[] = [{ role: "assistant", content: original, deepseek: { role: "assistant", content: original, reasoning_content: "private original reasoning" } }];
    const checkpointPart = { type: "data-deepseek-step" as const, id: "disk-native", data: { messages: checkpoint } };
    const live: UIMessage = { id: "live", role: "assistant", parts: [{ type: "text", text: original }, checkpointPart] };
    rememberNativeReplay([user(), live]);
    const cached = readNativeReplay();
    const rawCache = localStorage.getItem("previously:deepseek-replay:v1");
    expect(cached[0].assistantText).toBe(original);
    expect(cached[0].parts).toEqual([checkpointPart]);

    const slice: TimeSlice = {
      slice_id: "2026-01-01-0000",
      focus: "fictional replay",
      status: "closed",
      start: "2026-01-01T00:00:00.000Z",
      end: "2026-01-01T00:01:00.000Z",
      timezone: "UTC",
      summary: "",
      open_loops: [],
      decisions: [],
      tags: [],
      related_slices: [],
      loops: [],
      turns: [
        { role: "user", content: "question", timestamp: "2026-01-01T00:00:00.000Z", turnId: "turn1", clientMessageId: "u1" },
        { role: "agent", content: original, timestamp: "2026-01-01T00:01:00.000Z", turnId: "turn1" },
      ],
      estimatedTokens: 0,
    };
    const roundTripped = parseSlice(serializeSlice(slice));
    expect(roundTripped.turns[1].content).toBe(original.trim());
    expect(slice.turns[1].content).toBe(original);
    const merged = mergeSavedTurns([], roundTripped.turns);
    const replayed = messagesWithNativeReplay([], roundTripped.turns);

    expect(replayed[1].parts).toEqual([{ type: "text", text: roundTripped.turns[1].content }, checkpointPart]);
    expect(readNativeReplay()).toEqual(cached);
    expect(localStorage.getItem("previously:deepseek-replay:v1")).toBe(rawCache);

    for (const mismatch of [
      { ...cached[0], userId: "different-user" },
      { ...cached[0], userText: "edited question" },
    ]) {
      expect(restoreNativeReplay(merged, [mismatch])[1].parts).toHaveLength(1);
    }
    const internalText = roundTripped.turns[1].content.replace("fictional", "changed");
    const internalEdit: UIMessage = { ...merged[1], parts: [{ type: "text", text: internalText }] };
    expect(restoreNativeReplay([merged[0], internalEdit], cached)[1].parts).toHaveLength(1);
  });
});
