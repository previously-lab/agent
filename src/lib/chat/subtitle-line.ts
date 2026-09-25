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
  /** The line's plain text — collapsed, markdown markers stripped, and
   *  truncated to the two-line budget. Byte-identical to what the strip has
   *  always produced for plain input; the accessible name reads it. Joining
   *  `runs`' text reproduces it exactly. */
  text: string;
  /** The same kept prefix as `text`, split into styled runs (strong / em /
   *  code / plain) for the panel to paint. Empty when `text` is empty. A run
   *  straddling the truncation cut is split, never re-parsed — re-parsing a
   *  truncated string is what would cut a `**` pair in half. */
  runs: SubtitleRun[];
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

/** One styled segment of the subtitle body — the pill renders a tiny INLINE
 *  markdown subset (strong / emphasis / inline code) and nothing else; a
 *  two-line, 11px spoken line has no use for headings, lists, blockquotes or
 *  link targets. `null` emphasis is plain speech. */
export type SubtitleEmphasis = "strong" | "em" | "code";

export interface SubtitleRun {
  /** The run's words — never contains the marker characters of its own
   *  construct, so a marker can never leak into the painted line. */
  text: string;
  /** Which inline style the panel paints the run with; null = plain. */
  emphasis: SubtitleEmphasis | null;
}

/**
 * Parses the stripped plain line into styled runs, so the subtitle can carry
 * the message's own emphasis (observed live — the pill once rendered a raw
 * `**你换房间了**`) without ever painting a marker. Markers out, words kept:
 *
 *  - `**bold**` / `__bold__`  → strong run (`__` only at a word boundary, so
 *    `snake_case` survives untouched)
 *  - `*em*` / `_em_`          → em run (`_` boundary-guarded the same way,
 *    content may not start with whitespace)
 *  - `` `code` ``             → code run (backtick runs of any length pair;
 *    the ticks themselves are dropped)
 *  - `[label](target)`        → the label, as plain runs; the target speaks
 *    nothing
 *  - `![alt](src)`            → nothing at all — images speak nothing
 *  - line-leading furniture (`# ` headings, `> ` quotes, `- `/`1. ` bullets)
 *    → dropped; the fold collapses newlines before parsing, so "line-leading"
 *    reduces to the string's first characters
 *
 * An UNCLOSED marker degrades to plain text one character at a time — the
 * marker characters are emitted as plain speech, never as an open emphasis —
 * and a run's content classes exclude its own marker, so a stray marker can
 * never appear inside a styled run. Single left-to-right pass, pure and
 * deterministic; constructs are not re-parsed inside link labels or code
 * content (nested markdown is outside the spoken-line subset). Joining the
 * runs' `text` reproduces exactly what `stripSubtitleMarkdown` returns.
 */
export function parseSubtitleRuns(text: string): SubtitleRun[] {
  const runs: SubtitleRun[] = [];
  let plain = "";
  let i = 0;

  const push = (runText: string, emphasis: SubtitleEmphasis | null) => {
    if (!runText) return;
    const last = runs[runs.length - 1];
    if (last && last.emphasis === emphasis) {
      last.text += runText;
      return;
    }
    runs.push({ text: runText, emphasis });
  };
  const flushPlain = () => {
    if (plain) {
      push(plain, null);
      plain = "";
    }
  };
  // The underscore constructs are boundary-guarded (`(^|[^\w])` in the old
  // strip): inside a word a `_` is part of the identifier, not a marker.
  const leftBoundary = (idx: number) =>
    idx === 0 || !/[\w]/.test(text.charAt(idx - 1));

  // Line-leading furniture only exists at the string's head: the fold runs
  // collapseSubtitleWhitespace first, so there are no interior line starts.
  if (i === 0) {
    const furniture = /^\s{0,3}(?:#{1,6}\s+|>\s?|(?:[-*+]|\d{1,2}\.)\s+)/.exec(
      text,
    );
    if (furniture) i = furniture[0].length;
  }

  while (i < text.length) {
    const rest = text.slice(i);

    // Images speak nothing — consume without emitting.
    let match = /^!\[[^\]]*\]\([^)]*\)/.exec(rest);
    if (match) {
      i += match[0].length;
      continue;
    }
    // Links keep their label (as plain runs) and drop the target.
    match = /^\[([^\]]*)\]\([^)]*\)/.exec(rest);
    if (match) {
      plain += match[1];
      i += match[0].length;
      continue;
    }
    // Inline code: a backtick run, content up to the next backtick run, then
    // the closing run. The ticks are dropped, the code kept.
    if (rest.charAt(0) === "`") {
      const open = /^`+/.exec(rest)![0];
      const after = rest.slice(open.length);
      const closeAt = after.search("`");
      if (closeAt !== -1) {
        const close = /^`+/.exec(after.slice(closeAt))![0];
        flushPlain();
        push(after.slice(0, closeAt), "code");
        i += open.length + closeAt + close.length;
        continue;
      }
      // Unclosed: the backtick is speech, not a marker.
      plain += "`";
      i += 1;
      continue;
    }
    // Strong `**…**` (content may hold single characters, just not `*`).
    if (rest.startsWith("**")) {
      const closeAt = rest.indexOf("**", 2);
      if (closeAt > 2) {
        flushPlain();
        push(rest.slice(2, closeAt), "strong");
        i += closeAt + 2;
        continue;
      }
      // Unclosed: emit one star as plain and rescan from the next character.
      plain += "*";
      i += 1;
      continue;
    }
    // Strong `__…__` at a word boundary.
    if (rest.startsWith("__") && leftBoundary(i)) {
      match = /^__([^_]+)__(?=[^\w]|$)/.exec(rest);
      if (match) {
        flushPlain();
        push(match[1], "strong");
        i += match[0].length;
        continue;
      }
    }
    // Em `*…*` — content must not start with whitespace or `*`.
    match = /^\*([^*\s][^*]*)\*/.exec(rest);
    if (match) {
      flushPlain();
      push(match[1], "em");
      i += match[0].length;
      continue;
    }
    // Em `_…_` at a word boundary, same content rules.
    if (rest.charAt(0) === "_" && leftBoundary(i)) {
      match = /^_([^_\s][^_]*)_(?=[^\w]|$)/.exec(rest);
      if (match) {
        flushPlain();
        push(match[1], "em");
        i += match[0].length;
        continue;
      }
    }
    // Anything else is plain speech, one character at a time.
    plain += rest.charAt(0);
    i += 1;
  }
  flushPlain();
  return runs;
}

/**
 * The subtitle's plain line: the runs' text joined. Kept as the single
 * consumer-facing "markers out, words kept" helper (the fold uses
 * `parseSubtitleRuns` directly so it never has to re-parse a truncated
 * string).
 */
export function stripSubtitleMarkdown(text: string): string {
  return parseSubtitleRuns(text)
    .map((run) => run.text)
    .join("");
}

/** Keeps the prefix of `runs` that covers exactly `keptChars` characters —
 *  the kept prefix of the plain line after `truncateSubtitleText`. A run that
 *  straddles the cut is SPLIT (its head keeps the run's emphasis), so
 *  joining the result reproduces the truncated plain text byte-for-byte.
 *  Truncating RUNS — never re-parsing a truncated string — is what keeps a
 *  `**` pair from being cut in half and leaking a marker. */
function takeRunPrefix(
  runs: readonly SubtitleRun[],
  keptChars: number,
): SubtitleRun[] {
  const kept: SubtitleRun[] = [];
  let used = 0;
  for (const run of runs) {
    if (used >= keptChars) break;
    if (used + run.text.length <= keptChars) {
      kept.push(run);
      used += run.text.length;
      continue;
    }
    kept.push({ text: run.text.slice(0, keptChars - used), emphasis: run.emphasis });
    used = keptChars;
  }
  return kept;
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
  // Parse BEFORE truncating and keep the runs as the truncation unit: the
  // plain text and the runs are two views of the same kept prefix, so the
  // panel can paint emphasis without a marker ever surviving the cut.
  const allRuns = parseSubtitleRuns(collapsed);
  const plain = allRuns
    .map((run) => run.text)
    .join("");
  const { text, truncated } = truncateSubtitleText(plain);
  const runs = takeRunPrefix(allRuns, text.length);

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

  return { speaker, text, runs, truncated, status };
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
