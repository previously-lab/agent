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

export function useTimeline() {
  const [state, setState] = useState<TimelineState>({
    active: null,
    slices: [],
    hasMore: false,
    loadedIds: [],
  });
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    getEpisodicState()
      .then((data) => {
        setState({
          active: data.hasActiveSlice ? data.active : null,
          slices: data.recent ?? [],
          hasMore: (data.recent ?? []).length >= 10,
          loadedIds:
            data.recent?.map((s) => s.slice_id) ?? [],
        });
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

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
