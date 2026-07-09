"use client";

import { useTimeline } from "@/hooks/use-timeline";
import {
  TimeSliceRow,
  formatSliceDate,
  formatDateGroup,
  formatSliceTime,
} from "./time-slice-row";
import { Loader2, ChevronDown } from "lucide-react";
import { useEffect, useMemo } from "react";
import type { SliceSummary } from "@/hooks/use-timeline";
import { DateGroupHeader, SliceTimeMarker } from "./date-group-header";
import { useLocale } from "next-intl";

interface TimelinePanelProps {
  onLoadedIdsChange: (ids: string[]) => void;
  mode?: "panel" | "page";
  initialData?: {
    active: SliceSummary | null;
    slices: SliceSummary[];
    hasMore: boolean;
  };
}

function groupByDate(slices: SliceSummary[]): Map<string, SliceSummary[]> {
  const groups = new Map<string, SliceSummary[]>();
  for (const s of slices) {
    const label = formatSliceDate(s.start);
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label)!.push(s);
  }
  return groups;
}

export function TimelinePanel({
  onLoadedIdsChange,
  mode = "panel",
  initialData,
}: TimelinePanelProps) {
  const { slices, loading, loadingMore, hasMore, loadMore, loadedIds } =
    useTimeline(initialData);
  const locale = useLocale();

  useEffect(() => {
    onLoadedIdsChange(loadedIds);
  }, [loadedIds, onLoadedIdsChange]);

  const groups = useMemo(() => groupByDate(slices), [slices]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const groupEntries = [...groups.entries()];

  // ── Page mode: full diary-style reading ───────────────────────────
  if (mode === "page") {
    return (
      <div className="py-8 space-y-8">
        {/* "Previously on..." intro */}
        <div className="text-center pb-4">
          <p className="text-sm text-muted-foreground italic">
            {slices.length > 0
              ? `${slices.length} conversations spanning ${formatSliceDate(
                  slices[slices.length - 1]?.start ?? "",
                )} to ${formatSliceDate(slices[0]?.start ?? "")}`
              : "No memories yet"}
          </p>
        </div>

        {/* Slices in chronological order — oldest first */}
        {[...groupEntries].reverse().map(([dateLabel, dateSlices]) =>
          [...dateSlices].reverse().map((slice) => (
            <div
              key={slice.slice_id}
              className="border-b border-border/30 pb-6"
            >
              <p className="text-xs text-muted-foreground mb-3 tracking-wider">
                {dateLabel}
              </p>
              <TimeSliceRow slice={slice} />
              {slice.summary && (
                <p className="text-[0.7rem] text-muted-foreground italic mt-2 leading-relaxed">
                  {slice.summary}
                </p>
              )}
            </div>
          )),
        )}

        {/* Load more */}
        {hasMore && (
          <div className="text-center pt-4">
            <button
              onClick={loadMore}
              disabled={loadingMore}
              className="text-sm text-muted-foreground hover:text-muted-foreground transition-colors"
            >
              {loadingMore ? "Loading..." : "Load earlier memories"}
            </button>
          </div>
        )}
      </div>
    );
  }

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
                Loading...
              </span>
            ) : (
              <span className="inline-flex items-center gap-1">
                <ChevronDown className="h-3 w-3" />
                更早的记忆
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

      {/* "现在" — a centered echo of the hero; the timeline runs down and
          hands off here to the present, then live chat continues below */}
      <div className="py-12 text-center mt-12">
        <p className="text-4xl font-medium tracking-tight text-foreground">
          现在
        </p>
      </div>
    </div>
  );
}
