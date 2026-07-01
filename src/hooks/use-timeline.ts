"use client";

import { useState, useCallback, useEffect } from "react";

export interface SliceSummary {
  slice_id: string;
  focus: string;
  summary: string;
  start: string;
  status: "active" | "closed";
  open_loops: string[];
  decisions: string[];
  turnCount?: number;
  timezone?: string;
}

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

  // Initial load
  useEffect(() => {
    fetch("/api/episodic/state")
      .then((r) => r.json())
      .then((data) => {
        setState({
          active: data.hasActiveSlice ? data.active : null,
          slices: data.recent ?? [],
          hasMore: (data.recent ?? []).length >= 10,
          loadedIds:
            data.recent?.map(
              (s: SliceSummary) => s.slice_id
            ) ?? [],
        });
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  // Load more (scroll up)
  const loadMore = useCallback(async () => {
    if (loadingMore || !state.hasMore) return;

    const oldest = state.slices[state.slices.length - 1];
    if (!oldest) return;

    setLoadingMore(true);
    try {
      const res = await fetch(
        `/api/episodic/slices?before=${oldest.start}&limit=10`
      );
      const data = await res.json();

      setState((prev) => ({
        ...prev,
        slices: [...prev.slices, ...(data.slices ?? [])],
        hasMore: data.hasMore ?? false,
        loadedIds: [
          ...prev.loadedIds,
          ...(data.slices ?? []).map((s: SliceSummary) => s.slice_id),
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
