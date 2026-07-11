"use client";

import { useTimeline } from "@/hooks/use-timeline";
import {
  TimeSliceRow,
  formatSliceDate,
  formatDateGroup,
  formatSliceTime,
} from "./time-slice-row";
import { Loader2, ChevronDown } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { SliceSummary } from "@/hooks/use-timeline";
import { DateGroupHeader, SliceTimeMarker } from "./date-group-header";
import { useLocale, useTranslations } from "next-intl";
import { NumberTicker } from "@/components/ui/number-ticker";
import { TextGenerateEffect } from "@/components/ui/text-generate-effect";
import { useLoadedIds } from "./loaded-ids-context";

interface TimelinePanelProps {
  onLoadedIdsChange?: (ids: string[]) => void;
  /** True when the live chat below has no messages yet — shows a cue to speak. */
  chatEmpty?: boolean;
  initialData?: {
    active: SliceSummary | null;
    slices: SliceSummary[];
    hasMore: boolean;
  };
}

function groupByDate(
  slices: SliceSummary[],
  t: (key: string) => string,
  locale: string,
): Map<string, SliceSummary[]> {
  const groups = new Map<string, SliceSummary[]>();
  for (const s of slices) {
    const label = formatSliceDate(s.start, t, locale);
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label)!.push(s);
  }
  return groups;
}

/**
 * A cinematic "N later" title-card label — the gap between the last recorded
 * moment and now, in the show's own time vocabulary. Anchored on the last
 * slice's `start` (slices carry no end time); the ≤30-min imprecision is
 * invisible at hour/day granularity. Returns null when the gap can't be read.
 *
 * Returns structured data so the number can be rendered with NumberTicker
 * while the unit text comes from i18n (with correct pluralisation).
 */
function getGapInfo(
  fromISO: string,
  now: number,
): { count: number; unitKey: string } | { special: string } | null {
  const from = new Date(fromISO).getTime();
  if (Number.isNaN(from) || now < from) return null;
  const minutes = Math.floor((now - from) / 60_000);
  if (minutes < 5) return { special: "moments" };
  if (minutes < 60) return { count: minutes, unitKey: "minute" };
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { count: hours, unitKey: "hour" };
  const days = Math.floor(hours / 24);
  if (days < 7) return { count: days, unitKey: "day" };
  if (days < 35) return { count: Math.floor(days / 7), unitKey: "week" };
  return { count: Math.floor(days / 30), unitKey: "month" };
}

export function TimelinePanel({
  onLoadedIdsChange,
  chatEmpty = false,
  initialData,
}: TimelinePanelProps) {
  const { slices, active, loading, loadingMore, hasMore, loadMore, loadedIds } =
    useTimeline(initialData);
  const ctx = useLoadedIds();
  const locale = useLocale();
  const tRow = useTranslations("timeline.row");
  const tPanel = useTranslations("timeline.panel");
  const tGap = useTranslations("timeline.gap");

  useEffect(() => {
    ctx.register(loadedIds);
    onLoadedIdsChange?.(loadedIds);
  }, [loadedIds]);

  const groups = useMemo(
    () => groupByDate(slices, tRow, locale),
    [slices, tRow, locale],
  );

  // "N later" title-card. Computed after mount only — it depends on the
  // current wall clock, so rendering it during SSR would mismatch on hydration.
  const gapAnchor = active?.start ?? slices[0]?.start ?? null;
  const [gapInfo, setGapInfo] = useState<ReturnType<typeof getGapInfo>>(null);
  useEffect(() => {
    setGapInfo(gapAnchor ? getGapInfo(gapAnchor, Date.now()) : null);
  }, [gapAnchor]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const groupEntries = [...groups.entries()];

  // ── Panel mode: vertical timeline; dots sit inline with their labels ──
  return (
    <div>
      <div className="relative pl-4">
        {/* Continuous spine line — dots overlay it, both centered on left-4 */}
        <div
          aria-hidden
          className="pointer-events-none absolute left-4 top-3 bottom-3 w-px -translate-x-1/2 bg-border/60"
        />

        {/* Load more — older slices load in above */}
        {hasMore && (
          <button
            onClick={loadMore}
            disabled={loadingMore}
            className="mb-1 flex items-center gap-2 py-1 text-[0.65rem] text-muted-foreground/60 hover:text-muted-foreground transition-colors disabled:cursor-default"
          >
            <span className="relative z-10 -ml-[3px] h-1.5 w-1.5 shrink-0 rounded-full bg-border" />
            {loadingMore ? (
              <span className="inline-flex items-center gap-1.5">
                <Loader2 className="h-3 w-3 animate-spin" />
                {tRow("loading")}
              </span>
            ) : (
              <span className="inline-flex items-center gap-1">
                <ChevronDown className="h-3 w-3" />
                {tPanel("earlier")}
              </span>
            )}
          </button>
        )}

        {/* Timeline — oldest at top → newest at bottom */}
        {[...groupEntries].reverse().map(([dateLabel, dateSlices]) => {
          const firstSlice = dateSlices[0];
          const dateParts = firstSlice
            ? formatDateGroup(firstSlice.start, locale)
            : null;

          return (
            <div key={dateLabel}>
              {/* Chapter node — date, dot inline with the header */}
              <div className="flex items-center gap-2 pt-6 pb-1">
                <span className="relative z-10 -ml-[4px] h-2 w-2 shrink-0 rounded-full bg-foreground" />
                {dateParts ? (
                  <DateGroupHeader
                    yearNumber={dateParts.yearNumber}
                    monthNumber={dateParts.monthNumber}
                    monthName={dateParts.monthName}
                    day={dateParts.day}
                    className="py-0"
                  />
                ) : (
                  <span className="text-xs font-bold font-mono text-foreground">
                    {dateLabel}
                  </span>
                )}
              </div>

              {/* Slice nodes — oldest at top */}
              {[...dateSlices].reverse().map((slice) => {
                const { hour, minute } = formatSliceTime(slice.start);
                return (
                  <div key={slice.slice_id}>
                    {/* time node — dot inline with the time (flex items-center) */}
                    <div className="flex items-center gap-2 pt-2">
                      <span className="relative z-10 -ml-[3px] h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground" />
                      <SliceTimeMarker hour={hour} minute={minute} />
                    </div>
                    {/* content — indented clear of the spine */}
                    <div className="pl-3">
                      <TimeSliceRow slice={slice} />
                    </div>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>

      {/* "现在" — the timeline runs down and hands off here to the present.
          On a cold open (chat still empty) a "N later" title-card sits above
          it, cutting forward from the last recorded moment to now — the same
          time vocabulary the rest of the timeline speaks. */}
      <div className="flex flex-col items-center pt-24 pb-20 mt-16 text-center">
        {gapInfo && ("special" in gapInfo ? (
          <p className="mb-5 font-mono text-xs tracking-[0.25em] text-muted-foreground/60">
            {tGap(gapInfo.special)}
          </p>
        ) : (
          <p className="mb-5 font-mono text-xs tracking-[0.25em] text-muted-foreground/60">
            <NumberTicker
              value={gapInfo.count}
              className="text-muted-foreground/60"
            />
            {" "}
            {(tGap as (key: string, values?: Record<string, number>) => string)(
              `unit.${gapInfo.unitKey}`,
              { count: gapInfo.count },
            )}
          </p>
        ))}
        <TextGenerateEffect
          words={tPanel("now")}
          className="text-5xl sm:text-6xl font-light tracking-tighter leading-none text-foreground"
          filter={false}
          duration={0.3}
          delay={0.2}
          animateOnView
        />
      </div>
    </div>
  );
}
