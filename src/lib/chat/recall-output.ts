/**
 * Parsers for the memory-read verbs' FIXED result wording
 * (src/lib/memory/facade.ts renderRecallResult / renderRecallReadResult).
 *
 * The tool outputs reaching the UI are plain strings whose sentences are
 * FROZEN — the renderer classifies a result by matching those templates,
 * never by guessing. Anything that matches nothing falls through to
 * `unknown` and is rendered verbatim, so a wording change degrades to the
 * raw view instead of a wrong state.
 */

export interface ParsedEntry {
  /** YYYY-MM-DD, or undefined when the entry is undated. */
  date?: string;
  title: string;
  /** Summary or hit snippet — empty string when the entry carries none. */
  excerpt: string;
  ref: string;
}

export type RecallPageNote =
  | {
      /** "Showing {n} from offset {o} — pass offset={next} for older ones." */
      kind: "offset";
      shown: number;
      offset: number;
      nextOffset: number;
    }
  | {
      /** "Showing the newest {l} of {s} scanned — …" */
      kind: "capped";
      shown: number;
      scanned: number;
    };

export type ParsedRecallOutput =
  | {
      /** A hit page: recent-N or search matches, optionally with a paging note. */
      kind: "entries";
      /** The search query (search verb only). */
      query?: string;
      /** The scope name from the head line ("memory" when cross-category). */
      scope?: string;
      entries: ParsedEntry[];
      note?: RecallPageNote;
      /** Present when a near-name matched — the stored name differs. */
      matchedName?: string;
    }
  | {
      /** Keyword miss on a non-empty scope — the entries are a FALLBACK, not hits. */
      kind: "fallback";
      query: string;
      entries: ParsedEntry[];
    }
  | {
      /** "There is nothing here yet" — an empty scope, not a miss. */
      kind: "empty";
      scope?: string;
    }
  | {
      /** Named lookup miss — carries the closest matches, never "absent". */
      kind: "notFound";
      name: string;
      scope?: string;
      nearMisses: string[];
    }
  | {
      /** An offset past the end — an empty page, explicitly NOT absence. */
      kind: "pastEnd";
      offset: number;
      total: number;
    }
  | {
      /** A read failure — explicitly NOT absence. */
      kind: "readFailure";
      note: string;
    }
  | {
      /** Raw recallRead content (the document body). */
      kind: "content";
      text: string;
      /** Present when a near-name matched — the banner names the stored ref. */
      nearName?: string;
    }
  | {
      /** recallRead outline: the heading skeleton, never the body. */
      kind: "outline";
      ref: string;
      totalLines: number;
      headings: { level: number; title: string; from: number; to: number }[];
    }
  | {
      /** recallSince diff: refs with their change letter, newest first. */
      kind: "changes";
      since: string;
      until: string;
      commits: number;
      entries: ParsedChangeEntry[];
      /** True when the backend truncated the scan — a partial truth. */
      incomplete: boolean;
      /** Present when the entry page was capped — the sha to continue from. */
      cursorNote?: string;
    }
  | {
      /** Unrecognized wording — render verbatim. */
      kind: "unknown";
      text: string;
    };

/** One changed entry line of a recallSince result. */
export interface ParsedChangeEntry {
  change: "added" | "modified" | "removed";
  ref: string;
  /** YYYY-MM-DD of the newest touch, undefined when undated. */
  at?: string;
}

const RE_UNAVAILABLE =
  /^This could not be read right now \(([\s\S]*?)\)\. That is a read failure, not absence — it may still exist\.$/;
const RE_EMPTY =
  /^There is nothing here yet — no (.+?) entries exist in this scope\.$/;
const RE_NAMED_MISS_NEAR =
  /^Nothing named "(.+?)" exists in (.+?)\. Closest matches: ([\s\S]+)\.$/;
const RE_NAMED_MISS_PLAIN =
  /^Nothing named "(.+?)" exists in (.+?) — and nothing similar\.$/;
const RE_READ_MISS = /^Nothing named "(.+?)" exists in memory — and nothing similar\.$/;
const RE_PAST_END =
  /^No more entries — offset (\d+) is past the end; only (\d+) exist in this scope, newest first\.$/;
const RE_FALLBACK_HEAD =
  /^Nothing matches "(.*)"\. Here are the (\d+) most recent entries instead:$/;
const RE_RECENT_HEAD = /^The (\d+) most recent (.+) entries:$/;
const RE_SEARCH_HEAD = /^(\d+) match\(es\) for "(.*)":$/;
const RE_ENTRY_LINE = /^- \[([^\]]*)\] ([\s\S]*?) \(ref: (.+)\)$/;
const RE_NOTE_OFFSET =
  /^Showing (\d+) from offset (\d+) — pass offset=(\d+) for older ones\.$/;
const RE_NOTE_CAPPED =
  /^Showing the newest (\d+) of (\d+) scanned — narrow by date or add keywords for the older ones\.$/;
const RE_OUTLINE_HEAD =
  /^Outline of (.+?) \((\d+) lines\) — pick a span, then read it with range: "lines:a-b":$/;
const RE_OUTLINE_HEADING = /^(\s*)L(\d+)-(\d+)  (\S[\s\S]*)$/;
const RE_OUTLINE_EMPTY =
  /^Outline of (.+?): no heading skeleton — this document has no headings\. Read it directly with range: "lines:a-b" \(it has (\d+) lines\)\.$/;
const RE_READ_MISS_NEAR =
  /^Nothing named "(.+?)" exists in memory\. Closest matches: ([\s\S]+)\.$/;
const RE_MATCHED_NAME_NOTE =
  /^\(matched the near-name "(.+?)" — that is the stored name\)$/;
const RE_CONTENT_NEAR_NAME =
  /^\(matched the near-name "(.+?)" — read it under that stored name\)\n\n/;
const RE_CHANGES_HEAD =
  /^Changes since (\d{4}-\d{2}-\d{2}) through (\d{4}-\d{2}-\d{2}) \((\d+) commits\):$/;
const RE_CHANGES_LINE = /^- \[([^\]]*)\] ([+~−]) (\S[\s\S]*?) — (added|modified|removed)$/;
const RE_CHANGES_EMPTY =
  /^No changes since (\d{4}-\d{2}-\d{2}) through (\d{4}-\d{2}-\d{2}) — the commit history shows nothing in this window\.$/;
const RE_CHANGES_CURSOR =
  /^Showing the newest (\d+) of (\d+) changed entries — pass cursor=(\S+) for older ones\.$/;
const RE_CHANGES_INCOMPLETE =
  /^This result is INCOMPLETE — the commit history scan was truncated; more changes may exist beyond those shown\.$/;

function parseEntryLine(line: string): ParsedEntry | null {
  const m = RE_ENTRY_LINE.exec(line);
  if (!m) return null;
  const [, rawDate, body, ref] = m;
  const date = rawDate && rawDate !== "undated" ? rawDate : undefined;
  // Title first, excerpt after the FIRST " — ": titles rarely carry a spaced
  // em-dash; excerpts may, and the split only costs the tail of the excerpt.
  const splitAt = body.indexOf(" — ");
  const title = splitAt >= 0 ? body.slice(0, splitAt) : body;
  const excerpt = splitAt >= 0 ? body.slice(splitAt + 3) : "";
  return { date, title, excerpt, ref };
}

/**
 * Split a result body (after the head line) into parsed entries plus at
 * most one paging note. Unrecognized lines are dropped.
 */
function parseEntryBody(lines: string[]): {
  entries: ParsedEntry[];
  note?: RecallPageNote;
  matchedName?: string;
} {
  const entries: ParsedEntry[] = [];
  let note: RecallPageNote | undefined;
  let matchedName: string | undefined;
  for (const line of lines) {
    const trimmed = line.trimEnd();
    if (!trimmed) continue;
    const entry = parseEntryLine(trimmed);
    if (entry) {
      entries.push(entry);
      continue;
    }
    const matched = RE_MATCHED_NAME_NOTE.exec(trimmed);
    if (matched) {
      matchedName = matched[1];
      continue;
    }
    const offset = RE_NOTE_OFFSET.exec(trimmed);
    if (offset) {
      note = {
        kind: "offset",
        shown: Number(offset[1]),
        offset: Number(offset[2]),
        nextOffset: Number(offset[3]),
      };
      continue;
    }
    const capped = RE_NOTE_CAPPED.exec(trimmed);
    if (capped) {
      note = { kind: "capped", shown: Number(capped[1]), scanned: Number(capped[2]) };
    }
  }
  return { entries, note, matchedName };
}

/**
 * Classify a recall verb's string output. `toolName` selects the fallback:
 * anything unrecognized is `content` for recallRead (its happy path is a raw
 * document body) and `unknown` for the list verbs.
 */
export function parseRecallOutput(
  toolName: string,
  output: unknown,
): ParsedRecallOutput | null {
  if (typeof output !== "string" || output.length === 0) return null;
  const text = output;

  const unavailable = RE_UNAVAILABLE.exec(text);
  if (unavailable) return { kind: "readFailure", note: unavailable[1] };

  // recallSince — the changes plane (its head/empty/incomplete wording is its
  // own fixed template; parse before the generic list-verb fallthrough).
  if (toolName === "recallSince") {
    const emptyChanges = RE_CHANGES_EMPTY.exec(text);
    if (emptyChanges) {
      return {
        kind: "changes",
        since: emptyChanges[1]!,
        until: emptyChanges[2]!,
        commits: 0,
        entries: [],
        incomplete: false,
      };
    }
    const lines = text.split("\n");
    const head = RE_CHANGES_HEAD.exec(lines[0] ?? "");
    if (head) {
      const entries: ParsedChangeEntry[] = [];
      let incomplete = false;
      let cursorNote: string | undefined;
      for (const raw of lines.slice(1)) {
        const line = raw.trimEnd();
        if (!line) continue;
        const entry = RE_CHANGES_LINE.exec(line);
        if (entry) {
          entries.push({
            at: entry[1] !== "undated" ? entry[1] : undefined,
            change: entry[4] as ParsedChangeEntry["change"],
            ref: entry[3]!,
          });
          continue;
        }
        if (RE_CHANGES_INCOMPLETE.test(line)) {
          incomplete = true;
          continue;
        }
        const cursor = RE_CHANGES_CURSOR.exec(line);
        if (cursor) cursorNote = cursor[3];
      }
      return {
        kind: "changes",
        since: head[1]!,
        until: head[2]!,
        commits: Number(head[3]),
        entries,
        incomplete,
        ...(cursorNote ? { cursorNote } : {}),
      };
    }
  }

  const readMiss = RE_READ_MISS.exec(text);
  if (readMiss && toolName === "recallRead") {
    return { kind: "notFound", name: readMiss[1], nearMisses: [] };
  }
  const readMissNear = RE_READ_MISS_NEAR.exec(text);
  if (readMissNear && toolName === "recallRead") {
    return {
      kind: "notFound",
      name: readMissNear[1],
      nearMisses: readMissNear[2].split(",").map((s) => s.trim()).filter(Boolean),
    };
  }

  // recallRead outline — the heading skeleton (fixed template, parse before
  // the content fallback so outline text never reads as document prose).
  if (toolName === "recallRead") {
    const outlineEmpty = RE_OUTLINE_EMPTY.exec(text);
    if (outlineEmpty) {
      return {
        kind: "outline",
        ref: outlineEmpty[1]!,
        totalLines: Number(outlineEmpty[2]),
        headings: [],
      };
    }
    const outlineHead = RE_OUTLINE_HEAD.exec(text);
    if (outlineHead) {
      const headings: { level: number; title: string; from: number; to: number }[] = [];
      for (const line of text.split("\n").slice(1)) {
        const m = RE_OUTLINE_HEADING.exec(line);
        if (!m) continue;
        headings.push({
          level: Math.floor(m[1]!.length / 2) + 1,
          from: Number(m[2]),
          to: Number(m[3]),
          title: m[4]!,
        });
      }
      return {
        kind: "outline",
        ref: outlineHead[1]!,
        totalLines: Number(outlineHead[2]),
        headings,
      };
    }
  }

  if (toolName === "recallRead") {
    const near = RE_CONTENT_NEAR_NAME.exec(text);
    if (near) {
      return { kind: "content", text: text.slice(near[0].length), nearName: near[1] };
    }
    return { kind: "content", text };
  }

  const empty = RE_EMPTY.exec(text);
  if (empty) return { kind: "empty", scope: empty[1] };

  const pastEnd = RE_PAST_END.exec(text);
  if (pastEnd) return { kind: "pastEnd", offset: Number(pastEnd[1]), total: Number(pastEnd[2]) };

  const namedNear = RE_NAMED_MISS_NEAR.exec(text);
  if (namedNear) {
    return {
      kind: "notFound",
      name: namedNear[1],
      scope: namedNear[2],
      nearMisses: namedNear[3].split(",").map((s) => s.trim()).filter(Boolean),
    };
  }
  const namedPlain = RE_NAMED_MISS_PLAIN.exec(text);
  if (namedPlain) {
    return { kind: "notFound", name: namedPlain[1], scope: namedPlain[2], nearMisses: [] };
  }

  const lines = text.split("\n");
  const fallbackHead = RE_FALLBACK_HEAD.exec(lines[0] ?? "");
  if (fallbackHead) {
    const { entries } = parseEntryBody(lines.slice(1));
    return { kind: "fallback", query: fallbackHead[1], entries };
  }

  const recentHead = RE_RECENT_HEAD.exec(lines[0] ?? "");
  if (recentHead) {
    const { entries, note, matchedName } = parseEntryBody(lines.slice(1));
    return {
      kind: "entries",
      scope: recentHead[2],
      entries,
      ...(note ? { note } : {}),
      ...(matchedName ? { matchedName } : {}),
    };
  }

  const searchHead = RE_SEARCH_HEAD.exec(lines[0] ?? "");
  if (searchHead) {
    const { entries, note, matchedName } = parseEntryBody(lines.slice(1));
    return {
      kind: "entries",
      query: searchHead[2],
      entries,
      ...(note ? { note } : {}),
      ...(matchedName ? { matchedName } : {}),
    };
  }

  return { kind: "unknown", text };
}

// ─── writeCase result ─────────────────────────────────────────────────────

export type WriteCaseStatus =
  | {
      /** The call is in flight — its write rides this turn's commit. */
      kind: "queued";
    }
  | {
      /** The call returned ok — the write is committed (path included). */
      kind: "committed";
      action: string;
      path: string;
    }
  | {
      /** The call refused the write — the reason is the server's own words. */
      kind: "refused";
      reason: string;
    }
  | {
      /** Output shape unrecognized — render verbatim. */
      kind: "unknown";
      raw: string;
    };

/**
 * Derive a writeCase card's status from the tool part state + output. The
 * executor returns `{ ok, action?, path?, reason? }`; a success output means
 * the batch was flushed before the call returned (one call, one commit), so
 * "queued" exists only while the call is running.
 */
export function deriveWriteCaseStatus(
  running: boolean,
  output: unknown,
): WriteCaseStatus {
  if (output == null) {
    return running ? { kind: "queued" } : { kind: "unknown", raw: "" };
  }
  if (typeof output === "string") {
    try {
      return deriveWriteCaseStatus(running, JSON.parse(output));
    } catch {
      return { kind: "unknown", raw: output };
    }
  }
  if (typeof output !== "object") return { kind: "unknown", raw: String(output) };
  const obj = output as Record<string, unknown>;
  if (obj.ok === true) {
    const action = typeof obj.action === "string" ? obj.action : "open";
    const path = typeof obj.path === "string" ? obj.path : "";
    return { kind: "committed", action, path };
  }
  if (obj.ok === false) {
    const reason = typeof obj.reason === "string" ? obj.reason : "";
    return { kind: "refused", reason };
  }
  return { kind: "unknown", raw: JSON.stringify(output) };
}
