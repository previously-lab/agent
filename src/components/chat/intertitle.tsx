"use client";

/**
 * Intertitle — the ONE arrangement a boundary is drawn with.
 *
 * Two places in the field state a boundary: `SliceGate`, between two
 * conversations, and `FieldOrigin`, at the head of the loaded window — the one
 * edge with no slice beyond it. They are the same statement ("what time am I
 * at?"), so they are the same shape, and this module is that shape:
 *
 *   ↑ 6 个月前                                            17:51
 *   加载更早                                              3 月 1 日
 *
 * Row 1's left seat is the interval, with the chevron that says which way it
 * points. Row 1's right seat is the clock — the time of day this boundary
 * lands on. Row 2 puts the date under the clock, on the same right edge, and
 * leaves its left seat to whatever the surface has to offer there. Both rows
 * are EDGE-ALIGNED rather than centred: an intertitle spans the field, and a
 * centred stack of four lines reads as a placard standing in the middle of the
 * region rather than as a time readout.
 *
 * THE SAME LAYOUT IN BOTH STATES, WHICH IS THE POINT OF THE MODULE. The two
 * surfaces differ in exactly one seat — row 2's left, which holds the page
 * control at the window's head and the destination's focus at a gate — and
 * everything else is fixed here. The gate used to be four centred lines while
 * the head was two edge-aligned ones, so travelling from one to the other
 * re-laid-out the region under the reader; a boundary that rearranges itself
 * when the reader moves is two designs pretending to be one component, and
 * this file is what makes that impossible to reintroduce.
 *
 * The seats are the app's own faces — `RelativeStamp` for the interval,
 * `TimeStamp`/`DateStamp` for the clock — and the type is deliberately tight
 * and quiet: a boundary marker is a caption, not a headline. The BOX is the
 * callers': both keep a fixed height (`field-blocks.ts`) so that painting a
 * boundary never moves the blocks around it. This states the arrangement
 * inside that box and says nothing about the box.
 */

import type { ReactNode } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { DateStamp, TimeStamp } from "./date-stamp";
import { RelativeStamp } from "./relative-time";

export interface IntertitleProps {
  /** Which way the reader is travelling — the chevron points back for `past`
   *  (the interval reads "earlier") and forward for `future`. */
  dir: "past" | "future";
  /** The interval's FAR end: the other side of the boundary. */
  fromIso: string;
  /** The time this side lands on — the clock face, and the interval's near end. */
  toIso: string;
  /** What the interval says when its two ends cannot be compared at all. A
   *  boundary with nothing honest to say about its distance still says
   *  something. */
  fallback: ReactNode;
  /** Row 2's left seat — the older-page control at the window's head, the
   *  destination's focus at a slice gate. Absent when the surface has neither,
   *  which is a state of this layout, not a second one. */
  slot?: ReactNode;
}

export function Intertitle({
  dir,
  fromIso,
  toIso,
  fallback,
  slot,
}: IntertitleProps) {
  return (
    <div className="flex w-full flex-col gap-1">
      {/* LINE 1 — left: how far away the boundary is. Right: the time it lands
          on. The chevron rides IN the row rather than hanging off it: the row
          is edge-aligned, so a marker outside the left edge would fall outside
          the column the intertitle is drawn in. */}
      <div className="flex items-baseline justify-between gap-3">
        <span className="flex min-w-0 items-baseline gap-1.5">
          {dir === "past" ? (
            <ChevronUp className="size-3 shrink-0 self-center" aria-hidden />
          ) : (
            <ChevronDown className="size-3 shrink-0 self-center" aria-hidden />
          )}
          <span className="inline-flex items-baseline font-mono text-[10px] uppercase tracking-[0.3em] text-muted-foreground">
            <RelativeStamp fromIso={fromIso} toIso={toIso} fallback={fallback} />
          </span>
        </span>
        {/* `shrink-0`: the interval phrase is the side that gives way when the
            column is at its narrowest — a squeezed clock face is a clock face
            rendered wrong. */}
        <TimeStamp
          timestamp={toIso}
          className="shrink-0 text-3xl tracking-tight text-foreground"
        />
      </div>

      {/* LINE 2 — left: the surface's own seat. Right: the date the clock above
          lands on, on the same edge as the time, so the right column reads as
          one block: the moment, and the day it is in. */}
      <div className="flex items-baseline justify-between gap-3">
        <div className="flex min-w-0 items-baseline">{slot}</div>
        <DateStamp
          timestamp={toIso}
          className="shrink-0 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground/70"
        />
      </div>
    </div>
  );
}
