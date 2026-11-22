import { describe, expect, it } from "vitest";
import type { HistoryStreamItem, HistoryTurnItem } from "@/lib/chat/stream-items";
import type { Turn } from "@/lib/episodic/types";
import type { UIMessage } from "@/lib/chat/protocol";
import { encodeDialogueRecordTurn } from "@/lib/episodic/dialogue-record";
import { parseSlice } from "@/lib/episodic/manager";
import type { ManuscriptEntry } from "../dialogue-projection";
import { orderDialogueItems, unrepresentedHistory } from "../dialogue-history";
import { dialogueStreamRows, mergeDialogueHistory } from "../dialogue-stream-rows";

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
  it("deduplicates a legacy recovery only after its public answer arrives", () => {
    const seam: HistoryStreamItem = { kind: "briefing", key: "briefing", timeIso: timestamp };
    const old = row({ role: "agent", timestamp, turnId: "legacy-turn", content: "Earlier reply" });
    expect(unrepresentedHistory([old, seam], [{ id: "restored", role: "assistant", parts: [],
      metadata: { recoveryTurnId: "legacy-turn" } }], [])).toEqual([old, seam]);
    expect(unrepresentedHistory([old, seam], [{ id: "restored", role: "assistant", parts: [{ type: "text", text: "Earlier reply" }],
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

  it("restores native v1 publications from core.md with or without a matching empty local seat", () => {
    const id = "synthetic-input";
    const first = "The ferry leaves at nine.", second = "The landing is North Pier.";
    const encode = (index: number, text: string) => encodeDialogueRecordTurn({ kind: "public_utterance",
      publicationId: id + ":call-" + index, publicSeq: index, inputIds: [id], sourceResults: [],
      blocks: [{ kind: "markdown", blockId: "text-" + index, text }] });
    const header = (index: number, text: string) => "## Turn psha-" + index + " — " + timestamp +
      " (agent) [reply-to " + id + "] [dialogue " + encode(index, text) + "] [body-escaped v1]\n\n" + text;
    const turns = parseSlice(["---", "slice_id: 2026-11-07-0100", "---",
      "## Turn " + id + " — " + timestamp + " (user) [body-escaped v1]\n\nWhere and when?",
      header(1, first), header(2, second)].join("\n\n")).turns;
    expect(turns.map(turn => turn.content)).toEqual(["Where and when?", first, second]);
    const empty = { id: "local-seat", role: "assistant", parts: [],
      metadata: { publicationId: id + ":call-1", sourceInputId: id, thoughtRunId: "thought", workStatus: "completed" } } satisfies UIMessage;
    const history = turns.map(row);
    expect(unrepresentedHistory(history, [empty], [])).toEqual(history);
    for (const initial of [[], [empty], [{ ...empty, metadata: { ...empty.metadata, publicationId: id + ":call-2" } }]]) {
      const messages = mergeDialogueHistory(initial, turns);
      const view = dialogueStreamRows(messages);
      expect(view.workSeats.size + view.utterances.size).toBe(1);
      const replies = [...view.utterances.values()].flatMap(value => value.publications.map(p => p.utterance));
      for (const value of view.workSeats.values()) {
        for (const reply of value.replies ?? []) if (reply.kind === "utterance") replies.push(reply.utterance);
      }
      expect(replies.map(reply => reply.utteranceId)).toEqual([id + ":call-1", id + ":call-2"]);
      expect(replies.flatMap(reply => reply.blocks.flatMap(b => b.kind === "markdown" ? [b.text] : []))).toEqual([first, second]);
      expect(unrepresentedHistory(history, messages, [])).toEqual([]);
      expect(mergeDialogueHistory(messages, turns)).toEqual(messages);
    }
  });

  it("repairs an old text-only turn and renders locally recovered text that has only a publication ID", () => {
    const savedText = "Synthetic opening time.";
    const raw = "## Turn legacyA — " + timestamp + " (agent)\n\n" + savedText;
    const turns = parseSlice(raw).turns;
    const [message] = mergeDialogueHistory([{ id: "legacy-seat", role: "assistant", parts: [],
      metadata: { recoveryTurnId: "legacyA" } }], turns);
    expect(message?.id).toBe("legacy-seat");
    const view = dialogueStreamRows([{ ...message!, metadata: { publicationId: "old-text-only-publication" } }]);
    expect([...view.workSeats.values()][0]?.replies?.[0]).toMatchObject({
      kind: "message", message: { parts: [{ type: "text", text: savedText }] },
    });
  });
});
