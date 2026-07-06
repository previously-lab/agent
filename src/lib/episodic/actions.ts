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
  hasMore: boolean;
  active: SliceSummary | null;
  recent: SliceSummary[];
}

export async function getEpisodicState(): Promise<EpisodicState & { hasMore: boolean }> {
  const DEMO_MODE = process.env.DEMO_MODE === "true";
  const DEMO_SCAN_MONTHS = 48;
  const PAGE_SIZE = 3;

  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;

  const monthsToScan = DEMO_MODE ? DEMO_SCAN_MONTHS : 2;
  const allSlices: Awaited<ReturnType<typeof readSliceIndex>> = [];
  let exhausted = true;

  for (let i = 0; i < monthsToScan; i++) {
    let m = month - i;
    let y = year;
    while (m <= 0) { m += 12; y -= 1; }
    try {
      const index = await readSliceIndex(y, m);
      for (const entry of index) allSlices.push(entry);
    } catch { /* month index may not exist */ }
    if (allSlices.length >= PAGE_SIZE + 2) { exhausted = false; break; }
  }

  const sorted = allSlices
    .filter((s) => s.status === "closed")
    .sort((a, b) => b.start.localeCompare(a.start));

  const recent = sorted.slice(0, PAGE_SIZE);
  const hasMore = sorted.length > PAGE_SIZE || !exhausted;
  const first = recent[0];

  return {
    hasActiveSlice: recent.length > 0,
    hasMore,
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
    recent: recent.map((s) => ({
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
  const DEMO_MODE = process.env.DEMO_MODE === "true";
  const DEMO_SCAN_MONTHS = 48;

  const beforeDate = new Date(before);
  const beforeYear = beforeDate.getUTCFullYear();
  const beforeMonth = beforeDate.getUTCMonth() + 1;
  const beforeDay = beforeDate.getUTCDate();

  const monthsToScan = DEMO_MODE ? DEMO_SCAN_MONTHS : 1;
  const allEntries: Awaited<ReturnType<typeof readSliceIndex>> = [];

  for (let i = 0; i < monthsToScan; i++) {
    let m = beforeMonth - i;
    let y = beforeYear;
    while (m <= 0) { m += 12; y -= 1; }
    try {
      const index = await readSliceIndex(y, m);
      for (const entry of index) {
        if (i === 0) {
          const day = parseInt(entry.id, 10);
          if (!isNaN(day) && day < beforeDay) allEntries.push(entry);
        } else {
          allEntries.push(entry);
        }
      }
    } catch { /* month index may not exist */ }
    if (allEntries.length >= limit) break;
  }

  const filtered = allEntries
    .sort((a, b) => b.start.localeCompare(a.start))
    .slice(0, Math.min(limit, 50));

  return {
    slices: filtered.map((s) => ({
      slice_id: `${s.start.slice(0, 7)}/${s.id}`,
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
    const [year, month] = yearMonth.split("-");
    const path = `memory/episodic/slices/${year}/${month}/${day}.md`;
    console.log(`[Episodic] getSliceContent: sliceId=${sliceId} → path=${path}`);
    const raw = await readSliceBody(path);
    console.log(`[Episodic] getSliceContent: read ${raw.length} bytes`);
    const slice = parseSlice(raw);
    console.log(`[Episodic] getSliceContent: parsed ${slice.turns.length} turns, ${slice.turns.reduce((s,t) => s + t.content.length, 0)} chars`);

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
  } catch (err) {
    console.error(`[Episodic] getSliceContent failed for ${sliceId}:`, err instanceof Error ? err.message : err);
    return null;
  }
}
