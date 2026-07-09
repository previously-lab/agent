"use client";

import { useState, useCallback, useEffect } from "react";
import { getEpisodicState, getMoreSlices, type SliceSummary } from "@/lib/episodic/actions";

export type { SliceSummary };

interface TimelineState {
  active: SliceSummary | null;
  slices: SliceSummary[];
  hasMore: boolean;
  loadedIds: string[];
}

export function useTimeline(initialData?: Partial<TimelineState> | null) {
  const hasInitialData = !!initialData?.slices?.length;
  const [state, setState] = useState<TimelineState>({
    active: initialData?.active ?? null,
    slices: initialData?.slices ?? [],
    hasMore: initialData?.hasMore ?? false,
    loadedIds: initialData?.loadedIds ?? initialData?.slices?.map((s) => s.slice_id) ?? [],
  });
  const [loading, setLoading] = useState(!hasInitialData);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    if (hasInitialData) return;
    getEpisodicState()
      .then((data) => {
        setState({
          active: data.hasActiveSlice ? data.active : null,
          slices: data.recent ?? [],
          hasMore: data.hasMore ?? false,
          loadedIds:
            data.recent?.map((s) => s.slice_id) ?? [],
        });
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [hasInitialData]);

  const loadMore = useCallback(async () => {
    if (loadingMore || !state.hasMore) return;

    const oldest = state.slices[state.slices.length - 1];
    if (!oldest) return;

    setLoadingMore(true);
    try {
      const data = await getMoreSlices(oldest.start, 10);

      setState((prev) => ({
        ...prev,
        slices: [...prev.slices, ...(data.slices ?? [])],
        hasMore: data.hasMore ?? false,
        loadedIds: [
          ...prev.loadedIds,
          ...(data.slices ?? []).map((s) => s.slice_id),
        ],
      }));
    } catch {
      // silently fail
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, state.hasMore, state.slices]);

  return {
    active: state.active,
    slices: state.slices,
    loadedIds: state.loadedIds,
    loading,
    loadingMore,
    hasMore: state.hasMore,
    loadMore,
  };
}
