/**
 * Pure subtitle reducer for the permanent pill strip (design v0.13 §4) — folds
 * the raw AI SDK part stream of ONE message into the single live subtitle line
 * shown at the bottom of the screen.
 *
 * The subtitle is a *selective* rendering of the stream: it surfaces only the
 * spoken words and never tool calls or reasoning (hard product rule — the
 * panel and the subtitle must show the SAME words, so the text is always the
 * message's own opening, never a paraphrase). Tool and reasoning activity may
 * only leak through as the `status` field (`thinking` / `reading`) while there
 * is no text yet.
 *
 * The module is intentionally free of React, DOM, i18n and time: given the
 * same part list it always folds to the same line, so streaming growth is a
 * pure function of the parts seen so far — a longer stream whose prefix
 * matches replays identically. The caller maps `status.kind` to a translated
 * string and owns all presentation.
 *
 * The input vocabulary is the exact `AnyPart` shape from build-stream.ts —
 * the same parts the chat UI already classifies — so no new wire abstraction
 * is invented here.
 */

import type { AnyPart } from "@/lib/chat/build-stream";

// Re-exported so consumers (and tests) can speak the part vocabulary through
// this module without importing build-stream directly.
export type { AnyPart };

/**
 * Maximum length of the subtitle text, in characters, before truncation.
 * Chosen at 150 — the pill subtitle renders as an FPS-radio block (fixed
 * 112px speaker column + body, at most TWO 20px lines at mono 11px, capped
 * block width), whose body track holds roughly 75 characters per line at a
 * desktop block width, so two lines stay readable well past a single
 * sentence's opening and the cap lands where the second line would clip.
 * The reducer only guarantees the character budget and the word-boundary
 * cut (see truncateSubtitleText); the UI owns line wrapping.
 */
export const SUBTITLE_LINE_MAX = 150;

/** Margin (in characters) within which a word-boundary cut is preferred over
 *  a hard character cut — cutting up to this many characters short of the cap
 *  is considered "avoiding mid-word", because a truncated word reads as a
 *  typo while a slightly shorter line reads as intentional typography. */
const WORD_CUT_SLACK = 12;

/** Who is speaking in the line currently shown. */
export type SubtitleSpeaker = "user" | "persona";

/**
 * What to show when there is no spoken text yet. `thinking` covers pure
 * reasoning time; `reading` lights up once tool calls have started and
 * carries how many distinct tool calls the turn has made so far (the count
 * is what lets the UI say "查阅 3 条记忆" without the reducer knowing any
 * i18n).
 */
export type SubtitleStatus =
  | { kind: "thinking" }
  | { kind: "reading"; count: number };

export interface SubtitleLine {
  /** Who is speaking in the line currently shown. */
  speaker: SubtitleSpeaker;
  /** The line's text — collapsed and truncated to the two-line budget. */
  text: string;
  /** True when `text` was cut short (the UI shows an ellipsis / expand hint). */
  truncated: boolean;
  /** What to show when there is no text yet; null as soon as text exists. */
  status: SubtitleStatus | null;
}

/**
 * Collapses all whitespace runs (newlines, tabs, repeated spaces — the reply
 * arrives as markdown paragraphs) into single spaces and trims the ends, so a
 * multi-line reply still reads as one flowing paragraph in the pill. Pure and
 * deterministic.
 */
export function collapseSubtitleWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Trims `text` to at most `max` characters for the two-line display, cutting
 * at the last word boundary when one lies within WORD_CUT_SLACK characters of
 * the cap (never mid-word if a few characters' slack lets us avoid it) and
 * stripping the trailing punctuation/space a boundary cut would leave behind.
 * Returns the cut text plus whether a cut happened.
 */
export function truncateSubtitleText(
  text: string,
  max: number = SUBTITLE_LINE_MAX,
): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };

  const window = text.slice(0, max);
  // A boundary is a space inside the window; the cut point is right before it.
  const lastBoundary = window.lastIndexOf(" ");
  let cut =
    lastBoundary >= max - WORD_CUT_SLACK ? window.slice(0, lastBoundary) : window;
  // A word-boundary cut leaves dangling punctuation and a trailing space —
  // both read as accidents in a one-line pill, so tidy the tail. The ellipsis
  // itself is the caller's presentation choice, not ours.
  cut = cut.replace(/[\s,.;:!?、。，；：!?—–-]+$/, "");
  return { text: cut, truncated: true };
}

/**
 * Folds one message's raw parts into the current subtitle line. `role` is the
 * message's UIMessage role: "user" speaks as "user", anything the assistant
 * produces (role "assistant", including bridge re-emits) speaks as "persona".
 *
 * The fold walks parts in natural order and keeps, at every prefix, the same
 * answer — this is what makes streaming growth deterministic: appending deltas
 * to the text part grows `text` in place, and replaying the same prefix from a
 * reconnect yields the identical line.
 *
 * Rules applied, in priority order:
 *  - `text` parts: appended verbatim (then collapsed/truncated at the end) —
 *    including the bridge authoritative re-emit block, whose REPLACE semantics
 *    build-stream applies; here the marked block drops all previously
 *    accumulated advisory text instead of appending, mirroring "the result
 *    wins".
 *  - `reasoning` parts: contribute to `status: thinking` only, never text.
 *  - `tool-*` parts: counted by distinct toolCallId (the AI SDK emits several
 *    parts per call — input-streaming / input-available / output-available —
 *    and each call must count once); once any exists, `status` is `reading`.
 *  - `data-tool-progress` / `data-phase` / `data-evolution` / housekeeping /
 *    `data-turn-status` / `step-*` / `error` parts: no spoken words — ignored.
 *    Tool-progress chunks in particular carry the tool's streaming narration,
 *    which is exactly the tool content the subtitle must never show.
 *  - As soon as any non-whitespace text exists, `status` is null regardless
 *    of reasoning or tool activity — text always wins over status.
 */
export function foldSubtitleLine(
  parts: readonly AnyPart[],
  role: string,
): SubtitleLine {
  const speaker: SubtitleSpeaker = role === "user" ? "user" : "persona";

  let rawText = "";
  let sawReasoning = false;
  const toolCallIds = new Set<string>();

  for (const p of parts) {
    if (p.type === "text") {
      // Bridge authoritative re-emit: the marked block replaces the advisory
      // deltas streamed so far (same rule build-stream applies) — the
      // subtitle must quote the authoritative answer, not the discarded draft.
      if (p.providerMetadata?.["previously-bridge"]?.authoritative === true) {
        rawText = "";
      }
      rawText += p.text ?? "";
    } else if (p.type === "reasoning") {
      sawReasoning = true;
    } else if (typeof p.type === "string" && p.type.startsWith("tool-")) {
      // Distinct-call counting: several parts share one toolCallId across the
      // call lifecycle and must not inflate the count.
      const id = p.toolCallId ?? p.type;
      toolCallIds.add(id);
    }
    // Everything else (data-*, phases, step boundaries, errors) carries no
    // spoken words — the subtitle stays silent about it by construction.
  }

  const collapsed = collapseSubtitleWhitespace(rawText);
  const { text, truncated } = truncateSubtitleText(collapsed);

  let status: SubtitleStatus | null = null;
  if (text.length === 0) {
    // Status ladder: pure reasoning reads as thinking; once tool calls have
    // started the turn is "reading" and the count replaces the vague label.
    if (toolCallIds.size > 0) {
      status = { kind: "reading", count: toolCallIds.size };
    } else if (sawReasoning) {
      status = { kind: "thinking" };
    }
  }

  return { speaker, text, truncated, status };
}

/** One message presented to the folder: its raw part stream plus the
 *  UIMessage role. History turns restored from a slice carry no AI SDK
 *  parts — their persisted markdown body is presented as one synthetic
 *  `text` part, so the fold quotes exactly the words on record. */
export interface SubtitleSource {
  parts: readonly AnyPart[];
  role: string;
}

/** The subtitle line for a whole conversation: the NEWEST message that HAS
 *  speakable text. Walks from the newest message backwards and returns the
 *  first fold whose text is non-empty, so a data-only or attachment-only
 *  newest message (tool chatter, a staged file, a synthetic wrapper) never
 *  blanks the strip while an older turn still has words on record.
 *
 *  Only when NOTHING in the list is speakable does the rule fall back to the
 *  newest message's own fold — which surfaces its `status` (an in-flight
 *  turn's thinking/reading prefix, per §4) or, for a truly silent stream,
 *  null. What is shown is always ONE message's own fold: the opening words
 *  themselves, never a paraphrase or a merge across messages. Pure and
 *  prefix-stable, like the single-message fold it delegates to. */
export function foldSubtitleLineLatest(
  messages: readonly SubtitleSource[],
): SubtitleLine | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const line = foldSubtitleLine(messages[i].parts, messages[i].role);
    if (line.text.length > 0) return line;
  }
  const newest = messages[messages.length - 1];
  return newest ? foldSubtitleLine(newest.parts, newest.role) : null;
}
