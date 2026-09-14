"use client";

/**
 * SliceGate — the region between two conversations, and the one place in the
 * field that is not content.
 *
 * WHAT IT IS. A slice is over, the next has not started, and the reader is
 * crossing between them. It used to be a hairline divider, which left the band
 * un-twisting over a region with nothing in it: the release looked like a
 * rendering gap rather than a place. The gate has real height because a
 * release needs somewhere to happen.
 *
 * WHAT IT DOES. It is an INTERTITLE. Crossing a boundary is arriving at a new
 * time, and the card says how far that time is — "12 分钟之前" one way, "12
 * 分钟之后" the other, the same distance read in both directions — over the
 * time it lands on, the date that time is in, and what that conversation was
 * about. Film intertitles have always worked this way, and so does every other
 * time readout in this app.
 *
 * THE ARRANGEMENT IS NOT THIS FILE'S. Rows, seats, type and edges come from
 * `intertitle.tsx`, which the window's head is drawn with too: a gate and a
 * head differ in ONE seat (the focus below, the older-page control at the
 * head) and in nothing else, so moving between them never re-lays-out the
 * region under the reader.
 *
 * ONLY ONE SPEAKS AT A TIME. The field decides which boundary is announcing
 * (`armedGate`) and writes it into the `signal` object this component was
 * handed. That is per-gate, and it is the whole reason a boundary that is
 * nowhere near the reader can no longer claim the reader is crossing it — an
 * earlier version kept one direction flag for the entire field, so a single
 * wheel tick flipped every gate on screen.
 *
 * WHY IT IS NOT REACT STATE. The armed flag flips while scrolling, and each
 * gate is a separate `<Html>` React root — a state change would re-render the
 * portal to swap two words. The signal is a mutable object and the gate writes
 * a `data-` attribute from its own frame loop; CSS does the rest.
 *
 * THE BOX NEVER CHANGES SIZE. `SLICE_GATE_PX` is fixed, and the dormant and
 * armed faces are both absolutely positioned inside it. If arming changed the
 * height, arming a gate would move every block below it — the exact failure
 * the field's top-anchored layout exists to avoid.
 */

import { useEffect, useRef } from "react";
import { useTranslations } from "next-intl";
import { DateStamp } from "./date-stamp";
import { Intertitle } from "./intertitle";
import { SLICE_GATE_PX, type GateSignal } from "@/lib/chat/field-blocks";

export interface SliceGateProps {
  /** Start of the NEWER slice — the destination travelling forward. */
  dateIso: string;
  /** Last activity of the OLDER slice — the destination travelling back.
   *  Absent on a slice that recorded none, in which case the earlier face
   *  falls back to the newer time rather than rendering an empty readout. */
  prevActivityIso?: string;
  /** The NEWER slice's focus — what the reader lands in going forward. */
  focus?: string;
  /** The OLDER slice's focus — what the reader lands in going back. */
  prevFocus?: string;
  /** Written by the field every frame; read here, never rendered from. */
  signal: GateSignal;
}

/** A focus is worth showing only when the slice actually carries one — an
 *  unmarked slice stores the literal "(none)", which reads as a bug. */
function usableFocus(focus: string | undefined): string | null {
  if (!focus) return null;
  const trimmed = focus.trim();
  if (!trimmed || trimmed === "(none)") return null;
  return trimmed;
}

/**
 * One of the two faces the armed card can wear — which one is on show is
 * chosen by the `data-dir` attribute, in CSS, because the flip happens
 * mid-scroll and must not cost a render.
 *
 * BOTH FACES READ THE SAME INTERVAL. `anchorIso` is the far side of the gate,
 * so the two faces state the same distance and disagree only about which way
 * it points — which is exactly what "12 分钟之前" and "12 分钟之后" mean.
 *
 * THE FACE IS THE SHARED ARRANGEMENT (`Intertitle`) WITH ONE SEAT FILLED: the
 * destination's focus sits where the window's head puts its older-page
 * control. It is no longer four centred lines, and that is not a restyle —
 * the head has always stated this boundary as two edge-aligned rows, and a
 * reader crossing from one to the other was watching the region re-lay-out.
 */
function ArmedFace({
  dir,
  iso,
  anchorIso,
  focus,
}: {
  dir: "past" | "future";
  iso: string;
  anchorIso: string;
  focus: string | undefined;
}) {
  const t = useTranslations("chat.gate");
  const said = usableFocus(focus);
  return (
    <div
      className={`gate-face gate-face-${dir} absolute inset-0 flex flex-col justify-center px-4`}
    >
      <Intertitle
        dir={dir}
        fromIso={anchorIso}
        toIso={iso}
        fallback={t(dir === "past" ? "earlier" : "later")}
        // Row 2's left seat: the destination's focus, which is the one thing a
        // gate has that the window's head does not. A slice that carries no
        // focus leaves the seat empty — `usableFocus` has already refused the
        // literal "(none)" unmarked slices store, because that reads as a bug.
        // Clipped from the right so a long focus never pushes the date off the
        // edge it shares with the time.
        slot={
          said ? (
            <span className="min-w-0 truncate text-xs text-foreground/70">
              {said}
            </span>
          ) : null
        }
      />
    </div>
  );
}

export function SliceGate({
  dateIso,
  prevActivityIso,
  focus,
  prevFocus,
  signal,
}: SliceGateProps) {
  const t = useTranslations("chat.gate");
  const ref = useRef<HTMLDivElement>(null);
  const shownRef = useRef("");

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      // One string comparison per frame; the DOM write happens only when the
      // pair actually changes, which is once per crossing.
      const state = `${signal.armed ? "1" : "0"}:${signal.dir}`;
      if (state === shownRef.current) return;
      shownRef.current = state;
      el.dataset.armed = signal.armed ? "true" : "false";
      el.dataset.dir = signal.dir;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [signal]);

  const olderIso = prevActivityIso ?? dateIso;

  return (
    <div
      ref={ref}
      data-armed="false"
      data-dir="future"
      role="separator"
      aria-label={t("label")}
      style={{ height: SLICE_GATE_PX }}
      className="relative w-full select-none"
    >
      {/* DORMANT — the boundary as a quiet rule: a hairline with the date it
          stands between. This is what a boundary looks like when the reader is
          nowhere near crossing it, and it is most of what they ever see. */}
      <div className="gate-idle absolute inset-0 flex items-center gap-3">
        <span className="h-px flex-1 bg-border/40" aria-hidden />
        <DateStamp
          timestamp={dateIso}
          className="shrink-0 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground/50"
        />
        <span className="h-px flex-1 bg-border/40" aria-hidden />
      </div>

      <ArmedFace
        dir="past"
        iso={olderIso}
        anchorIso={dateIso}
        focus={prevFocus}
      />
      <ArmedFace
        dir="future"
        iso={dateIso}
        anchorIso={olderIso}
        focus={focus}
      />
    </div>
  );
}
