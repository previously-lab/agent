import type { UIMessage } from "@/lib/chat/protocol";
import type { TurnRunResult } from "./turn-types";
import type { Turn } from "@/lib/episodic/types";
import type { ChatRecovery } from "./actions";
import { createDocumentContextMetadata } from "./document-context";

/** The pending-summary window restores authoritative completed run results. */
export function recoveryMessages(records: TurnRunResult[], persistedTurnIds: ReadonlySet<string> = new Set(), persistedUserIds: ReadonlySet<string> = new Set()): UIMessage[] {
  const byTurn = new Map(records.map((record) => [record.turnId, record]));
  const userIds = new Set(persistedUserIds);
  return [...byTurn.values()].sort((a, b) => a.at.localeCompare(b.at)).flatMap((record): UIMessage[] => {
    if (persistedTurnIds.has(record.turnId)) return [];
    const userId = record.clientMessageId ?? `recovery-user-${record.turnId}`;
    const showUser = !userIds.has(userId);
    userIds.add(userId);
    return [
      ...(showUser ? [{ id: userId, role: "user" as const, metadata: { recoveryTurnId: record.turnId, ...(createDocumentContextMetadata(record.documentContext ?? []) ?? {}) }, parts: [{ type: "text" as const, text: record.userText }] }] : []),
      ...(record.replyText ? [{ id: `recovery-agent-${record.turnId}`, role: "assistant" as const, metadata: { recoveryTurnId: record.turnId }, parts: [
        { type: "text" as const, text: record.replyText },
        ...(record.nativeMessages?.length ? [{ type: "data-deepseek-step" as const, id: `recovery-native-${record.turnId}`, data: { messages: record.nativeMessages } }] : []),
      ] }] : []),
    ];
  });
}

/** History can finish loading after a pending run was restored into useDurableChat. */
export function recoveredTurnIds(messages: readonly UIMessage[]): ReadonlySet<string> {
  return new Set(messages.map((message) => (message.metadata as { recoveryTurnId?: string } | undefined)?.recoveryTurnId).filter((id): id is string => typeof id === "string"));
}

/** Merge authoritative completed lanes into the main run's reconnect stash. */
export function mergeRecoveredMessages(stored: readonly UIMessage[], records: TurnRunResult[], persistedTurnIds: ReadonlySet<string> = new Set(), persistedUserIds: ReadonlySet<string> = new Set()): UIMessage[] {
  const result = [...stored];
  for (const record of [...new Map(records.map((entry) => [entry.turnId, entry])).values()].sort((a, b) => a.at.localeCompare(b.at))) {
    const knownUsers = new Set([...persistedUserIds, ...result.filter((message) => message.role === "user").map((message) => message.id)]);
    const additions = recoveryMessages([record], persistedTurnIds, knownUsers);
    const userId = record.clientMessageId ?? `recovery-user-${record.turnId}`;
    const userAt = result.findIndex((message) => message.id === userId && message.role === "user");
    const answer = additions.find((message) => message.role === "assistant");
    if (userAt >= 0 && answer) {
      let end = userAt + 1;
      while (end < result.length && result[end].role !== "user") end++;
      const knownAnswer = result.findIndex((message) => message.id === answer.id);
      if (knownAnswer >= 0) result[knownAnswer] = answer;
      else if (!record.regenerate && result[userAt + 1]?.role === "assistant") result[userAt + 1] = answer;
      else result.splice(end, 0, answer);
      // Mark the restored question too, so a later history read cannot seat it twice.
      result[userAt] = { ...result[userAt], metadata: { ...(result[userAt].metadata as object | undefined), ...(createDocumentContextMetadata(record.documentContext ?? []) ?? {}), recoveryTurnId: record.turnId } };
      continue;
    }
    for (const message of additions) {
      const existing = result.findIndex((entry) => entry.id === message.id);
      if (existing >= 0) result[existing] = message;
      else result.push(message);
    }
  }
  return result;
}

/** Acknowledged bypasses have left the pending registry but remain in the slice. */
export function mergeSavedTurns(stored: readonly UIMessage[], turns: readonly Turn[]): UIMessage[] {
  const result = [...stored];
  const users = new Map<string, string>();
  const text = (message: UIMessage) => message.parts.filter((part) => part.type === "text").map((part) => part.text).join("");
  for (const turn of turns) {
    const key = turn.turnId ?? turn.timestamp;
    if (turn.role === "user") {
      const id = turn.clientMessageId ?? `saved-user-${key}`;
      users.set(key, id);
      const existing = result.findIndex((message) => message.role === "user" && message.id === id);
      if (existing >= 0) result[existing] = { ...result[existing], metadata: { ...(result[existing].metadata as object | undefined), ...(createDocumentContextMetadata(turn.documentContext ?? []) ?? {}), recoveryTurnId: turn.turnId } };
      else result.push({ id, role: "user", metadata: { recoveryTurnId: turn.turnId, ...(createDocumentContextMetadata(turn.documentContext ?? []) ?? {}) }, parts: [{ type: "text", text: turn.content }] });
      continue;
    }
    const userId = users.get(turn.replyTo ?? key);
    const userAt = userId ? result.findIndex((message) => message.role === "user" && message.id === userId) : -1;
    let end = userAt + 1;
    if (userAt >= 0) while (end < result.length && result[end].role !== "user") end++;
    const id = `saved-agent-${key}`;
    let existing = result.findIndex((message) => message.id === id);
    if (existing < 0 && userAt >= 0) existing = result.findIndex((message, index) => index > userAt && index < end && message.role === "assistant" && text(message) === turn.content && (!(message.metadata as { recoveryTurnId?: string } | undefined)?.recoveryTurnId || (message.metadata as { recoveryTurnId?: string }).recoveryTurnId === turn.turnId));
    if (existing >= 0) result[existing] = { ...result[existing], metadata: { ...(result[existing].metadata as object | undefined), recoveryTurnId: turn.turnId } };
    else {
      const message: UIMessage = { id, role: "assistant", metadata: { recoveryTurnId: turn.turnId }, parts: [{ type: "text", text: turn.content }] };
      if (userAt >= 0) result.splice(end, 0, message);
      else result.push(message);
    }
  }
  return result;
}

/**
 * Drop the trailing partial assistant message(s) — the in-flight reply of the
 * turn being reconnected.
 *
 * The reconnect stream replays from index 0 and rebuilds the whole turn, so if
 * the client still holds the partial assistant message (same-session reconnect,
 * no reload), a resume would append a second copy of it: two messages rendering
 * the same content, and — under a concurrent second stream — the same message
 * id alternating in the list. Both paths feed React's duplicate-key
 * reconciliation, which can loop into "Maximum update depth exceeded" (#185).
 *
 * Prior turns (user/assistant pairs before the current user message) are left
 * intact; the replay then rebuilds the resumed turn cleanly. If the list does
 * not end with an assistant message (fresh page, or a new turn is still in
 * flight), this is a no-op.
 */
export function dropTrailingAssistantMessages(
  messages: readonly UIMessage[],
): UIMessage[] {
  let end = messages.length;
  while (end > 0 && messages[end - 1].role === "assistant") end--;
  return messages.slice(0, end);
}

export interface ArrivalDecision {
  /** Passed to useDurableChat's `resume` — re-attach to the in-flight run's stream. */
  shouldResume: boolean;
  /** Passed to useDurableChat's `messages` — the conversation the live view opens with. */
  initialMessages: UIMessage[];
}

/**
 * The mount-time arrival decision — the pure half (side effects like reading /
 * clearing localStorage live in the caller).
 *
 * The rule is one-dimensional: the live view's useDurableChat state restores ONLY
 * in-flight work. `runActive` is the server's verdict on the persisted run
 * ("pending" / "running" — see isChatRunActive); the client never infers slice
 * boundaries from timestamps or silence windows.
 *
 * - Run still active → genuine reconnect: keep the working conversation, but
 *   drop the trailing partial assistant turn (the replay rebuilds it).
 * - Anything else (no run, or a terminal one) → useDurableChat opens empty. This is
 *   NOT "the conversation is gone": since v0.10, continuity for an alive
 *   slice is restored from the slice itself (getArrivalState — see
 *   resolveArrival), and older conversation lives in the unified stream's
 *   paged history. The localStorage stash's only remaining job is the
 *   in-flight reconnect above.
 */
export function decideArrival(
  runActive: boolean,
  stored: readonly UIMessage[],
): ArrivalDecision {
  if (runActive) {
    return {
      shouldResume: true,
      initialMessages: dropTrailingAssistantMessages(stored),
    };
  }
  return { shouldResume: false, initialMessages: [] };
}

// ─── Arrival gate timeout ─────────────────────────────────────────────────

/**
 * Hard cap on the authoritative history read. The reads underneath carry
 * their own GitHub budget; this gate is
 * the UI-level backstop so a degraded network/server surfaces the retry card
 * instead of an endless skeleton.
 */
export const ARRIVAL_GATE_TIMEOUT_MS = 15_000;

export type ArrivalGateResult<T> =
  | { kind: "ok"; verdict: T }
  | { kind: "timeout" }
  | { kind: "failed"; error: unknown };

/**
 * Bound a read without confusing a rejection with a timeout. The promise must
 * be read-only: apply any persistence effects only after accepting its result.
 * A late rejection remains handled, but a late success cannot mutate storage.
 */
export async function raceArrivalVerdict<T>(
  verdict: Promise<T>,
  timeoutMs: number = ARRIVAL_GATE_TIMEOUT_MS,
): Promise<ArrivalGateResult<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      verdict.then((v): ArrivalGateResult<T> => ({ kind: "ok", verdict: v })),
      new Promise<ArrivalGateResult<T>>((resolve) => {
        timer = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
      }),
    ]);
  } catch (error) {
    return { kind: "failed", error };
  } finally {
    clearTimeout(timer);
  }
}

/** Old workflow availability must not consume the history read's whole budget. */
export const ARRIVAL_RECOVERY_TIMEOUT_MS = 3_000;
/** Discard a dead reconnect session without claiming it was saved. Unknown
 * transport errors retain their identifiers for a later background attempt. */
export function shouldDiscardRecoveredSession(
  recovery: ChatRecovery | null,
  runIds: readonly string[],
  summaryRunIds: readonly string[],
): boolean {
  if (!recovery || recovery.activeRunIds.length || recovery.records.length || recovery.unavailableRunIds.length) return false;
  const released = new Set([...recovery.savedRunIds, ...(recovery.missingRunIds ?? []), ...(recovery.abandonedRunIds ?? [])]);
  const summaries = new Set([...(recovery.savedSummaryRunIds ?? []), ...(recovery.missingSummaryRunIds ?? [])]);
  return runIds.every((id) => released.has(id)) && summaryRunIds.every((id) => summaries.has(id));
}

/** Keep the authoritative history read and optional workflow read independent.
 * Neither rejected history nor a stale workflow is an empty-memory verdict. */
export async function readArrivalWithRecovery<A>(
  arrival: Promise<A>,
  recovery: () => Promise<ChatRecovery>,
) {
  const history = await raceArrivalVerdict(arrival);
  if (history.kind !== "ok") return history;
  // Next may serialize Server Actions. Do not enqueue an optional workflow
  // read until authoritative history has completed, even with Promise.race.
  const recoveryRead = await raceArrivalVerdict(Promise.resolve().then(recovery), ARRIVAL_RECOVERY_TIMEOUT_MS);
  return { kind: "ok" as const, verdict: { arrival: history.verdict, recovery: recoveryRead } };
}
