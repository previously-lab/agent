"use server";

import { readSliceIndex, readSliceBody, parseSlice } from "./manager";
import type { Turn } from "./types";

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
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;
  const prevMonth = month === 1 ? 12 : month - 1;
  const prevYear = month === 1 ? year - 1 : year;

  const [currentIndex, prevIndex] = await Promise.all([
    readSliceIndex(year, month),
    readSliceIndex(prevYear, prevMonth),
  ]);

  // Just return recent slices from disk — no active/closed filtering
  const allSlices = [...prevIndex, ...currentIndex]
    .sort((a, b) => b.start.localeCompare(a.start))
    .slice(0, 10);

  const first = allSlices[0];

  return {
    hasActiveSlice: allSlices.length > 0,
    active: first
      ? {
          slice_id: `${first.start.slice(0, 7)}/${first.id}`,
          focus: first.focus,
          summary: first.summary,
          start: first.start,
          status: first.status as "active" | "closed",
          open_loops: first.open_loops,
          decisions: first.decisions,
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

export interface SliceContent {
  slice_id: string;
  focus: string;
  summary: string;
  start: string;
  status: string;
  turns: Turn[];
  totalTurns: number;
  totalChars: number;
  open_loops: string[];
  decisions: string[];
}

export async function getSliceContent(
  sliceId: string
): Promise<SliceContent | null> {
  try {
    const [yearMonth, day] = sliceId.split("/");
    const path = `memory/episodic/slices/${yearMonth}/${day}.md`;
    const raw = await readSliceBody(path);
    const slice = parseSlice(raw);

    const totalChars = slice.turns.reduce(
      (sum, t) => sum + t.content.length,
      0
    );

    return {
      slice_id: slice.slice_id,
      focus: slice.focus,
      summary: slice.summary,
      start: slice.start,
      status: slice.status,
      turns: slice.turns,
      totalTurns: slice.turns.length,
      totalChars,
      open_loops: slice.open_loops,
      decisions: slice.decisions,
    };
  } catch {
    return null;
  }
}
