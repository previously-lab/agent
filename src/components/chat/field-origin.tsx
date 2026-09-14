"use client";

/**
 * FieldOrigin — the head of the loaded window: the region above the oldest
 * slice the field is holding.
 *
 * It is a boundary like a slice gate, and it speaks the same language (see
 * `SliceGate`) because it answers the same question — "what time am I at?" —
 * for the one edge that has no slice on the other side. Two things can be
 * true there, and they are mutually exclusive:
 *
 *   - the window is EXHAUSTED, and this is the beginning of the memory;
 *   - the window is not, and the reader can ask for the older page.
 *
 * So the page control lives HERE rather than floating over the content. That
 * is not decoration: the head of the window is the only place where "show me
 * earlier" is a coherent thing to ask, and the reader is standing in it.
 *
 * THE ARMED FACE IS TWO LINES, EDGE-ALIGNED:
 *
 *   ↑ 2 个月前                                          19:08
 *   7月11日                                          加载更早
 *
 * It used to be four centred lines — interval, time, date, control — which
 * read as a placard stacked in the middle of the region rather than as a time
 * readout. Two lines let the edges do the work: the LEFT edge carries what
 * time this is (the interval the head measures by, the date it lands on), the
 * RIGHT edge carries the time of day and the one action available here. The
 * faces are the same three components `SliceGate` states its intertitle with
 * (`RelativeStamp`, `TimeStamp`, `DateStamp`) — this is that readout, not a
 * second one — and the page control is a pill because it is a button, not a
 * caption: a label in this position is something readers click and nothing
 * happens.
 *
 * The interval phrase is the head's own question — there is no slice on the
 * other side to measure against — so it is stated against the PRESENT, stamped
 * once per mount: a clock that re-read itself every render would restart the
 * ticker on every unrelated update.
 *
 * It sits at a CONSTANT world offset one region above block 0, which is what
 * makes loading behave. A page of older slices lands between this region and
 * the old head, so the region is always above everything loaded; combined with
 * the field's camera compensation, the reader's view does not move at all, and
 * the new conversations are off-screen above them to be scrolled into. That
 * arithmetic is the same at every rung — the card field renders THIS component
 * inside its own billboard (`timeline-3d/origin-row.tsx`), so the two fields
 * cannot state their head two different ways.
 */

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { ChevronUp, Loader2 } from "lucide-react";
import { DateStamp, TimeStamp } from "./date-stamp";
import { RelativeStamp } from "./relative-time";
import { FIELD_ORIGIN_PX, type GateSignal } from "@/lib/chat/field-blocks";

export interface FieldOriginProps {
  /** Start of the OLDEST loaded slice — the time the head of the window is at. */
  oldestIso: string;
  /** Whether the catalog still holds older slices. */
  hasMore: boolean;
  /** True while the older page is in flight. */
  loading: boolean;
  onLoadOlder: () => void;
  /** Written by the field every frame; read here, never rendered from. */
  signal: GateSignal;
}

export function FieldOrigin({
  oldestIso,
  hasMore,
  loading,
  onLoadOlder,
  signal,
}: FieldOriginProps) {
  const t = useTranslations("chat.gate");
  const ref = useRef<HTMLDivElement>(null);
  const [nowIso] = useState(() => new Date().toISOString());
  const shownRef = useRef<boolean | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      if (signal.armed === shownRef.current) return;
      shownRef.current = signal.armed;
      el.dataset.armed = signal.armed ? "true" : "false";
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [signal]);

  return (
    <div
      ref={ref}
      data-armed="false"
      style={{ height: FIELD_ORIGIN_PX }}
      className="relative w-full select-none"
    >
      {/* DORMANT — the window's head as a quiet rule, saying only that there
          is nothing above it that is currently loaded. */}
      <div className="gate-idle absolute inset-0 flex items-end justify-center gap-3 pb-3">
        <span className="h-px flex-1 bg-border/40" aria-hidden />
        <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground/50">
          {t(hasMore ? "head" : "beginning")}
        </span>
        <span className="h-px flex-1 bg-border/40" aria-hidden />
      </div>

      {/* ARMED — the reader is at the head, so the head answers. The origin
          has only one face — there is no other side to travel to — so it wears
          the solo class rather than the gate's direction pair. */}
      <div className="gate-face gate-face-solo absolute inset-0 flex flex-col justify-center gap-2 px-4">
        {/* LINE 1 — left: how far back the head is. Right: the time it lands
            on. The chevron rides in the row rather than hanging off it: the
            row is edge-aligned, so a marker outside the left edge would fall
            outside the column the head is drawn in. */}
        <div className="flex items-baseline justify-between gap-3">
          <span className="flex min-w-0 items-baseline gap-1.5">
            <ChevronUp className="size-3 shrink-0 self-center" aria-hidden />
            <span className="inline-flex items-baseline font-mono text-[10px] uppercase tracking-[0.3em] text-muted-foreground">
              <RelativeStamp
                fromIso={nowIso}
                toIso={oldestIso}
                fallback={t("earlier")}
              />
            </span>
          </span>
          {/* `shrink-0`: the interval phrase is the side that gives way when
              the column is at its narrowest — a squeezed "19:08" is a clock
              face rendered wrong. */}
          <TimeStamp
            timestamp={oldestIso}
            className="shrink-0 text-3xl tracking-tight text-foreground"
          />
        </div>

        {/* LINE 2 — left: the date; right: the only action this region has.
            With nothing older to page in there is no control at all: the
            statement that this is the beginning of the memory belongs to the
            dormant rule, and saying it twice in one region is one statement
            too many. */}
        <div className="flex items-center justify-between gap-3">
          <DateStamp
            timestamp={oldestIso}
            className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground/70"
          />
          {hasMore && (
            <button
              type="button"
              onClick={onLoadOlder}
              disabled={loading}
              className="pointer-events-auto inline-flex shrink-0 items-center gap-1.5 rounded-full border border-border/60 bg-card/90 px-3 py-1.5 text-[11px] text-muted-foreground backdrop-blur-sm transition-colors hover:text-foreground disabled:opacity-60"
            >
              {loading && <Loader2 className="size-3 animate-spin" aria-hidden />}
              {t("loadOlder")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
