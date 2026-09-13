"use client";

/**
 * SliceConversation — one slice drawn as its TURNS: the field's finest rung.
 *
 * WHAT IT IS. `units.ts` names this rung `conversation` and pairs it with the
 * `slice` rung: the same unit (ONE SLICE — `stackLevelForRung` sends both to
 * L0), drawn two ways. A card unit has a formula for its height; a
 * conversation does not, because it is exactly as tall as its text. This is
 * therefore the one face in the field that MEASURES itself and reports upward,
 * and that report is the field's only knowledge of where the next unit starts.
 *
 * WHY IT ASKS FOR `full` AND NOT `meta`. The cache holds two faces of one
 * immutable slice and they are NOT interchangeable (`slice-cache.ts`). The card
 * needs the server-truncated opening rounds, because a fixed-size frame handed
 * a whole conversation would centre on the middle of it. A reader who has
 * zoomed all the way in came to read the whole thing, so this face asks for
 * `full` — and because the cache keeps ONE entry per slice id, a slice the chat
 * has already paged in is upgraded in place and this subscription is handed the
 * turns with no second repository read.
 *
 * WHY NOTHING RENDERS WHILE IT LOADS. The field lays units out on a running
 * offset table that gives an unmeasured unit the height of the one before it
 * (`buildOffsets`). That is a good guess. A skeleton is not: it draws at one
 * height and then changes to another, and every unit below the reader moves by
 * the difference on the frame the real content lands. So a loading unit renders
 * NOTHING and reports NOTHING, and inherits. The guard in `reportableFaceHeight`
 * is the same rule stated at the other end — a measured 0 is not a measurement.
 *
 * THE PROVIDER IS REQUIRED, NOT DEFENSIVE — the same reason `BillboardBlock`
 * carries one: a unit is mounted through a portal (`<Html>` in the conversation
 * field), which puts it in its own React root, so no context from above the
 * canvas reaches it. `frame-card.tsx` passes every string as a prop for exactly
 * this reason; re-wrapping is the cheaper half of that trade while these are
 * the components the real stream renders verbatim.
 */

import { useEffect, useRef, useState } from "react";
import { NextIntlClientProvider, useMessages } from "next-intl";
import type { JSX } from "react";
import type { TimelineSliceEntry } from "@/lib/episodic/timeline/types";
import type { Turn } from "@/lib/episodic/types";
import type { UnitBoundary } from "@/lib/timeline3d/boundary";
import type { GateSignal } from "@/lib/chat/field-blocks";
import { peekEntry, subscribeSlice } from "@/lib/chat/slice-cache";
import { HistoryTurn } from "@/components/chat/history-turn";
import { SliceGate, type SliceGateProps } from "@/components/chat/slice-gate";

/**
 * The conversation column's horizontal inset. Named once because the face and
 * the boundary after it must share it — the gate is an intertitle inside the
 * same column, not a full-bleed rule — and because it is the SAME string the
 * conversation field pads its blocks with (`BillboardBlock`), so the two
 * renderers draw a conversation at one width while they coexist.
 */
const FACE_INSET = "px-3 sm:pr-6 md:pl-0 lg:pr-8";

/**
 * The React key for one turn of a slice.
 *
 * NOT the turn id on its own. `Turn.turnId` is SHARED by the user turn and the
 * agent turn of the same round (`episodic/types.ts` says so in as many words),
 * so a list keyed on it hands React two siblings with one key: it warns, and
 * then reconciles one element for both — every round would draw one bubble
 * wearing the other's text. Legacy slices parsed off disk have no turn id at
 * all, which is why the index is in the key unconditionally. It is stable
 * because a slice's turns are append-only and a closed slice is immutable, so
 * the list never reorders.
 */
export function turnKey(turn: Turn, index: number): string {
  return `${turn.turnId ?? "legacy"}:${turn.role}:${index}`;
}

/**
 * `SliceGate`'s vocabulary, from the unit's boundary.
 *
 * A pure rename, and it earns a function because the two ends are named from
 * OPPOSITE sides. `UnitBoundary.atIso`/`fromIso` are the boundary's own two
 * times; `SliceGate` names the same two by the role they play in a crossing —
 * `dateIso` is the newer side the reader arrives at, `prevActivityIso` the
 * older side they leave. Swapping them is silent: the gate states a distance
 * and a date either way, and both faces of the armed card still read the same
 * interval, so it does not look wrong — it just states it about the wrong pair
 * of slices, and "5 分钟前" becomes "5 分钟后".
 */
export function gatePropsFor(
  boundary: UnitBoundary,
): Pick<SliceGateProps, "dateIso" | "prevActivityIso" | "focus" | "prevFocus"> {
  return {
    dateIso: boundary.atIso,
    prevActivityIso: boundary.fromIso,
    ...(boundary.focus !== undefined ? { focus: boundary.focus } : {}),
    ...(boundary.prevFocus !== undefined
      ? { prevFocus: boundary.prevFocus }
      : {}),
  };
}

/**
 * The height a face is allowed to report from a measurement, or null when there
 * is nothing to report.
 *
 * Zero is the case that matters, and it is not "a very short unit": the layout
 * reads a non-positive height as "this unit has not measured yet" and lets it
 * inherit the running height (`buildOffsets`, and `layoutFor`'s `face > 0`
 * test). Reporting one tells the table the unit is genuinely zero-tall, which
 * collapses every unit below it onto the reader — the exact failure the running
 * height exists to prevent. A non-finite reading is the same statement arriving
 * from a detached root or a `display: none` ancestor.
 */
export function reportableFaceHeight(offsetHeight: number): number | null {
  if (!Number.isFinite(offsetHeight) || offsetHeight <= 0) return null;
  return offsetHeight;
}

export interface SliceConversationProps {
  /** The slice this unit is. */
  entry: TimelineSliceEntry;
  /** The boundary that CLOSES this slice, or null when it closes none (the
   *  newest slice has nothing after it to cross). */
  boundary: UnitBoundary | null;
  /** Arm state for that boundary — a mutable object the field writes each
   *  frame. `undefined` when there is no boundary. */
  gateSignal: GateSignal | undefined;
  /** next-intl context. REQUIRED because drei's <Html> mounts each face into
   *  its own React root, which cuts context — see the note in
   *  `src/components/timeline3d/frame-card.tsx`. */
  messages: ReturnType<typeof useMessages>;
  locale: string;
  /** Called with the unit's DOM height whenever it settles. The field lays
   *  units out by a running offset table and this is its only measurement of
   *  a conversation unit (a card unit has a formula; text does not). */
  onHeight: (px: number) => void;
}

export function SliceConversation({
  entry,
  boundary,
  gateSignal,
  messages,
  locale,
  onHeight,
}: SliceConversationProps): JSX.Element | null {
  // Held WITH the id it belongs to. The field reconciles units by position, and
  // a page arriving at the head of the window renumbers every one of them — so
  // until the subscription for the new id reports, this state still describes
  // the slice that used to sit here. Showing it would put a DIFFERENT
  // conversation under the reader; showing nothing costs one frame of the
  // unmeasured-height guess the field already makes. Seeded from the cache
  // rather than from `null`, so a slice the chat has already paged in draws on
  // the first frame instead of after the effect.
  const [slice, setSlice] = useState(() => ({
    id: entry.id,
    turns: peekEntry(entry.id)?.full ?? null,
  }));

  useEffect(
    () =>
      subscribeSlice(entry.id, "full", (next) =>
        setSlice({ id: entry.id, turns: next.full }),
      ),
    [entry.id],
  );

  const turns = slice.id === entry.id ? slice.turns : null;

  const ref = useRef<HTMLDivElement>(null);
  // Held in a ref so the observer is created ONCE per mount: re-creating it
  // whenever `onHeight` changes identity would drop the observation across the
  // gap and lose the measurement of a late settle.
  const onHeightRef = useRef(onHeight);
  onHeightRef.current = onHeight;

  // The face and the boundary, once the read has landed. It gates the observer
  // below, which is the one effect that has to re-run when the root appears.
  const loaded = turns !== null;

  useEffect(() => {
    if (!loaded) return;
    const el = ref.current;
    if (!el) return;
    const report = () => {
      const h = reportableFaceHeight(el.offsetHeight);
      if (h !== null) onHeightRef.current(h);
    };
    report();
    // A face settles late — a font, a wrapped line, a highlighted code block.
    // Re-reporting is safe: this height only ever feeds this unit's own row.
    const ro = new ResizeObserver(report);
    ro.observe(el);
    return () => ro.disconnect();
  }, [loaded]);

  // STILL READING (or the read failed, which `full` never recovers from).
  // Render nothing at all: no root, no observer, no height. See the header.
  if (turns === null) return null;

  return (
    <NextIntlClientProvider messages={messages} locale={locale}>
      {/* THE MEASURED FACE — this element and nothing else. The boundary below
          is a SIBLING on purpose: the field's layout adds `FIELD_BOUNDARY_PX`
          to whatever a unit reports (`extentOf` in `units.ts`), so a measured
          root that contained the gate would be counted twice and leave a gate's
          height of dead space after every unit that closes one. The report is
          the FACE, which is what `faceHeights` means by "what a measured unit
          reports". */}
      <div ref={ref} className={FACE_INSET}>
        {turns.map((turn, i) => (
          <HistoryTurn
            key={turnKey(turn, i)}
            role={turn.role}
            content={turn.content}
            sliceId={entry.id}
            turnId={turn.turnId}
            timestamp={turn.timestamp}
            // The unit IS the slice, so every turn in it carries the slice's
            // own strands — the tint the timeline cards use.
            strands={entry.strands}
          />
        ))}
      </div>

      {/* THE BOUNDARY, AT THE TAIL. A gate belongs to the unit that CLOSES it,
          never the one it opens (`groupBlocks`). At the head it would sit at
          the top of a unit whose turns are still below it, and a page arriving
          above the reader would put a gate INSIDE the block they are reading,
          growing it by a gate's height under them — the one direction "a
          billboard grows downward" does not protect. The field has already
          reserved this room; the gate fills it rather than requesting it.

          Only drawn with its signal. The signal is the field's per-boundary
          channel, and a gate without one can never arm — it would be a
          permanently dormant rule pretending to be a boundary, which is worse
          than the gap it leaves. */}
      {boundary && gateSignal ? (
        <div className={FACE_INSET}>
          <SliceGate {...gatePropsFor(boundary)} signal={gateSignal} />
        </div>
      ) : null}
    </NextIntlClientProvider>
  );
}
