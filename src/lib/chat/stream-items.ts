/**
 * The unified message stream's data model (v0.10 design §1.5) — pure, no React.
 *
 * The Virtuoso list renders one flat item array, oldest → newest:
 *
 *   [seam?] turn turn … [seam?] turn … [seam?] [resume-banner?] turn … live…
 *   └──────── historical slice blocks (one seam header + flat turns) ───────┘
 *
 * A seam item sits BETWEEN two slice blocks and is classified from the OLDER
 * slice's `closedBy` (see seam.ts). The resume block (§2 — the still-alive
 * newest slice restored on arrival) is appended after the historical blocks,
 * preceded by a real seam when history precedes it. In briefing mode a single
 * `briefing` item seats the arrival card at the stream's tail (§1.2 Rev 2).
 * Live messages are appended by the component (they come from useChat, not
 * this module).
 *
 * `timeIso` rides every item so the floating time indicator (§1.3) can read
 * the top visible item's time without re-deriving it.
 */

import type { UIMessage } from "ai";
import type { SliceWithContent } from "@/lib/episodic/actions";
import type { Turn } from "@/lib/episodic/types";
import { classifySeam, type SeamKind } from "./seam";

export interface SeamItem {
  kind: "seam";
  key: string;
  seam: SeamKind;
  /** Start of the NEWER slice — the boundary heading's date. */
  dateIso: string;
  /** Last activity of the OLDER slice — the time spine's interval ("6 days")
   *  measures from here to `dateIso` (v0.11 §3.1). Absent when the older slice
   *  carries neither turns nor an `end` — the seam then states no interval
   *  rather than inventing one. */
  prevActivityIso?: string;
  /** The NEWER slice's strands — the seam is that slice's top edge, so its
   *  screen height is an activity of these strands for the left band's strand
   *  field (v0.11 §2.3/§2.4). */
  strands: string[];
  timeIso: string;
}

export interface HistoryTurnItem {
  kind: "history-turn";
  key: string;
  sliceId: string;
  /** The owning slice's strands — the user bubble's tint source. */
  strands: string[];
  turn: Turn;
  timeIso: string;
}

/** The "继续 <date> 的对话" banner — sits directly above the resumed slice. */
export interface ResumeBannerItem {
  kind: "resume-banner";
  key: string;
  startIso: string;
  timeIso: string;
}

/**
 * The arrival briefing as a STREAM-TAIL item (§1.2 Rev 2): in briefing mode
 * the EmptyBriefing content lands at the bottom of the stream (input bar
 * below it), with scrollable history above — there is no separate "briefing
 * page vs stream" split anymore. The parent renders it (the component needs
 * the briefing's live data props); this item is just its seat in the list.
 */
export interface BriefingItem {
  kind: "briefing";
  key: string;
  timeIso: string;
}

export type HistoryStreamItem =
  | SeamItem
  | HistoryTurnItem
  | ResumeBannerItem
  | BriefingItem;

/** A live turn — the message in flight. The component appends these from
 *  `useChat`; this module never builds one, which is why it lives here as a
 *  type only. Kept beside the history union because BOTH renderers of the
 *  stream — the virtualized list and the conversation field — take the same
 *  `ChatStreamItem[]` and must not describe it twice. */
export interface LiveStreamItem {
  kind: "live";
  key: string;
  message: UIMessage;
  /** The current slice's strands — the user bubble's tint source. */
  strands?: string[];
  timeIso: string;
  isStreaming: boolean;
  startedAt?: string;
  onRegenerate?: () => void;
}

/** Everything either renderer can be handed, oldest → newest. */
export type ChatStreamItem = HistoryStreamItem | LiveStreamItem;

/** The still-alive newest slice restored by getArrivalState (§2). */
export interface ResumeBlock {
  sliceId: string;
  start: string;
  focus: string;
  strands: string[];
  turns: Turn[];
}

function turnItem(
  sliceId: string,
  turn: Turn,
  index: number,
  strands: string[],
): HistoryTurnItem {
  return {
    kind: "history-turn",
    key: `ht-${sliceId}-${index}-${turn.timestamp}`,
    sliceId,
    strands,
    turn,
    timeIso: turn.timestamp,
  };
}

function seamItem(
  closedBy: string | undefined,
  newerSliceId: string,
  dateIso: string,
  strands: string[],
  prevActivityIso: string | undefined,
): SeamItem {
  return {
    kind: "seam",
    key: `seam-${newerSliceId}`,
    seam: classifySeam(closedBy),
    dateIso,
    prevActivityIso,
    strands,
    timeIso: dateIso,
  };
}

/**
 * The OLDER slice's last activity — the point the seam's interval ("6 days")
 * measures from, to the newer slice's start (v0.11 §3.1).
 *
 * The last TURN, not `end`. `end` is stamped when the close is DETECTED, which
 * happens on the next session's first message — so `end`→start is a near
 * constant ~7s (real data) while the silence the user actually felt lives
 * between the last turn and the new slice's start (2.9h, 13.2h, …). Turns are
 * preferred; `end` only covers a turn-less slice (the writer's own fallback —
 * `closeSlice` sets `end` from the last turn).
 */
function lastActivityIso(slice: SliceWithContent): string | undefined {
  return slice.turns.at(-1)?.timestamp ?? slice.end;
}

/**
 * Flatten historical slices (oldest → newest) plus the optional resume block
 * into the stream's item prefix.
 */
export function buildHistoryItems(
  slices: readonly SliceWithContent[],
  resume: ResumeBlock | null,
): HistoryStreamItem[] {
  const items: HistoryStreamItem[] = [];
  slices.forEach((slice, i) => {
    if (i > 0) {
      items.push(
        seamItem(
          slices[i - 1].closedBy,
          slice.id,
          slice.start,
          slice.strands,
          lastActivityIso(slices[i - 1]),
        ),
      );
    }
    slice.turns.forEach((turn, j) =>
      items.push(turnItem(slice.id, turn, j, slice.strands)),
    );
  });
  if (resume) {
    const last = slices[slices.length - 1];
    if (last) {
      items.push(
        seamItem(
          last.closedBy,
          resume.sliceId,
          resume.start,
          resume.strands,
          lastActivityIso(last),
        ),
      );
    }
    items.push({
      kind: "resume-banner",
      key: `resume-${resume.sliceId}`,
      startIso: resume.start,
      timeIso: resume.start,
    });
    resume.turns.forEach((turn, j) =>
      items.push(turnItem(resume.sliceId, turn, j, resume.strands)),
    );
  }
  return items;
}

/**
 * Prepend one older page of slices onto the loaded list.
 *
 * Pages are exclusive by cursor, so duplicates only occur on overlap edge
 * cases (e.g. a slice file landing between two page fetches) — dedupe by id
 * defensively. `addedItemCount` is the exact number of stream items the
 * prepend introduces — the delta Virtuoso's `firstItemIndex` must shift by to
 * hold the scroll position. It accounts for the seam the old head slice gains
 * (a seam only exists between two loaded slices), so callers never re-derive
 * it.
 */
export function prependPage(
  existing: readonly SliceWithContent[],
  page: readonly SliceWithContent[],
): { slices: SliceWithContent[]; addedItemCount: number } {
  const known = new Set(existing.map((s) => s.id));
  const fresh = page.filter((s) => !known.has(s.id));
  if (fresh.length === 0) return { slices: [...existing], addedItemCount: 0 };
  const before = buildHistoryItems(existing, null).length;
  const slices = [...fresh, ...existing];
  const addedItemCount = buildHistoryItems(slices, null).length - before;
  return { slices, addedItemCount };
}
