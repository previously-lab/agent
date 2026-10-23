import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { messagesWithNativeReplay, readNativeReplay, rememberNativeReplay, restoreNativeReplay } from "@/lib/chat/native-replay";
import { recoveryMessages } from "@/lib/chat/reconnect";
import { acceptPersistenceRecovery } from "@/lib/chat/persistence";
import type { UIMessage } from "@/lib/chat/protocol";
import type { Turn } from "@/lib/episodic/types";
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

  it("matches persisted paragraph boundaries across multiple assistant steps", () => {
    const streamed: UIMessage = { id: "multi", role: "assistant", parts: [{ type: "text", text: " Checking… " }, replay, { type: "text", text: "Final answer\n" }, { ...replay, id: "native-2" }] };
    rememberNativeReplay([user(), streamed]);
    const restored = restoreNativeReplay([user(), answer("saved", "Checking…\n\nFinal answer", false)]);
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
});
