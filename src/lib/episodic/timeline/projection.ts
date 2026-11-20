/** Rebuildable, month-sharded semantic navigation over immutable records. */
import type { TimeSlice } from "../types";
import { deterministicSliceMark } from "../slice-mark";
import { fsListFiles, fsReadFile, type WriteBatch } from "../io-helpers";
import { absentDocumentError } from "@/lib/docs/write-validation";
import { parseSliceId } from "../turn-parser";

export const TIMELINE_ROOT = "memory/timeline";
const MONTH_FILE = /^memory\/timeline\/(\d{4}-\d{2})\.md$/;
const ENTRY = /^- \[(.*)\]\(previously:records\/(\d{4}-\d{2}-\d{2}-\d{4})\)(?: — (.*))?$/;

export interface TimelineEntry {
  sliceId: string;
  focus: string;
  summary: string;
}

export function timelinePathForSlice(sliceId: string): string {
  if (!parseSliceId(sliceId)) throw new Error("Invalid record identity for timeline");
  return `${TIMELINE_ROOT}/${sliceId.slice(0, 7)}.md`;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function entryLine(entry: TimelineEntry): string {
  return `- [${oneLine(entry.focus)}](previously:records/${entry.sliceId}) — ${oneLine(entry.summary)}`;
}

export function parseTimelineEntries(raw: string): TimelineEntry[] {
  return raw.split(/\r?\n/).flatMap(line => {
    const match = ENTRY.exec(line);
    return match ? [{ focus: match[1] ?? "", sliceId: match[2]!, summary: match[3] ?? "" }] : [];
  });
}

/** Upsert the current record into its derived month page, in the same batch. */
export async function updateTimelineProjection(slice: TimeSlice, batch?: WriteBatch): Promise<void> {
  const path = timelinePathForSlice(slice.slice_id);
  let current = "";
  try { current = await fsReadFile(path, batch, { fresh: true }); }
  catch (error) { if (!absentDocumentError(error)) throw error; }
  const fallback = deterministicSliceMark(slice);
  const next = { sliceId: slice.slice_id,
    focus: oneLine(slice.focus) || fallback.focus,
    summary: oneLine(slice.summary) || fallback.summary };
  const entries = new Map(parseTimelineEntries(current).map(entry => [entry.sliceId, entry]));
  entries.set(slice.slice_id, next);
  const lines = [...entries.values()].sort((a, b) => b.sliceId.localeCompare(a.sliceId)).map(entryLine);
  const content = `# Derived timeline ${slice.slice_id.slice(0, 7)}\n\n` +
    "Navigation only — original records remain the source of truth. Rebuildable projection, not runtime state.\n\n" +
    `${lines.join("\n")}\n`;
  if (content === current) return;
  const { fsWriteFile } = await import("../io-helpers");
  await fsWriteFile(path, content, batch);
}

export interface TimelineReadInput {
  limit: number;
  after?: string;
  before?: string;
}

export async function readTimelineEntries(
  backend: { listMemoryFiles(): Promise<string[]>; readFile(path: string): Promise<string> },
  input: TimelineReadInput,
): Promise<TimelineEntry[] | null> {
  const paths = (await backend.listMemoryFiles()).filter(path => MONTH_FILE.test(path)).sort().reverse();
  if (paths.length === 0) return null;
  const entries: TimelineEntry[] = [];
  for (const path of paths) {
    const page = parseTimelineEntries(await backend.readFile(path));
    for (const entry of page) {
      const date = entry.sliceId.slice(0, 10);
      if (input.after && date < input.after || input.before && date > input.before) continue;
      entries.push(entry);
      if (entries.length >= input.limit) return entries;
    }
  }
  return entries;
}

/** Environment-backed reader for the ordinary turn's recent context. */
export async function readRecentTimelineFromStorage(limit = 10): Promise<TimelineEntry[]> {
  const listMemoryFiles = async (): Promise<string[]> => {
    const paths: string[] = [];
    const walk = async (directory: string): Promise<void> => {
      let entries: Awaited<ReturnType<typeof fsListFiles>>;
      try { entries = await fsListFiles(directory); } catch { return; }
      for (const entry of entries) {
        if (entry.type === "dir") await walk(`${directory}/${entry.name}`);
        else paths.push(`${directory}/${entry.name}`);
      }
    };
    await walk(TIMELINE_ROOT);
    return paths;
  };
  const result = await readTimelineEntries({
    listMemoryFiles,
    readFile: path => fsReadFile(path),
  }, { limit });
  return result ?? [];
}
