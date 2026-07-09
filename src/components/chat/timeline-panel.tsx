"use client";

import { useTimeline } from "@/hooks/use-timeline";
import { TimeSliceRow, formatSliceDate } from "./time-slice-row";
import { Loader2 } from "lucide-react";
import { useEffect, useMemo } from "react";
import type { SliceSummary } from "@/hooks/use-timeline";
import { DashedSeparator } from "./dashed-separator";
import dayjs from "dayjs";

interface TimelinePanelProps {
  onLoadedIdsChange: (ids: string[]) => void;
  mode?: "panel" | "page";
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

export function TimelinePanel({ onLoadedIdsChange, mode = "panel" }: TimelinePanelProps) {
  const { slices, loading, loadingMore, hasMore, loadMore, loadedIds } =
    useTimeline();

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
          <p className="text-sm text-muted-foreground/40 italic">
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
              <p className="text-xs text-muted-foreground/30 mb-3 tracking-wider">
                {dateLabel}
              </p>
              <TimeSliceRow slice={slice} />
              {slice.summary && (
                <p className="text-[0.7rem] text-muted-foreground/40 italic mt-2 leading-relaxed">
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
              className="text-sm text-muted-foreground/30 hover:text-muted-foreground/50 transition-colors"
            >
              {loadingMore ? "Loading..." : "Load earlier memories"}
            </button>
          </div>
        )}
      </div>
    );
  }

  // ── Panel mode: compact sidebar-style ─────────────────────────────
  return (
    <div>
      {/* Load more — only visible when there are more slices to fetch */}
      {hasMore && (
        <div className="flex items-center gap-3 py-3">
          <DashedSeparator className="flex-1" />
          <button
            onClick={loadMore}
            disabled={loadingMore}
            className="text-[0.65rem] text-muted-foreground/30 hover:text-muted-foreground/50 transition-colors shrink-0 disabled:cursor-default"
          >
            {loadingMore ? (
              <span className="inline-flex items-center gap-1.5">
                <Loader2 className="h-3 w-3 animate-spin" />
                加载更早的记忆...
              </span>
            ) : (
              "加载更多记忆"
            )}
          </button>
          <DashedSeparator className="flex-1" />
        </div>
      )}

      {/* Groups of slices by date — reversed for chronological order (oldest top → newest bottom) */}
      {[...groupEntries].reverse().map(([dateLabel, dateSlices], groupIdx) => (
        <div key={dateLabel}>
          {/* Date separator — full width */}
          <div className="flex items-center gap-3 py-2">
            <DashedSeparator className="flex-1" />
            <span className="text-[0.65rem] text-muted-foreground/30 tracking-wider shrink-0">
              {dateLabel}
            </span>
            <DashedSeparator className="flex-1" />
          </div>

          {/* Slices within this date group (oldest at top) */}
          {[...dateSlices].reverse().map((slice) => (
            <TimeSliceRow key={slice.slice_id} slice={slice} />
          ))}

          {/* Gap between groups */}
          {groupIdx < groupEntries.length - 1 && (
            <div className="pb-1" />
          )}
        </div>
      ))}

      {/* "Now" separator — full width */}
      {slices.length > 0 && (
        <div className="flex items-center gap-3 py-3">
          <DashedSeparator className="flex-1" />
          <span className="text-[0.65rem] text-muted-foreground/30 tracking-wider shrink-0">
            现在
          </span>
          <DashedSeparator className="flex-1" />
        </div>
      )}
    </div>
  );
}
