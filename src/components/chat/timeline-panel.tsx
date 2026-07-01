"use client";

import { useTimeline } from "@/hooks/use-timeline";
import { TimeSliceRow, formatSliceDate } from "./time-slice-row";
import { Loader2 } from "lucide-react";
import { useEffect, useMemo } from "react";
import type { SliceSummary } from "@/hooks/use-timeline";
import { Separator } from "@/components/ui/separator";
import dayjs from "dayjs";

interface TimelinePanelProps {
  onLoadedIdsChange: (ids: string[]) => void;
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

export function TimelinePanel({ onLoadedIdsChange }: TimelinePanelProps) {
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

  return (
    <div>
      {/* Load more — always visible at top */}
      <button
        onClick={loadMore}
        disabled={loadingMore || !hasMore}
        className="w-full py-3 text-center text-xs text-muted-foreground/30 hover:text-muted-foreground/50 transition-colors disabled:cursor-default"
      >
        {loadingMore ? (
          <span className="inline-flex items-center gap-1.5">
            <Loader2 className="h-3 w-3 animate-spin" />
            加载更早的记忆...
          </span>
        ) : hasMore ? (
          "═══ 加载更多记忆 ═══"
        ) : (
          slices.length > 0 ? "── 没有更早的记忆了 ──" : null
        )}
      </button>

      {/* Groups of slices by date */}
      {groupEntries.map(([dateLabel, dateSlices], groupIdx) => (
        <div key={dateLabel}>
          {/* Date separator — full width */}
          <div className="flex items-center gap-3 py-2">
            <Separator className="flex-1" />
            <span className="text-[0.65rem] text-muted-foreground/30 tracking-wider shrink-0">
              {dateLabel}
            </span>
            <Separator className="flex-1" />
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
          <Separator className="flex-1" />
          <span className="text-[0.65rem] text-muted-foreground/30 tracking-wider shrink-0">
            现在
          </span>
          <Separator className="flex-1" />
        </div>
      )}
    </div>
  );
}
