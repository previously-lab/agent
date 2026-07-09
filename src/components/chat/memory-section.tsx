"use client";

import { TimelinePanel } from "./timeline-panel";
import type { SliceSummary } from "@/lib/episodic/actions";

interface MemorySectionProps {
  onLoadedIdsChange: (ids: string[]) => void;
  initialData?: {
    active: SliceSummary | null;
    slices: SliceSummary[];
    hasMore: boolean;
  };
}

export function MemorySection({
  onLoadedIdsChange,
  initialData,
}: MemorySectionProps) {
  return (
    <TimelinePanel
      onLoadedIdsChange={onLoadedIdsChange}
      initialData={initialData}
    />
  );
}
