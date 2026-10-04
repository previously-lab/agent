/**
 * Pure subtitle reducer for the permanent pill strip — folds the raw AI SDK
 * part stream of the IN-FLIGHT turn into the ONE discrete caption block shown
 * above the pill.
 *
 * THE CONTRACT (2026-10-04, replacing the old one). The subtitle is the
 * mini-state's live display of WHAT THE AGENT IS DOING — game-subtitle style
 * (an NPC radio line): a sequence of DISCRETE caption blocks —
 * `previously:（正在思考）` → `（正在搜索）` → `（正在回忆）` — each block
 * REPLACING the previous one as the turn advances. It is never a streaming
 * rendering of the reply text: the words live in the conversation surfaces
 * (the DOM list in the expanded panel, history in the R3F field), and the
 * subtitle's job is the activity, not the speech. The old hard rule — "the
 * panel and the subtitle must show the SAME words" — is REVOKED by this
 * contract; the two surfaces now deliberately show different things.
 *
 * THE ACTIVITY LADDER. Parts are scanned in natural stream order and the
 * LATEST signal wins — that is what makes the blocks replace each other:
 *
 *   reasoning part              → thinking   （正在思考）
 *   tool-thinkDeep              → thinking
 *   tool-webSearch / webFetch   → searching  （正在搜索）
 *   memory-read tools           → recalling  （正在回忆）
 *     (isRecallTool, build-stream.ts: read* / listSlices / listStrands /
 *      listDocs — THE shared truth table, not a local copy)
 *   any other tool-*            → reading    （正在查阅 N 条记忆）
 *   data-phase                  → housekeeping （正在整理）
 *   non-empty text part         → replying   （正在回复）
 *   data-turn-status: done      → the turn is over — the fold returns null
 *
 * A user message as the newest live entry means the turn has just launched
 * with no agent signal yet — the fold reads it as `thinking`. Anything else
 * (data-tool-progress narration, step boundaries, errors, file parts)
 * carries no activity and is ignored.
 *
 * The module stays free of React, DOM, i18n and time: given the same part
 * list it always folds to the same block, so streaming growth is a pure
 * function of the parts seen so far. The caller maps `activity` to a
 * translated label and owns all presentation.
 *
 * The input vocabulary is the exact `AnyPart` shape from build-stream.ts —
 * the same parts the chat UI already classifies — so no new wire abstraction
 * is invented here.
 */

import { isRecallTool, type AnyPart } from "@/lib/chat/build-stream";

// Re-exported so consumers (and tests) can speak the part vocabulary through
// this module without importing build-stream directly.
export type { AnyPart };

/** What the agent is doing right now — the discrete caption blocks. */
export type SubtitleActivityKind =
  | "thinking"
  | "searching"
  | "recalling"
  | "reading"
  | "replying"
  | "housekeeping";

export interface SubtitleLine {
  /** The current caption block — it REPLACES the previous one, never grows. */
  activity: SubtitleActivityKind;
  /** Distinct tool calls seen so far this turn — the reading label's count
   *  (the AI SDK emits several parts per call across its lifecycle; the count
   *  is per toolCallId, not per part). */
  count: number;
}

/** The tool name behind a `tool-*` part: the part's own `toolName` when the
 *  SDK carries it, else the type with its `tool-` prefix stripped. */
function toolNameOf(part: AnyPart): string {
  const named = (part as { toolName?: unknown }).toolName;
  if (typeof named === "string" && named) return named;
  const type = part.type;
  return typeof type === "string" ? type.replace(/^tool-/, "") : "";
}

/** Which caption block a tool call lights up. The memory-read family is
 *  `isRecallTool`'s call (build-stream.ts) — the SAME truth table the stage
 *  pill derives from, so the caption and the panel can never disagree about
 *  what "回忆" means. Everything else the count carries as "查阅". */
function activityForTool(toolName: string): SubtitleActivityKind {
  if (isRecallTool(toolName)) return "recalling";
  switch (toolName) {
    case "webSearch":
    case "webFetch":
      return "searching";
    case "thinkDeep":
      return "thinking";
    default:
      return "reading";
  }
}

/**
 * Folds one message's raw parts into the current caption block. The scan
 * walks parts in natural order and lets the LATEST activity signal win —
 * appending deltas to the stream can only move the block forward, so every
 * prefix of the same stream replays identically (pure and prefix-stable).
 *
 * Returns null when the turn has CLOSED (a `data-turn-status: done` part) —
 * a settled turn has no activity to caption, and the caller drops the line.
 */
export function foldSubtitleActivity(
  parts: readonly AnyPart[],
): SubtitleLine | null {
  let activity: SubtitleActivityKind | null = null;
  let done = false;
  const toolCallIds = new Set<string>();

  for (const p of parts) {
    if (p.type === "reasoning") {
      activity = "thinking";
    } else if (p.type === "text") {
      // The reply's words never become the caption — their arrival only
      // advances the block to "replying".
      if ((p.text ?? "").trim().length > 0) activity = "replying";
    } else if (typeof p.type === "string" && p.type.startsWith("tool-")) {
      const id = (p as { toolCallId?: string }).toolCallId ?? p.type;
      toolCallIds.add(id);
      activity = activityForTool(toolNameOf(p));
    } else if (p.type === "data-phase") {
      activity = "housekeeping";
    } else if (p.type === "data-turn-status") {
      const status = (p as { data?: { status?: string } }).data?.status;
      if (status === "done") done = true;
    }
    // Everything else (data-tool-progress narration, step boundaries,
    // errors, file parts) carries no activity — ignored by construction.
  }

  if (done) return null;
  // No signal yet (a freshly created assistant message) still reads as
  // thinking — the turn is launched, the agent simply hasn't spoken.
  return { activity: activity ?? "thinking", count: toolCallIds.size };
}

/** One message presented to the folder: its raw part stream, its UIMessage
 *  role, and whether it belongs to the LIVE run. History turns restored from
 *  a slice are happened time — they must never light up the activity
 *  caption, so the caller marks them `live: false` (or omits them). */
export interface SubtitleSource {
  parts: readonly AnyPart[];
  role: string;
  live: boolean;
}

/** The caption for the whole stream: the NEWEST LIVE message's fold. A user
 *  message as the newest live entry means the turn just launched — the agent
 *  has produced no signal yet, which reads as `thinking`. Null when no live
 *  turn exists or the newest live turn has closed. */
export function foldSubtitleLineLatest(
  messages: readonly SubtitleSource[],
): SubtitleLine | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const source = messages[i];
    if (!source.live) continue;
    if (source.role === "user") return { activity: "thinking", count: 0 };
    return foldSubtitleActivity(source.parts);
  }
  return null;
}
