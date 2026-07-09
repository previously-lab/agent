"use client";

import { useTimeline } from "@/hooks/use-timeline";
import { TimeSliceRow, formatSliceDate, formatDateGroup } from "./time-slice-row";
import { Loader2, ChevronDown } from "lucide-react";
import { useEffect, useMemo } from "react";
import type { SliceSummary } from "@/hooks/use-timeline";
import { DashedSeparator } from "./dashed-separator";
import { DateGroupHeader } from "./date-group-header";
import { useLocale } from "next-intl";
import dayjs from "dayjs";

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

export function TimelinePanel({ onLoadedIdsChange, mode = "panel", initialData }: TimelinePanelProps) {
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
              ? `${slices.length} conversations spanning ${
                  formatSliceDate(slices[slices.length - 1]?.start ?? "")
                } to ${
                  formatSliceDate(slices[0]?.start ?? "")
                }`
              : "No memories yet"}
          </p>
        </div>

        {/* Slices in chronological order — oldest first */}
        {[...groupEntries].reverse().map(([dateLabel, dateSlices]) =>
          [...dateSlices].reverse().map((slice) => (
            <div key={slice.slice_id} className="border-b border-border/30 pb-6">
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
          ))
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

  // ── Panel mode: chronological, left-aligned date headers ───────────
  return (
    <div>
      {/* Load more — at top, subtle */}
      {hasMore && (
        <div className="py-2">
          <button
            onClick={loadMore}
            disabled={loadingMore}
            className="text-[0.65rem] text-muted-foreground/60 hover:text-muted-foreground transition-colors disabled:cursor-default"
          >
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
        </div>
      )}

      {/* Groups of slices by date — chronological order (oldest top → newest bottom) */}
      {[...groupEntries].reverse().map(([dateLabel, dateSlices], groupIdx) => {
        const firstSlice = dateSlices[0];
        const dateParts = firstSlice ? formatDateGroup(firstSlice.start, locale) : null;

        return (
          <div key={dateLabel}>
            {/* Date header — DateGroupHeader component */}
            {dateParts ? (
              <DateGroupHeader
                yearNumber={dateParts.yearNumber}
                monthNumber={dateParts.monthNumber}
                monthName={dateParts.monthName}
                day={dateParts.day}
              />
            ) : (
              <p className="text-sm text-muted-foreground pt-6 pb-2">
                {dateLabel}
              </p>
            )}
            <DashedSeparator className="mb-3" />

            {/* Slices within this date group (oldest at top) */}
            {[...dateSlices].reverse().map((slice) => (
              <TimeSliceRow key={slice.slice_id} slice={slice} />
            ))}

            {/* Gap between groups */}
            {groupIdx < groupEntries.length - 1 && <div className="pb-1" />}
          </div>
        );
      })}

    </div>
  );
}
