"use server";

import { getActiveSlice, readSliceIndex } from "./manager";

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

export interface EpisodicState {
  hasActiveSlice: boolean;
  active: SliceSummary | null;
  recent: SliceSummary[];
}

export async function getEpisodicState(): Promise<EpisodicState> {
  const active = getActiveSlice();

  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;
  const prevMonth = month === 1 ? 12 : month - 1;
  const prevYear = month === 1 ? year - 1 : year;

  const [currentIndex, prevIndex] = await Promise.all([
    readSliceIndex(year, month),
    readSliceIndex(prevYear, prevMonth),
  ]);

  const allSlices = [...prevIndex, ...currentIndex]
    .filter((s) => {
      const activeDay = active?.slice_id.split("-")[2];
      return s.id !== activeDay || s.status === "closed";
    })
    .sort((a, b) => b.start.localeCompare(a.start))
    .slice(0, 10);

  return {
    hasActiveSlice: active !== null,
    active: active
      ? {
          slice_id: active.slice_id,
          focus: active.focus,
          summary: active.summary,
          start: active.start,
          timezone: active.timezone,
          turnCount: active.turns.length,
          open_loops: active.open_loops,
          decisions: active.decisions,
          status: "active" as const,
        }
      : null,
    recent: allSlices.map((s) => ({
      slice_id: `${s.start.slice(0, 7)}/${s.id}`,
      focus: s.focus,
      summary: s.summary,
      start: s.start,
      status: s.status as "active" | "closed",
      open_loops: s.open_loops,
      decisions: s.decisions,
    })),
  };
}

export interface SlicePage {
  slices: SliceSummary[];
  hasMore: boolean;
}

export async function getMoreSlices(
  before: string,
  limit: number = 10
): Promise<SlicePage> {
  const beforeDate = new Date(before);
  const year = beforeDate.getUTCFullYear();
  const month = beforeDate.getUTCMonth() + 1;
  const beforeDay = beforeDate.getUTCDate();

  const index = await readSliceIndex(year, month);

  const filtered = index
    .filter((s) => {
      const day = parseInt(s.id, 10);
      return !isNaN(day) && day < beforeDay;
    })
    .sort((a, b) => b.start.localeCompare(a.start))
    .slice(0, Math.min(limit, 50));

  return {
    slices: filtered.map((s) => ({
      slice_id: `${before.slice(0, 7)}/${s.id}`,
      focus: s.focus,
      summary: s.summary,
      start: s.start,
      status: s.status as "active" | "closed",
      open_loops: s.open_loops,
      decisions: s.decisions,
    })),
    hasMore: filtered.length === Math.min(limit, 50),
  };
}
