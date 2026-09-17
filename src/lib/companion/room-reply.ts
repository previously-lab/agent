/**
 * The room panel's reply path — the user's words back to Previously, through
 * the EXISTING chat turn (POST /api/chat), so a reply spoken inside a room
 * becomes a memory like any other message.
 *
 * The endpoint runs every turn inside a durable workflow run and answers
 * with the run's UI-message stream. This helper deliberately does NOT read
 * that stream: the run is the point (it persists the message server-side),
 * and the game panel has no chat surface to render a reply into. Once the
 * run is accepted (res.ok, the `x-workflow-run-id` header is on the
 * response) the body is cancelled and the run continues without us — the
 * same durability the chat page relies on when a tab reloads mid-turn.
 *
 * The request is a same-origin browser fetch, so the origin guard
 * (src/lib/security/origin-guard.ts) passes it exactly like the main
 * composer's call. DOM-free and fetch-injectable, like narrate.ts, so the
 * contract is unit-testable under vitest's node environment.
 */

export class RoomReplyError extends Error {
  /** The HTTP status when there was one (absent for network failure). */
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "RoomReplyError";
    if (status !== undefined) this.status = status;
  }
}

export interface RoomReplyInput {
  text: string;
  locale?: string;
  timezone?: string;
  signal?: AbortSignal;
  /** Test seam — defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * Send one user message as a new chat turn. Resolves once the turn is
 * ACCEPTED (the durable run started — the words are on their way into
 * memory), rejects with RoomReplyError on an empty message, an HTTP error,
 * or a network failure.
 */
export async function sendRoomReply(input: RoomReplyInput): Promise<void> {
  const text = input.text.trim();
  if (!text) throw new RoomReplyError("empty reply");
  const fetchImpl = input.fetchImpl ?? fetch;

  let res: Response;
  try {
    res = await fetchImpl("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        // The route's contract: UIMessage[] (ai SDK), plus the optional
        // model/timezone/locale fields it reads. The model stays
        // server-pinned (demo lock) — the composer does not send one from
        // here either.
        messages: [
          {
            id: crypto.randomUUID(),
            role: "user",
            parts: [{ type: "text", text }],
          },
        ],
        ...(input.timezone ? { timezone: input.timezone } : {}),
        ...(input.locale ? { locale: input.locale } : {}),
      }),
      ...(input.signal ? { signal: input.signal } : {}),
    });
  } catch (e) {
    throw new RoomReplyError(e instanceof Error ? e.message : String(e));
  }

  if (!res.ok) {
    throw new RoomReplyError(`chat request failed (${res.status})`, res.status);
  }

  // The run is accepted and durable; the stream is the chat UI's rendering
  // channel, not ours. Cancel it so the connection closes cleanly — the run
  // itself is unaffected (that is what the reconnect path is built on).
  try {
    await res.body?.cancel();
  } catch {
    // already closed / locked — nothing to clean up
  }
}
