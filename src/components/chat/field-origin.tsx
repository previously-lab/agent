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
 * It sits at a CONSTANT world offset one region above block 0, which is what
 * makes loading behave. A page of older slices lands between this region and
 * the old head, so the region is always above everything loaded; combined with
 * the field's camera compensation, the reader's view does not move at all, and
 * the new conversations are off-screen above them to be scrolled into.
 */

import { useEffect, useRef } from "react";
import { useLocale, useTranslations } from "next-intl";
import { ChevronUp, Loader2 } from "lucide-react";
import { RollingTime } from "./rolling-number";
import { formatSeamDate } from "./slice-seam";
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
  const locale = useLocale();
  const ref = useRef<HTMLDivElement>(null);
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
      <div className="gate-face gate-face-solo absolute inset-0 flex flex-col items-center justify-center gap-2 px-4">
        <span className="flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.3em] text-muted-foreground">
          <ChevronUp className="size-3 shrink-0" aria-hidden />
          {t("earlier")}
        </span>
        <RollingTime
          timestamp={oldestIso}
          className="text-3xl tracking-tight text-foreground"
        />
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground/70">
          {formatSeamDate(oldestIso, locale)}
        </span>
        {hasMore && (
          <button
            type="button"
            onClick={onLoadOlder}
            disabled={loading}
            className="mt-1 pointer-events-auto inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-card/90 px-3 py-1.5 text-[11px] text-muted-foreground backdrop-blur-sm transition-colors hover:text-foreground disabled:opacity-60"
          >
            {loading && <Loader2 className="size-3 animate-spin" aria-hidden />}
            {t("loadOlder")}
          </button>
        )}
      </div>
    </div>
  );
}
