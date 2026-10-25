import type { Turn } from "@/lib/episodic/types";
import type { UIMessage, UIMessagePart } from "./protocol";
import { mergeSavedTurns } from "./reconnect";
import { visibleAssistantText } from "./assistant-text";

const KEY = "previously:deepseek-replay:v1";
const MAX_ENTRIES = 24;
const MAX_BYTES = 1024 * 1024;
type ReplayPart = Extract<UIMessagePart, { type: `data-${string}` }>;
export interface NativeReplayEntry {
  userId: string;
  userText: string;
  assistantText: string;
  parts: ReplayPart[];
}
const text = (message: UIMessage) => message.parts.filter((part) => part.type === "text").map((part) => part.text).join("");
const assistantText = visibleAssistantText;
const replayParts = (message: UIMessage) => message.parts.filter((part): part is ReplayPart => part.type === "data-deepseek-step");

/** A local optimization, never an authority for which turns exist. */
export function readNativeReplay(): NativeReplayEntry[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw || raw.length * 2 > MAX_BYTES) return [];
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value) || value.length > MAX_ENTRIES) return [];
    return value.filter((entry): entry is NativeReplayEntry => Boolean(entry && typeof entry === "object"
      && typeof entry.userId === "string" && typeof entry.userText === "string" && typeof entry.assistantText === "string"
      && Array.isArray(entry.parts) && entry.parts.every((part: ReplayPart) => part && part.type === "data-deepseek-step"
        && part.data && typeof part.data === "object" && Array.isArray((part.data as { messages?: unknown }).messages))));
  } catch { return []; }
}

/** Only finished answers enter the bounded archive; quota/private-mode failures
 * silently fall back to the authoritative visible transcript. */
export function rememberNativeReplay(messages: readonly UIMessage[]): void {
  try {
    const entries = readNativeReplay();
    let user: UIMessage | undefined;
    for (const message of messages) {
      if (message.role === "user") { user = message; continue; }
      if (message.role !== "assistant" || !user) continue;
      const parts = replayParts(message);
      if (!parts.length) continue;
      const entry: NativeReplayEntry = { userId: user.id, userText: text(user), assistantText: assistantText(message), parts };
      const previous = entries.findIndex((item) => item.userId === entry.userId && item.assistantText === entry.assistantText);
      if (previous >= 0) entries.splice(previous, 1);
      // One oversized turn must not evict all smaller, useful entries.
      if (JSON.stringify([entry]).length * 2 > MAX_BYTES) continue;
      entries.push(entry);
    }
    while (entries.length > MAX_ENTRIES || JSON.stringify(entries).length * 2 > MAX_BYTES) entries.shift();
    localStorage.setItem(KEY, JSON.stringify(entries));
  } catch { /* Optional replay cache, never block a conversation. */ }
}

/** The caller supplies server-authoritative current-slice history or pending
 * completed run results. IDs and user text are exact; assistant text alone
 * tolerates outer trimming from the disk roundtrip, never internal edits. */
export function restoreNativeReplay(messages: readonly UIMessage[], entries = readNativeReplay()): UIMessage[] {
  let user: UIMessage | undefined;
  return messages.map((message) => {
    if (message.role === "user") { user = message; return message; }
    if (message.role !== "assistant" || !user || replayParts(message).length) return message;
    const match = entries.find((entry) => entry.userId === user!.id && entry.userText === text(user!) && entry.assistantText.trim() === assistantText(message).trim());
    return match ? { ...message, parts: [...message.parts, ...match.parts] } : message;
  });
}

/** Restored slice turns are rendered outside the live hook. Include their
 * verified history when sending, without seating duplicate bubbles or adding
 * an archived turn that the authoritative current slice no longer contains. */
export function messagesWithNativeReplay(working: readonly UIMessage[], savedTurns: readonly Turn[]): UIMessage[] {
  const currentUsers = new Set(working.filter((message) => message.role === "user").map((message) => message.id));
  let include = false;
  const history = mergeSavedTurns([], savedTurns).filter((message) => {
    if (message.role === "user") include = !currentUsers.has(message.id);
    return include;
  });
  return restoreNativeReplay([...history, ...working]);
}
