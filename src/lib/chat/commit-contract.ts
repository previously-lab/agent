/**
 * The commit-message prefix contract (v0.39 §2.3/§2.5, 待裁决 5 — 采纳) —
 * the ONLY module that knows how commit messages are shaped. Both writers
 * (tool-executors / steps / hq-agent / background-steps) and readers
 * (the cursor/note log readers, the status route's log layer) build and
 * parse through here; the prefixes are FROZEN — a new prefix registers here
 * and nowhere else.
 *
 * The reflection round's message doubles as the cursor carrier: a
 * structured trailer rides the SAME commit as the round's writes (写入与
 * 水位同生同死). A clean round carries `seen:`; a round that truly ran the
 * evolution拍 carries `evolved:`; a superseded round carries `superseded:`
 * and NO `seen` (互斥); a FAILED round's commit (when it has writes) carries
 * NO trailer section at all — "不推游标" is the absence of a line, not a
 * flag (§2.6).
 *
 * Pure — no I/O, safe everywhere (workflow sandbox included).
 */

// ─── The frozen prefixes ──────────────────────────────────────────────────

export const COMMIT_PREFIX = {
  /** The turn's ENTRY beat: user turn + slice bookkeeping (housekeeping). */
  userTurn: (turnId: string) => `Turn ${turnId} — user turn`,
  /** The turn tail's narrowed beat: 序6 evolution拍 only (v0.38 §6). */
  finalize: (turnId: string) => `Turn ${turnId} — finalize`,
  /** The writer's one commit: reply + merge + cognition + snapshot. */
  reply: (turnId: string) => `Turn ${turnId} — reply`,
  /** The reflection unit's per-round commit — the cursor/log plane. */
  reflectionRound: (date: string) => `Reflection round — ${date}`,
  /** The question sub-stream's commit. */
  questionRun: (sliceId: string) => `Question run — ${sliceId}`,
  /** The field's immediate case write. */
  writeCase: (ref: string) => `writeCase ${ref}`,
} as const;

/** The reader's filter: a commit is a reflection round's iff this prefix. */
export const REFLECTION_ROUND_PREFIX = "Reflection round — ";

/** The trailer section opens on a line that is exactly this marker. */
export const TRAILER_MARKER = "—";

// ─── The reflection round message: build ──────────────────────────────────

export interface ReflectionRoundTrailer {
  /** Clean rounds only: the scope's furthest sealed slice — the water level. */
  seen?: { sliceId: string };
  /** Rounds that truly ran the evolution拍 (changed or not). */
  evolved?: { date: string };
  /** Superseded rounds — mutually exclusive with `seen`. */
  superseded?: boolean;
}

/**
 * Build the round's commit message: prefix line, the optional note (a
 * substantive round's one-line account), then the trailer section. A FAILED
 * round passes no trailer — its commit (when it has writes) lands without
 * the section, which is exactly "the water level does not advance".
 */
export function buildReflectionRoundMessage(input: {
  date: string;
  note?: string | undefined;
  trailer?: ReflectionRoundTrailer | undefined;
}): string {
  const note = input.note?.trim();
  const lines: string[] = [COMMIT_PREFIX.reflectionRound(input.date)];
  if (note) {
    lines.push("", note);
  }
  const t = input.trailer;
  if (t && (t.seen || t.evolved || t.superseded)) {
    lines.push("", TRAILER_MARKER);
    if (t.seen) lines.push(`seen: ${t.seen.sliceId}`);
    if (t.evolved) lines.push(`evolved: ${t.evolved.date}`);
    if (t.superseded) lines.push("superseded: true");
  }
  return lines.join("\n");
}

// ─── The reflection round message: parse ──────────────────────────────────

export interface ParsedReflectionRound {
  /** The docket's user-clock date from the prefix line. */
  date: string;
  /** The note paragraph (between the prefix and the trailer), or null. */
  note: string | null;
  /** The trailer section — null when the commit carries none (failed round). */
  trailer: ReflectionRoundTrailer | null;
}

/**
 * Parse a reflection round commit message back (the readers' side of the
 * contract). Returns null when the message is not a reflection round's —
 * the caller filters. The trailer section is whatever follows the marker
 * line; keys are read line by line and UNKNOWN KEYS ARE IGNORED (forward
 * tolerance — a newer writer may add trailer lines this reader doesn't know).
 */
export function parseReflectionRoundMessage(
  message: string,
): ParsedReflectionRound | null {
  if (!message.startsWith(REFLECTION_ROUND_PREFIX)) return null;
  const date = message.slice(REFLECTION_ROUND_PREFIX.length).split("\n", 1)[0]?.trim() ?? "";
  const body = message.slice(REFLECTION_ROUND_PREFIX.length + date.length).replace(/^\r?\n/, "");
  const lines = body.split("\n");

  // The trailer section starts at the first line that is exactly the marker.
  let markerIdx = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim() === TRAILER_MARKER) {
      markerIdx = i;
      break;
    }
  }
  const noteLines = markerIdx >= 0 ? lines.slice(0, markerIdx) : lines;
  const note = noteLines.join("\n").trim() || null;

  let trailer: ReflectionRoundTrailer | null = null;
  if (markerIdx >= 0) {
    for (const line of lines.slice(markerIdx + 1)) {
      const m = /^seen: (\S+)$/.exec(line.trim());
      if (m) {
        trailer = { ...(trailer ?? {}), seen: { sliceId: m[1] } };
        continue;
      }
      const e = /^evolved: (\S+)$/.exec(line.trim());
      if (e) {
        trailer = { ...(trailer ?? {}), evolved: { date: e[1] } };
        continue;
      }
      if (line.trim() === "superseded: true") {
        trailer = { ...(trailer ?? {}), superseded: true };
      }
      // unknown trailer lines: tolerated, ignored
    }
  }
  return { date, note, trailer };
}
