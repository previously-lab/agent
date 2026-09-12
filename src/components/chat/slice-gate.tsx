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
 * time, and the card says which — the direction, the time you land on, and
 * what that conversation was about, in the same time language the rest of the
 * app speaks (rolling digits, mono, tabular). The reader does not have to
 * guess what they just crossed into.
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
 * a `data-` attribute from its own frame loop; CSS does the rest. Same reason
 * the field writes `data-dir` instead of holding direction in state.
 *
 * THE BOX NEVER CHANGES SIZE. `SLICE_GATE_PX` is fixed, and the dormant and
 * armed faces are both absolutely positioned inside it. If arming changed the
 * height, arming a gate would move every block below it — the exact failure
 * the field's top-anchored layout exists to avoid.
 */

import { useEffect, useRef } from "react";
import { useLocale, useTranslations } from "next-intl";
import { ChevronDown, ChevronUp } from "lucide-react";
import { RollingTime } from "./rolling-number";
import { formatSeamDate } from "./slice-seam";
import { SLICE_GATE_PX, type GateSignal } from "@/lib/chat/field-blocks";

export interface SliceGateProps {
  /** Start of the NEWER slice — the destination when travelling forward. */
  dateIso: string;
  /** Last activity of the OLDER slice — the destination when travelling back.
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
 */
function ArmedFace({
  dir,
  iso,
  focus,
  label,
}: {
  dir: "past" | "future";
  iso: string;
  focus: string | undefined;
  label: string;
}) {
  const locale = useLocale();
  const said = usableFocus(focus);
  return (
    <div
      className={`gate-face gate-face-${dir} absolute inset-0 flex flex-col items-center justify-center gap-1.5 px-4`}
    >
      <span className="flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.3em] text-muted-foreground">
        {dir === "past" ? (
          <ChevronUp className="size-3 shrink-0" aria-hidden />
        ) : (
          <ChevronDown className="size-3 shrink-0" aria-hidden />
        )}
        {label}
      </span>
      <RollingTime
        timestamp={iso}
        className="text-3xl tracking-tight text-foreground"
      />
      <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground/70">
        {formatSeamDate(iso, locale)}
      </span>
      {said && (
        <span className="max-w-full truncate text-xs text-foreground/70">
          {said}
        </span>
      )}
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
  const locale = useLocale();
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
        <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.18em] tabular-nums text-muted-foreground/50">
          {formatSeamDate(dateIso, locale)}
        </span>
        <span className="h-px flex-1 bg-border/40" aria-hidden />
      </div>

      <ArmedFace
        dir="past"
        iso={olderIso}
        focus={prevFocus}
        label={t("earlier")}
      />
      <ArmedFace dir="future" iso={dateIso} focus={focus} label={t("later")} />
    </div>
  );
}
