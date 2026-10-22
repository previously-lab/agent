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
  /** The turn tail's narrowed beat: 序6 evolution拍 only (v0.38 §6). */
  finalize: (turnId: string) => `Turn ${turnId} — finalize`,
  /** The summary stream's ONE commit: the burst's whole 被动存盘
   *  (user turns + replies + cognitions + merge + seals + snapshot —
   *  v0.42 §2; `Turn {id} — user turn` / `Turn {id} — reply` retired with
   *  the per-turn writer). */
  summary: (sliceId: string) => `Summary — ${sliceId}`,
  /** The reflection unit's per-round commit — the cursor/log plane. */
  reflectionRound: (date: string) => `Reflection round — ${date}`,
  /** The question sub-stream's commit. */
  questionRun: (sliceId: string) => `Question run — ${sliceId}`,
  /** The field's immediate case write (主动写入 — lands the moment the tool
   *  call returns, one call one commit, v0.42 §2 [11279]). */
  writeCase: (ref: string) => `writeCase ${ref}`,
} as const;

/** The reader's filter: a commit is a reflection round's iff this prefix. */
export const REFLECTION_ROUND_PREFIX = "Reflection round — ";

/** The trailer section opens on a line that is exactly this marker. */
export const TRAILER_MARKER = "—";

// ─── The reflection round message: build ──────────────────────────────────

export interface ReflectionRoundTrailer {
  /**
   * Clean rounds only: the rounds' water level, PER SLICE — which turns of
   * which slices this round processed (v0.42 — the work unit is a TURN).
   * One mark per scoped slice, emitted in scope order; `turnIds` ABSENT
   * means the WHOLE slice (the old `seen: <sliceId>` format — parsed as
   * such for backward compatibility).
   */
  seen?: SeenMark[];
  /** Rounds that truly ran the evolution拍 (changed or not). */
  evolved?: { date: string };
  /** Superseded rounds — mutually exclusive with `seen`. */
  superseded?: boolean;
  /** Exact summary versions this round read, including late material on old turns. */
  observed?: Array<{ sha: string; sliceId: string; turnIds: string[] }>;
  /** Complete ancestor prefix plus the material still owed at that prefix. */
  history?: ReflectionHistoryCheckpoint;
}

export interface ReflectionHistoryCheckpoint {
  version: 1;
  basis: string;
  cursor: string | null;
  evolved: string | null;
  pending: Array<{ sha: string; sliceId: string; turnIds: string[] }>;
  latestNote?: { note: string; at: string };
}

/** Unknown or damaged checkpoints never mean 'nothing left to do'. */
function parseHistoryCheckpoint(value: string): ReflectionHistoryCheckpoint | null {
  try {
    const c = JSON.parse(value) as ReflectionHistoryCheckpoint;
    const slice = (s: unknown) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}-\d{4}$/.test(s);
    const sha = (s: unknown) => typeof s === "string" && /^[a-f0-9]{40,64}$/.test(s);
    if (c.version !== 1 || !sha(c.basis) || (c.cursor !== null && !slice(c.cursor)) ||
      (c.evolved !== null && (typeof c.evolved !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(c.evolved))) ||
      !Array.isArray(c.pending) || c.pending.some(m => !sha(m.sha) || !slice(m.sliceId) || !Array.isArray(m.turnIds) ||
        m.turnIds.length === 0 || m.turnIds.some(t => typeof t !== "string" || !/^\S+$/.test(t)))) return null;
    if (c.latestNote !== undefined && (!c.latestNote || typeof c.latestNote.note !== "string" || typeof c.latestNote.at !== "string")) return null;
    return c;
  } catch { return null; }
}

/**
 * One slice's processed-turns mark. `turnIds` undefined = the whole slice
 * (old format); present = exactly those turns.
 */
export interface SeenMark {
  sliceId: string;
  turnIds?: string[];
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
  const t = input.trailer ?? {};
  // A note may quote complete examples of the log protocol. Always terminate
  // such a body with our own delimiter, even when the trusted trailer is
  // empty, so a failed round cannot manufacture progress from quoted prose.
  const quotedDelimiter = note?.split("\n").some(line => line.trim() === TRAILER_MARKER);
  if (t.seen || t.evolved || t.superseded || t.history || t.observed || quotedDelimiter) {
    lines.push("", TRAILER_MARKER);
    // v0.42 — the water level is TURN-level: one line per scoped slice, the
    // turn ids after `#` (old readers see a line they cannot split and
    // degrade to "water level unknown", never to "all covered").
    for (const mark of t.seen ?? []) {
      lines.push(
        `seen: ${mark.sliceId}${mark.turnIds?.length ? `#${mark.turnIds.join(",")}` : ""}`,
      );
    }
    if (t.evolved) lines.push(`evolved: ${t.evolved.date}`);
    if (t.superseded) lines.push("superseded: true");
    if (t.observed !== undefined) {
      lines.push("observed: v1");
      for (const m of t.observed) lines.push(`observed: ${m.sha} ${m.sliceId}#${m.turnIds.join(",")}`);
    }
    if (t.history) lines.push(`history: ${JSON.stringify(t.history)}`);
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

  // The writer appends the authoritative delimiter AFTER the entire note.
  // Earlier delimiters (including one at the note's end) belong to the note.
  let markerIdx = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim() === TRAILER_MARKER) {
      markerIdx = i;
    }
  }
  const noteLines = markerIdx >= 0 ? lines.slice(0, markerIdx) : lines;
  const note = noteLines.join("\n").trim() || null;

  const seenMarks: SeenMark[] = [];
  let trailer: ReflectionRoundTrailer | null = null;
  if (markerIdx >= 0) {
    for (const line of lines.slice(markerIdx + 1)) {
      // v0.42 — `seen: <sliceId>#<turnId>,<turnId>` (turn-level water level)
      // or the OLD `seen: <sliceId>` (whole slice covered). Malformed seen
      // lines are SKIPPED: an unparseable water level degrades to UNKNOWN
      // (nothing covered), never to "all processed".
      const m = /^seen: (\S+?)(?:#(\S+))?$/.exec(line.trim());
      if (m) {
        if (!/^\d{4}-\d{2}-\d{2}-\d{4}$/.test(m[1])) continue;
        let turnIds: string[] | undefined;
        if (m[2] !== undefined) {
          const ids = m[2]
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
          if (ids.length === 0) continue; // "seen: X#" — malformed, unknown
          turnIds = ids;
        }
        seenMarks.push({ sliceId: m[1], ...(turnIds ? { turnIds } : {}) });
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
      if (line.trim() === "observed: v1") trailer = { ...(trailer ?? {}), observed: trailer?.observed ?? [] };
      const receipt = /^observed: ([a-f0-9]{40,64}) (\d{4}-\d{2}-\d{2}-\d{4})#(\S+)$/.exec(line.trim());
      if (receipt) {
        trailer = { ...(trailer ?? {}), observed: [...(trailer?.observed ?? []), { sha: receipt[1], sliceId: receipt[2], turnIds: receipt[3].split(",") }] };
      }
      if (line.trim().startsWith("history: ")) {
        const history = parseHistoryCheckpoint(line.trim().slice("history: ".length));
        if (history) trailer = { ...(trailer ?? {}), history };
      }
      // unknown trailer lines: tolerated, ignored
    }
  }
  if (seenMarks.length > 0) {
    trailer = { ...(trailer ?? {}), seen: seenMarks };
  }
  return { date, note, trailer };
}
