import type { UIMessage } from "@/lib/chat/protocol";
import type { ChatStreamItem, HistoryStreamItem } from "@/lib/chat/stream-items";
import { recoveredTurnIds } from "@/lib/chat/reconnect";
import type { ManuscriptEntry } from "./dialogue-projection";

/** The legacy projection can predate the newest v2 record. Source order is
 * not conversation order; stable time ordering also keeps a slice heading
 * ahead of its first turn and preserves same-time publication order. */
export function orderDialogueItems(items: readonly ChatStreamItem[]): ChatStreamItem[] {
  return items.map((item, index) => ({ item, index, time: Date.parse(item.timeIso) }))
    .sort((a, b) => (Number.isFinite(a.time) && Number.isFinite(b.time) ? a.time - b.time : 0) || a.index - b.index)
    .map(({ item }) => item);
}

/** Saved dialogue is the cross-device recovery source. Hide a saved turn only
 * when its exact identity is already represented in the live projection. V2
 * writes records without adding events to the legacy dialogue control store. */
export function unrepresentedHistory(
  history: readonly HistoryStreamItem[],
  messages: readonly UIMessage[],
  entries: readonly ManuscriptEntry[],
): HistoryStreamItem[] {
  const restored = new Set(recoveredTurnIds(messages));
  const users = new Set(messages.filter(message => message.role === "user").map(message => message.id));
  for (const entry of entries) {
    if (entry.kind === "input") {
      users.add(entry.input.clientMessageId);
      users.add(entry.input.inputId);
    } else if (entry.kind === "utterance") {
      restored.add(entry.utterance.utteranceId);
    } else {
      restored.add(entry.message.id);
      if (entry.message.metadata && typeof entry.message.metadata === "object") {
        const metadata = entry.message.metadata as Record<string, unknown>;
        if (typeof metadata.utteranceId === "string") restored.add(metadata.utteranceId);
        if (typeof metadata.publicationId === "string") restored.add(metadata.publicationId);
      }
    }
  }
  return history.filter(item => {
    if (item.kind !== "history-turn") return true;
    const { turn } = item;
    if (turn.turnId && restored.has(turn.turnId)) return false;
    if (turn.dialogue?.kind === "public_utterance" && restored.has(turn.dialogue.publicationId)) return false;
    if (turn.role === "user") {
      if (turn.clientMessageId && users.has(turn.clientMessageId)) return false;
      if (turn.dialogue?.kind === "user_input" && users.has(turn.dialogue.inputId)) return false;
    }
    return true;
  });
}
