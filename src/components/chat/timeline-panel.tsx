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

  return (
    <div>
      {/* Load more button at TOP (scroll up to load older memories) */}
      {hasMore && (
        <button
          onClick={loadMore}
          disabled={loadingMore}
          className="w-full py-2 text-center text-xs text-muted-foreground/50 hover:text-muted-foreground/70 transition-colors border-b border-border/50"
        >
          {loadingMore ? (
            <span className="inline-flex items-center gap-1.5">
              <Loader2 className="h-3 w-3 animate-spin" />
              加载更早的记忆...
            </span>
          ) : (
            "═══ 加载更多记忆 ═══"
          )}
        </button>
      )}

      {/* Past slices (older → newer, top → bottom) */}
      {[...slices].reverse().map((slice) => (
        <TimeSliceRow key={slice.slice_id} slice={slice} />
      ))}

      {/* Divider */}
      {slices.length > 0 && (
        <div className="px-4 py-2">
          <div className="border-t border-border/30" />
        </div>
      )}

      {/* Active slice (current) */}
      {active && (
        <TimeSliceRow
          slice={{ ...active, status: "active" as const }}
        />
      )}
    </div>
  );
}
