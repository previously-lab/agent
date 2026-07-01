"use client";

import { useTimeline } from "@/hooks/use-timeline";
import { TimeSliceRow } from "./time-slice-row";
import { Loader2 } from "lucide-react";
import { useEffect } from "react";

interface TimelinePanelProps {
  onLoadedIdsChange: (ids: string[]) => void;
}

export function TimelinePanel({ onLoadedIdsChange }: TimelinePanelProps) {
  const { active, slices, loading, loadingMore, hasMore, loadMore, loadedIds } =
    useTimeline();

  useEffect(() => {
    onLoadedIdsChange(loadedIds);
  }, [loadedIds, onLoadedIdsChange]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const closedSlices = slices.filter((s) => s.status !== "active");

  return (
    <div>
      {/* Load more — always visible at top */}
      <button
        onClick={loadMore}
        disabled={loadingMore || !hasMore}
        className="w-full py-3 text-center text-xs text-muted-foreground/40 hover:text-muted-foreground/60 transition-colors disabled:cursor-default"
      >
        {loadingMore ? (
          <span className="inline-flex items-center gap-1.5">
            <Loader2 className="h-3 w-3 animate-spin" />
            加载更早的记忆...
          </span>
        ) : hasMore ? (
          "═══ 加载更多记忆 ═══"
        ) : (
          "── 没有更早的记忆了 ──"
        )}
      </button>

      {/* Past slices (older at top, newer at bottom) */}
      {[...closedSlices].reverse().map((slice) => (
        <TimeSliceRow key={slice.slice_id} slice={slice} />
      ))}

      {/* Divider between past and present */}
      {closedSlices.length > 0 && (
        <div className="px-4 py-3">
          <div className="border-t border-border/20" />
        </div>
      )}
    </div>
  );
}
