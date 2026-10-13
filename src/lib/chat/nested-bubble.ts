/**
 * Episode wire contracts (v0.30 §3, batch B) — the concurrent-nesting
 * machinery's two frame vocabularies, one file because both are the episode's
 * wire surface:
 *
 *  1. `data-nested-bubble` frames — E (the outer episode run) → the client,
 *     reporting one inner instance's lifecycle (queued → running → done |
 *     failed). E's steps write them onto the run's single durable stream via
 *     getWritable (the hq-steps.ts precedent: frame writes happen INSIDE
 *     steps). The client keeps them in a side store keyed by turnId — they
 *     never enter UIMessage (§4.2), so a replayed stream rebuilds the bubbles
 *     deterministically. UI consumption lands in batch C; this file is the
 *     contract both sides code against.
 *
 *  2. EpisodeInboxEvent — the single inbox hook's two payload kinds
 *     (裁决 D2): the messages route's "arrived" tap (the message is already
 *     on disk — the tap is only a wake-up; E re-reads the slice) and an inner
 *     run's "bubble" answer report. The hook token derives from the outer
 *     run's id (`episode:<runId>`) so the route needs nothing else.
 *
 * PURE module (no fs, no next) — the route, both workflows, the steps and the
 * client all import it. Normalizers degrade malformed input to null, never
 * throw: a replayed/foreign chunk must not kill the reader.
 */

// ─── data-nested-bubble frames (E → client) ───────────────────────────────

/** The chunk type every nested-bubble frame rides. */
export const NESTED_BUBBLE_CHUNK = "data-nested-bubble";

/**
 * Instance lifecycle. `queued`/`running` are emitted at spawn time; `done`
 * carries the answer text; `failed` means the inner run ended without a
 * usable answer (the merged summary states it plainly — §3.6).
 */
export type NestedBubbleStatus = "queued" | "running" | "done" | "failed";

export interface NestedBubbleFrame {
  /** The user turn this bubble answers (the slice turnId of that message). */
  replyTo: string;
  /** This instance's own id — the bubble's turnId on disk at finalize. */
  turnId: string;
  status: NestedBubbleStatus;
  /** done: the inner run's full answer text. Absent otherwise (v1: no
   *  partial streaming back — D5). */
  text?: string;
  /** done/failed: ISO stamp, applied server-side at frame-write time. */
  doneAt?: string;
}

const STATUSES: readonly NestedBubbleStatus[] = [
  "queued",
  "running",
  "done",
  "failed",
];

/** Tolerant normalize: a malformed frame degrades to null, never throws. */
export function normalizeNestedBubble(raw: unknown): NestedBubbleFrame | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.replyTo !== "string" || !o.replyTo) return null;
  if (typeof o.turnId !== "string" || !o.turnId) return null;
  if (!STATUSES.includes(o.status as NestedBubbleStatus)) return null;
  const frame: NestedBubbleFrame = {
    replyTo: o.replyTo,
    turnId: o.turnId,
    status: o.status as NestedBubbleStatus,
  };
  if (typeof o.text === "string" && o.text) frame.text = o.text;
  if (typeof o.doneAt === "string" && o.doneAt) frame.doneAt = o.doneAt;
  return frame;
}

// ─── The episode inbox hook (route / inner run → E) ──────────────────────

/**
 * Derive the episode inbox hook token from the outer run's id. Pure — the
 * messages route reconstructs it from the path's runId alone (D1).
 */
export function episodeInboxToken(runId: string): string {
  return `episode:${runId}`;
}

/**
 * One hook, two kinds (D2):
 *  - arrived — the messages route persisted a new user turn (the disk is the
 *    queue; this is only the wake-up tap). HookNotFoundError on the route =
 *    E exited or never registered — the message stays on disk and the drain's
 *    disk reconciliation picks it up, so nothing is lost.
 *  - bubble — an inner run's terminal report. `text` carries the full answer
 *    (possibly empty on failure); `finishReason` mirrors the agent stream's.
 */
export type EpisodeInboxEvent =
  | { kind: "arrived"; turnId: string }
  | {
      kind: "bubble";
      /** The inner instance's own id (= the bubble frame's turnId). */
      turnId: string;
      /** The user turn the instance answered. */
      replyTo: string;
      text: string;
      finishReason: string;
    };

/** Tolerant normalize for hook payloads (the hook is an open wire). */
export function normalizeEpisodeInboxEvent(
  raw: unknown,
): EpisodeInboxEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (o.kind === "arrived") {
    return typeof o.turnId === "string" && o.turnId
      ? { kind: "arrived", turnId: o.turnId }
      : null;
  }
  if (o.kind === "bubble") {
    if (typeof o.turnId !== "string" || !o.turnId) return null;
    if (typeof o.replyTo !== "string" || !o.replyTo) return null;
    return {
      kind: "bubble",
      turnId: o.turnId,
      replyTo: o.replyTo,
      text: typeof o.text === "string" ? o.text : "",
      finishReason: typeof o.finishReason === "string" ? o.finishReason : "error",
    };
  }
  return null;
}
