/**
 * Shared turn-parsing utilities used by both tool executors and the evolution
 * workflow steps. Pure functions — no I/O, no side effects.
 */
import { decodeImageAttachments, type ImageAttachmentSnapshot } from "@/lib/chat/image-attachments";

/** Parse "YYYY-MM-DD-HHMM" into path segments. Returns null unless the calendar date and time exist. */
export function parseSliceId(sliceId: string): { y: string; m: string; d: string; hm: string } | null {
  const parts = sliceId.split("-");
  if (parts.length !== 4) return null;
  const [y, m, d, hm] = parts;
  if (!/^\d{4}$/.test(y) || !/^\d{2}$/.test(m) || !/^\d{2}$/.test(d) || !/^\d{4}$/.test(hm)) {
    return null;
  }
  const year = Number(y);
  const month = Number(m);
  const day = Number(d);
  const hour = Number(hm.slice(0, 2));
  const minute = Number(hm.slice(2));
  if (month < 1 || month > 12 || hour > 23 || minute > 59) return null;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (day < 1 || day > days[month - 1]) return null;
  return { y, m, d, hm };
}

/** Parsed turn from a core.md slice file. */
export interface ParsedTurn {
  /** Ordinal position of this turn in the slice (0, 1, 2, …). Stable and
   *  serializable — used by `range: { type: "turns" }` index matching. */
  index: number;
  /** The raw turn ID from the header ("1", "2", or base64url "a3fk2w").
   *  Absent on legacy slices whose header had no ID. */
  turnId?: string;
  /** Nested-bubble target (v0.30 §3.4): on an agent turn, the user turnId it
   *  answers — from the optional ` [reply-to {id}]` header suffix. */
  replyTo?: string;
  header: string;   // "## Turn {id} — TIMESTAMP (role)"
  role: string;     // source role; unknown/tool roles must never default to user
  sourceRole?: string;
  attachments?: ImageAttachmentSnapshot[];
  boundary: "escaped_v1" | "legacy_header" | "ambiguous";
  content: string;   // turn body text
  timestamp: string; // ISO 8601
}

/** Regex for turn headers: "## Turn {id} — TIMESTAMP (role)".
 *  Matches both legacy numeric IDs ("1", "2") and new base64url IDs ("a3fk2w").
 *  Separator is em-dash (U+2014), consistent with manager.ts serializeSlice.
 *  An optional ` [reply-to {id}]` suffix (v0.30 §3.4, nested bubbles) is
 *  captured when present. Future bracketed metadata stays tolerated; prose
 *  after a header is not trusted structural metadata. */
export const TURN_HEADER_RE = /^## Turn ([A-Za-z0-9_-]{1,128}|\?) — (\S+) \(([A-Za-z][A-Za-z0-9_-]*)\)(?: \[reply-to ([A-Za-z0-9_-]+)\])?(?: \[[a-z][a-z0-9_-]*(?: [^\]\r\n]*)?\])*\r?$/;

/** Versioned escaping is only decoded when the actual header opts in. */
export function escapeTurnBody(content: string): string {
  return content.replace(/^(\\*)## Turn /gm, "\\$&");
}

function decodeTurnBody(header: string, content: string): string {
  return header.includes(" [body-escaped v1]")
    ? content.replace(/^\\(\\*## Turn )/gm, "$1")
    : content;
}

export function renderedTurnBody(turn: Pick<ParsedTurn, "header" | "content">): string {
  return turn.header.includes(" [body-escaped v1]") ? escapeTurnBody(turn.content) : turn.content;
}

function validTimestamp(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  return Boolean(match && parseSliceId(`${match[1]}-${match[2]}-${match[3]}-${match[4]}${match[5]}`)
    && Number(match[6]) < 60 && Number.isFinite(Date.parse(value)));
}

function isSerializedBoundary(turn: Pick<ParsedTurn, "boundary"> | null, line: string): boolean {
  return turn?.boundary === "escaped_v1" && line.includes(" [body-escaped v1]");
}

/**
 * Parse core.md content into frontmatter + array of parsed turns.
 * Frontmatter is everything before the first turn header.
 * `index` is the ORDINAL position (0-based), not the header ID — legacy
 * numeric IDs and base64url IDs both map to a stable ordinal, so index-based
 * range filtering works regardless of ID format.
 */
export function parseTurns(raw: string): { frontmatter: string; turns: ParsedTurn[] } {
  const lines = raw.split("\n");
  const turns: ParsedTurn[] = [];
  const frontmatterLines: string[] = [];
  let currentTurn: { turnId?: string; replyTo?: string; header: string; role: string; sourceRole?: string; attachments?: ImageAttachmentSnapshot[]; boundary: ParsedTurn["boundary"]; timestamp: string; contentLines: string[] } | null = null;
  let inFrontmatter = true;
  let turnOrdinal = 0;
  let yaml = lines[0]?.trim() === "---";
  let fence: { char: string; length: number; ambiguous: boolean } | null = null;

  for (const [lineIndex, line] of lines.entries()) {
    // A quoted transcript/code example is part of its enclosing speaker's
    // message, never a new speaker. Frontmatter is metadata, not speech either.
    const inYaml = yaml;
    if (yaml && lineIndex > 0 && /^(---|\.\.\.)\s*$/.test(line)) yaml = false;
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    const inFence = fence !== null;
    const ambiguousFence = fence?.ambiguous === true;
    if (marker && !inYaml) {
      if (fence) {
        if (marker[1][0] === fence.char && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
      } else if (marker[1][0] !== "`" || !marker[2].includes("`")) {
        let closed = false;
        for (let next = lineIndex + 1; next < lines.length; next += 1) {
          const boundary = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(lines[next]);
          if (!boundary || boundary[1][0] !== marker[1][0] || boundary[1].length < marker[1].length) continue;
          if (!boundary[2].trim()) { closed = true; break; }
          // An info-bearing fence inside a block is ordinary code content.
          // Balanced Markdown wins over guesses about damaged legacy turns;
          // only the versioned escaped format can disambiguate those bytes.
        }
        fence = { char: marker[1][0], length: marker[1].length, ambiguous: !closed };
      }
    }
    // New serialized turns cannot contain an unescaped boundary. Their real
    // next header also terminates a truncated/unclosed fence in that turn.
    const serializedBoundary = isSerializedBoundary(currentTurn, line);
    const candidateLine: boolean = !inYaml && (!inFence || ambiguousFence || serializedBoundary);
    const strictMatch: RegExpMatchArray | null = candidateLine ? line.match(TURN_HEADER_RE) : null;
    const match: RegExpMatchArray | null = strictMatch ?? (candidateLine ? /^## Turn (\S+) — (\S+) \(([^)]+)\).*\r?$/.exec(line) : null);
    if (match) {
      // In legacy text a header inside a fence might be an example OR the
      // next real turn after a truncated reply. Preserve the block as unknown
      // rather than trusting its claimed speaker or swallowing its body.
      const unambiguous: boolean = Boolean(strictMatch && validTimestamp(match[2]) && (!inFence || serializedBoundary));
      const attachments: ImageAttachmentSnapshot[] = unambiguous
        ? decodeImageAttachments(/ \[attachments ([^\]]*)\]/.exec(line)?.[1]) : [];
      if (currentTurn) {
        turns.push({
          index: turnOrdinal++,
          turnId: currentTurn.turnId,
          replyTo: currentTurn.replyTo,
          header: currentTurn.header,
          role: currentTurn.role,
          ...(currentTurn.sourceRole ? { sourceRole: currentTurn.sourceRole } : {}),
          ...(currentTurn.attachments?.length ? { attachments: currentTurn.attachments } : {}),
          boundary: currentTurn.boundary,
          timestamp: currentTurn.timestamp,
          content: decodeTurnBody(currentTurn.header, currentTurn.contentLines.join("\n").trimEnd()),
        });
      }
      currentTurn = {
        ...(strictMatch ? { turnId: match[1] } : {}),
        ...(strictMatch?.[4] ? { replyTo: strictMatch[4] } : {}),
        header: line,
        role: unambiguous ? match[3] : "unknown",
        ...(!unambiguous || / \[source-role ([^\]]*)\]/.test(line)
          ? { sourceRole: / \[source-role ([^\]]*)\]/.exec(line)?.[1] ?? match[3] } : {}),
        ...(attachments.length ? { attachments } : {}),
        boundary: !unambiguous ? "ambiguous" : line.includes(" [body-escaped v1]") ? "escaped_v1" : "legacy_header",
        timestamp: match[2],
        contentLines: [],
      };
      if (!inFence || serializedBoundary) fence = null;
      inFrontmatter = false;
    } else if (inFrontmatter) {
      frontmatterLines.push(line);
    } else if (currentTurn) {
      currentTurn.contentLines.push(line);
    }
  }
  // Don't forget the last turn
  if (currentTurn) {
    turns.push({
      index: turnOrdinal,
      turnId: currentTurn.turnId,
      replyTo: currentTurn.replyTo,
      header: currentTurn.header,
      role: currentTurn.role,
      ...(currentTurn.sourceRole ? { sourceRole: currentTurn.sourceRole } : {}),
      ...(currentTurn.attachments?.length ? { attachments: currentTurn.attachments } : {}),
      boundary: currentTurn.boundary,
      timestamp: currentTurn.timestamp,
      content: decodeTurnBody(currentTurn.header, currentTurn.contentLines.join("\n").trimEnd()),
    });
  }

  // A shared id for user + agent is intentional. Two headers claiming the
  // same id AND speaker are ambiguous, not two independent user confirmations.
  // Wall-clock order is not a gate: asynchronous replies can arrive out of order.
  const identities = new Map<string, ParsedTurn[]>();
  for (const turn of turns) {
    if (!turn.turnId || turn.turnId === "?") continue;
    const key = `${turn.turnId}:${turn.role === "assistant" ? "agent" : turn.role}`;
    identities.set(key, [...(identities.get(key) ?? []), turn]);
  }
  for (const duplicates of identities.values()) {
    if (duplicates.length < 2) continue;
    for (const turn of duplicates) {
      turn.sourceRole ??= turn.role;
      turn.role = "unknown";
      turn.boundary = "ambiguous";
      delete turn.attachments;
    }
  }
  return { frontmatter: frontmatterLines.join("\n").trimEnd(), turns };
}

/** Apply a range filter to parsed turns. Returns the filtered turns array. */
export function applyRange(
  turns: ParsedTurn[],
  range: { type: "turns" | "last" | "date"; indices?: number[]; count?: number; after?: string },
): ParsedTurn[] {
  switch (range.type) {
    case "turns": {
      if (!range.indices || range.indices.length === 0) return turns;
      const indexSet = new Set(range.indices);
      return turns.filter((t) => indexSet.has(t.index));
    }
    case "last": {
      const n = range.count ?? 3;
      return turns.slice(-n);
    }
    case "date": {
      if (!range.after) return turns;
      const afterMs = new Date(range.after).getTime();
      if (isNaN(afterMs)) return turns;
      return turns.filter((t) => new Date(t.timestamp).getTime() >= afterMs);
    }
    default:
      return turns;
  }
}

/** Reassemble filtered turns into markdown: frontmatter + selected turn headers & content. */
export function reassembleSlice(frontmatter: string, turns: ParsedTurn[]): string {
  const parts = [frontmatter];
  for (const t of turns) {
    parts.push(`\n${t.header}\n${renderedTurnBody(t)}`);
  }
  return parts.join("\n");
}
