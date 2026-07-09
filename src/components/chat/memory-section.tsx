"use client";

import { TimelinePanel } from "./timeline-panel";
import type { SliceSummary } from "@/lib/episodic/actions";

interface MemorySectionProps {
  onLoadedIdsChange: (ids: string[]) => void;
  chatEmpty?: boolean;
  initialData?: {
    active: SliceSummary | null;
    slices: SliceSummary[];
    hasMore: boolean;
  };
}

export function MemorySection({
  onLoadedIdsChange,
  chatEmpty,
  initialData,
}: MemorySectionProps) {
  return (
    <TimelinePanel
      onLoadedIdsChange={onLoadedIdsChange}
      chatEmpty={chatEmpty}
      initialData={initialData}
    />
  );
}
