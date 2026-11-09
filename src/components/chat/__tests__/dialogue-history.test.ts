import { describe, expect, it } from "vitest";
import type { HistoryStreamItem, HistoryTurnItem } from "@/lib/chat/stream-items";
import type { Turn } from "@/lib/episodic/types";
import type { ManuscriptEntry } from "../dialogue-projection";
import { orderDialogueItems, unrepresentedHistory } from "../dialogue-history";
import { mergeDialogueHistory } from "../dialogue-stream-rows";

const timestamp = "2026-11-07T01:00:00.000Z";
const input = { inputId: "input-1", clientMessageId: "client-1", userSeq: 1, eventSeq: 1, text: "你好", acceptedAt: timestamp };
const utterance = { utteranceId: "input-1:fallback", publicSeq: 1, committedAt: timestamp,
  inputIds: [input.inputId], sourceResults: [], blocks: [{ kind: "markdown" as const, blockId: "reply", text: "你好。" }] };
function row(turn: Turn): HistoryTurnItem {
  return { kind: "history-turn", key: turn.turnId!, sliceId: "2026-11-07-0100", strands: [], timeIso: timestamp, turn };
}
const saved = [
  row({ role: "user", content: input.text, timestamp, turnId: "input-1", clientMessageId: "client-1",
    dialogue: { kind: "user_input", inputId: "input-1", userSeq: 1 } }),
  row({ role: "agent", content: "你好。", timestamp, turnId: "p-hashed-storage-id",
    dialogue: { kind: "public_utterance", publicationId: utterance.utteranceId, publicSeq: 1,
      inputIds: [input.inputId], sourceResults: [], blocks: utterance.blocks } }),
];
const live: ManuscriptEntry[] = [{ kind: "input", id: input.inputId, input },
  { kind: "utterance", id: utterance.utteranceId, utterance }];

describe("saved native dialogue recovery", () => {
  it("restores both voices in a fresh browser without a local parent cache or legacy events", () => {
    expect(unrepresentedHistory(saved, [], [])).toEqual(saved);
  });
  it("deduplicates durable publications by their public identity, not the storage turn hash", () => {
    expect(unrepresentedHistory(saved, [], live)).toEqual([]);
    expect(unrepresentedHistory(saved, [], live.slice(0, 1))).toEqual(saved.slice(1));
  });
  it("keeps a different reply with identical prose while a streaming reply recovers", () => {
    const replay: ManuscriptEntry = { kind: "message", id: "child", timeIso: timestamp, isStreaming: true,
      message: { id: "child", role: "assistant", parts: [{ type: "text", text: "你好。" }],
        metadata: { publicationId: utterance.utteranceId } } };
    const other = row({ role: "agent", timestamp, turnId: "another-turn", content: "你好。" });
    expect(unrepresentedHistory([...saved, other], [], [live[0], replay])).toEqual([other]);
  });
  it("retains legacy recovery deduplication and structural seams", () => {
    const seam: HistoryStreamItem = { kind: "briefing", key: "briefing", timeIso: timestamp };
    const old = row({ role: "agent", timestamp, turnId: "legacy-turn", content: "Earlier reply" });
    expect(unrepresentedHistory([old, seam], [{ id: "restored", role: "assistant", parts: [],
      metadata: { recoveryTurnId: "legacy-turn" } }], [])).toEqual([seam]);
  });
  it("groups adjacent saved publications for one input, but never across a user message", () => {
    const continuation = row({ role: "agent", content: "Continue.", timestamp, turnId: "continuation",
      dialogue: { kind: "public_utterance", publicationId: "continuation", publicSeq: 2,
        inputIds: [input.inputId], sourceResults: [], blocks: [{ kind: "markdown", blockId: "next", text: "Continue." }] } });
    const grouped = orderDialogueItems([...saved, continuation]);
    expect(grouped).toHaveLength(2);
    expect(grouped[1]).toMatchObject({ kind: "history-turn", continuations: [continuation.turn] });

    const nextUser = row({ role: "user", content: "Next", timestamp, turnId: "next-user" });
    expect(orderDialogueItems([...saved, nextUser, continuation])).toHaveLength(4);
  });

  it("keeps newer v2 records at the live edge when the legacy projection arrives last", () => {
    const old = { ...row({ role: "agent", timestamp, turnId: "old", content: "Yesterday" }),
      timeIso: "2026-11-06T15:58:00.000Z" };
    const boundary: HistoryStreamItem = { kind: "resume-banner", key: "boundary", startIso: timestamp, timeIso: timestamp };
    expect(orderDialogueItems([boundary, ...saved, old]).map(item => item.key))
      .toEqual(["old", "boundary", "input-1", "p-hashed-storage-id"]);
  });

  it("projects the current record into UIMessages and dedupes late history by publicationId", () => {
    const turns = saved.map(item => item.turn);
    const restored = mergeDialogueHistory([], turns);
    expect(restored.map(message => [message.id, message.role])).toEqual([
      ["client-1", "user"], ["p-hashed-storage-id", "assistant"],
    ]);
    expect(mergeDialogueHistory(restored, turns)).toEqual(restored);

    const liveMessages = [
      { id: "client-1", role: "user" as const, parts: [], metadata: { sourceInputId: "input-1" } },
      { id: "fixed-assistant", role: "assistant" as const, parts: [{ type: "text" as const, text: "你好。" }],
        metadata: { sourceInputId: "input-1", publicationId: utterance.utteranceId } },
    ];
    const merged = mergeDialogueHistory(liveMessages, turns);
    expect(merged).toEqual(liveMessages);
    expect(unrepresentedHistory(saved, liveMessages, [])).toEqual([]);
  });
});
