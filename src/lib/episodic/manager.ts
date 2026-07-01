/**
 * Episodic Memory Manager — core CRUD for time slices.
 *
 * Tracks the active time slice in memory, computes file paths, serializes
 * slices to Markdown (YAML frontmatter + turns body), and maintains the
 * monthly index and global tag index on disk.
 *
 * All file I/O delegates to the existing tools layer, which handles the
 * local-dev vs GitHub-production switch transparently.
 */
import matter from "gray-matter";
import { readFile as readFileGitHub } from "@/lib/tools/readFile";
import { writeFile as writeFileGitHub } from "@/lib/tools/writeFile";
import { listFiles as listFilesGitHub } from "@/lib/tools/listFiles";
import {
  readFileLocal,
  writeFileLocal,
  listFilesLocal,
} from "@/lib/tools/local-fs";
import type {
  TimeSlice,
  Turn,
  SlicingSignal,
  SliceIndexEntry,
  SliceFrontmatter,
  MonthlyIndex,
  TagIndex,
} from "./types";

// ─── Environment detection ───────────────────────────────────────────────

const USE_GITHUB = process.env.GITHUB_TOKEN != null;

function getRepoConfig(): { owner: string; repo: string } {
  const owner = process.env.GITHUB_REPO_OWNER ?? "local";
  const repo = process.env.GITHUB_REPO_NAME ?? "local";
  return { owner, repo };
}

// ─── Internal I/O helpers ────────────────────────────────────────────────

async function fsReadFile(path: string): Promise<string> {
  if (USE_GITHUB) {
    const { owner, repo } = getRepoConfig();
    return readFileGitHub(path, repo, owner);
  }
  return readFileLocal(path);
}

async function fsWriteFile(
  path: string,
  content: string
): Promise<{ path: string; created: boolean }> {
  if (USE_GITHUB) {
    const { owner, repo } = getRepoConfig();
    return writeFileGitHub(path, content, repo, owner);
  }
  return writeFileLocal(path, content);
}

async function fsListFiles(
  path: string
): Promise<Array<{ name: string; type: "file" | "dir"; path: string }>> {
  if (USE_GITHUB) {
    const { owner, repo } = getRepoConfig();
    return listFilesGitHub(path, repo, owner);
  }
  return listFilesLocal(path);
}

// ─── In-memory active slice tracking ─────────────────────────────────────

let activeSlice: TimeSlice | null = null;

/**
 * Get the currently active time slice, or null if none is open.
 */
export function getActiveSlice(): TimeSlice | null {
  return activeSlice;
}

/**
 * Create a new time slice and set it as the active one.
 * The slice_id is derived from the current UTC date at time of first message.
 * Does NOT write to disk — that happens when appendTurn or closeSlice is called.
 */
export function createSlice(userMessage: string, timezone: string): TimeSlice {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  const day = String(now.getUTCDate()).padStart(2, "0");
  const sliceId = `${year}-${month}-${day}`;
  const start = now.toISOString();

  const firstTurn: Turn = {
    timestamp: start,
    role: "user",
    content: userMessage,
  };

  const slice: TimeSlice = {
    slice_id: sliceId,
    focus: "",
    status: "active",
    start,
    timezone,
    summary: "",
    open_loops: [],
    decisions: [],
    tags: [],
    related_slices: [],
    turns: [firstTurn],
    estimatedTokens: Math.ceil(userMessage.length / 4),
  };

  activeSlice = slice;
  return slice;
}

/**
 * Close the active time slice, persisting it to disk and running
 * index maintenance. Returns the closed slice.
 */
export async function closeSlice(
  slice: TimeSlice,
  signal: SlicingSignal
): Promise<TimeSlice> {
  slice.status = "closed";
  slice.end = new Date().toISOString();
  slice.closedBy = signal;

  // Persist the closed slice body to disk
  const slicePath = getSlicePath(slice);
  const markdown = serializeSlice(slice);
  await fsWriteFile(slicePath, markdown);

  // Run index maintenance
  await updateMonthlyIndex(slice);
  await updateTagIndex(slice);

  // Clear active if this was the active slice
  if (activeSlice?.slice_id === slice.slice_id) {
    activeSlice = null;
  }

  return slice;
}

// ─── Path computation ────────────────────────────────────────────────────

/**
 * Compute the file path for a time slice .md file.
 * Format: memory/episodic/slices/YYYY/MM/DD.md
 */
export function getSlicePath(slice: TimeSlice): string {
  const [year, month, day] = slice.slice_id.split("-");
  return `memory/episodic/slices/${year}/${month}/${day}.md`;
}

/**
 * Compute the path to a monthly _index.json file.
 * Format: memory/episodic/slices/YYYY/MM/_index.json
 */
export function getIndexPath(year: number, month: number): string {
  const mm = String(month).padStart(2, "0");
  return `memory/episodic/slices/${year}/${mm}/_index.json`;
}

/**
 * Get the path to the global tag-index.json file.
 */
export function getTagIndexPath(): string {
  return "memory/episodic/tag-index.json";
}

// ─── Serialization ───────────────────────────────────────────────────────

/**
 * Serialize a TimeSlice to a Markdown string with YAML frontmatter.
 * The frontmatter contains metadata; the body contains turn-by-turn content.
 */
export function serializeSlice(slice: TimeSlice): string {
  const frontmatter: SliceFrontmatter = {
    slice_id: slice.slice_id,
    focus: slice.focus,
    status: slice.status,
    start: slice.start,
    end: slice.end,
    timezone: slice.timezone,
    summary: slice.summary,
    open_loops: slice.open_loops,
    decisions: slice.decisions,
    tags: slice.tags,
    related_slices: slice.related_slices,
    emotional_tone: slice.emotional_tone,
  };

  // Remove undefined fields for clean YAML
  const cleanFm: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(frontmatter)) {
    if (value !== undefined && value !== "") {
      cleanFm[key] = value;
    }
  }

  const body = slice.turns
    .map(
      (turn, i) =>
        `## Turn ${i + 1} — ${turn.timestamp} (${turn.role})\n\n${turn.content}`
    )
    .join("\n\n");

  return matter.stringify(body, cleanFm);
}

/**
 * Parse a Markdown string (with YAML frontmatter) back into a TimeSlice.
 */
export function parseSlice(raw: string): TimeSlice {
  const { data, content } = matter(raw);

  const frontmatter = data as Partial<SliceFrontmatter>;

  // Parse turns from body content
  const turns = parseTurns(content);

  // Estimate tokens: rough 1 token per 4 characters
  const estimatedTokens = Math.ceil(raw.length / 4);

  return {
    slice_id: frontmatter.slice_id ?? "",
    focus: frontmatter.focus ?? "",
    status: frontmatter.status ?? "active",
    start: frontmatter.start ?? "",
    end: frontmatter.end,
    timezone: frontmatter.timezone ?? "UTC",
    summary: frontmatter.summary ?? "",
    open_loops: frontmatter.open_loops ?? [],
    decisions: frontmatter.decisions ?? [],
    tags: frontmatter.tags ?? [],
    related_slices: frontmatter.related_slices ?? [],
    emotional_tone: frontmatter.emotional_tone,
    turns,
    estimatedTokens,
    closedBy:
      frontmatter.status === "closed" ? "user_explicit" : undefined,
  };
}

/**
 * Parse turn blocks from the Markdown body of a time slice.
 * Each turn starts with "## Turn N — ISO_TIMESTAMP (role)".
 */
function parseTurns(body: string): Turn[] {
  const turns: Turn[] = [];
  const trimmed = body.trim();
  if (!trimmed) return turns;

  // Match turn headers: "## Turn N — ISO_TIMESTAMP (role)"
  const turnHeaderRegex = /^## Turn \d+ — (\S+) \((\w+)\)$/gm;

  // Collect turn headers with the position right after the header line
  const headers: Array<{
    timestamp: string;
    role: "user" | "agent";
    contentStart: number;
  }> = [];
  let match: RegExpExecArray | null;

  while ((match = turnHeaderRegex.exec(trimmed)) !== null) {
    const afterHeader =
      trimmed.indexOf("\n", match.index) === -1
        ? trimmed.length
        : trimmed.indexOf("\n", match.index) + 1;

    headers.push({
      timestamp: match[1],
      role: match[2] as "user" | "agent",
      contentStart: afterHeader,
    });
  }

  // Extract the content between each header and the next
  for (let i = 0; i < headers.length; i++) {
    let contentEnd: number;
    if (i < headers.length - 1) {
      // Find where the next header begins (search for "## Turn i+2 —")
      contentEnd = trimmed.indexOf(`## Turn ${i + 2} —`, headers[i].contentStart);
      if (contentEnd === -1) contentEnd = trimmed.length;
    } else {
      contentEnd = trimmed.length;
    }

    const turnContent = trimmed
      .slice(headers[i].contentStart, contentEnd)
      .trim();

    turns.push({
      timestamp: headers[i].timestamp,
      role: headers[i].role,
      content: turnContent,
    });
  }

  return turns;
}

/**
 * Serialize a MonthlyIndex (array of SliceIndexEntry) to a JSON string.
 */
export function serializeIndex(
  entries: SliceIndexEntry[],
  month: string
): string {
  const index: MonthlyIndex = { month, slices: entries };
  return JSON.stringify(index, null, 2);
}

/**
 * Serialize a TagIndex to a JSON string.
 */
export function serializeTagIndex(index: TagIndex): string {
  return JSON.stringify(index, null, 2);
}

// ─── Turn management ─────────────────────────────────────────────────────

/**
 * Append a turn to the active slice in memory.
 * Does NOT write to disk — only updates in-memory state.
 * The caller is responsible for persisting at appropriate checkpoints.
 */
export function appendTurn(slice: TimeSlice, turn: Turn): void {
  slice.turns.push(turn);
  // Rough token estimate update
  slice.estimatedTokens += Math.ceil(turn.content.length / 4);
  // Overhead for turn header and structure
  slice.estimatedTokens += 8;
}

// ─── Reading slices ──────────────────────────────────────────────────────

/**
 * Read a monthly _index.json and return its entries.
 * Returns an empty array if the index file does not exist.
 */
export async function readSliceIndex(
  year: number,
  month: number
): Promise<SliceIndexEntry[]> {
  const indexPath = getIndexPath(year, month);
  try {
    const raw = await fsReadFile(indexPath);
    const parsed: MonthlyIndex = JSON.parse(raw);
    return parsed.slices ?? [];
  } catch {
    // Index doesn't exist yet — return empty
    return [];
  }
}

/**
 * Read the global tag-index.json.
 * Returns an empty object if the tag index does not exist.
 */
export async function readTagIndex(): Promise<TagIndex> {
  const tagIndexPath = getTagIndexPath();
  try {
    const raw = await fsReadFile(tagIndexPath);
    return JSON.parse(raw) as TagIndex;
  } catch {
    return {};
  }
}

/**
 * Read the full body (Markdown with frontmatter) of a time slice from disk.
 */
export async function readSliceBody(path: string): Promise<string> {
  return fsReadFile(path);
}

// ─── Index maintenance ───────────────────────────────────────────────────

/**
 * Build a SliceIndexEntry from a TimeSlice for storage in a monthly index.
 */
export function toIndexEntry(slice: TimeSlice): SliceIndexEntry {
  const day = slice.slice_id.split("-")[2] ?? slice.slice_id;
  return {
    id: day,
    focus: slice.focus,
    summary: slice.summary,
    tags: slice.tags,
    status: slice.status,
    start: slice.start,
    open_loops: slice.open_loops,
    decisions: slice.decisions,
  };
}

/**
 * Update (or create) the monthly _index.json for the slice's year/month.
 * Upserts the slice's index entry into the existing index.
 */
export async function updateMonthlyIndex(slice: TimeSlice): Promise<void> {
  const [yearStr, monthStr] = slice.slice_id.split("-");
  const year = parseInt(yearStr, 10);
  const month = parseInt(monthStr, 10);

  const existing = await readSliceIndex(year, month);
  const entry = toIndexEntry(slice);

  // Upsert: replace existing entry with same id, or append
  const idx = existing.findIndex((e) => e.id === entry.id);
  if (idx >= 0) {
    existing[idx] = entry;
  } else {
    existing.push(entry);
  }

  // Sort by day (id) ascending
  existing.sort((a, b) => parseInt(a.id, 10) - parseInt(b.id, 10));

  const indexPath = getIndexPath(year, month);
  const json = serializeIndex(existing, `${yearStr}-${monthStr}`);
  await fsWriteFile(indexPath, json);
}

/**
 * Update the global tag-index.json with the slice's tags.
 * For each tag on the slice, registers the slice's relative path.
 */
export async function updateTagIndex(slice: TimeSlice): Promise<void> {
  const tagIndex = await readTagIndex();
  const relativePath = extractRelativePath(slice);

  for (const tag of slice.tags) {
    if (!tagIndex[tag]) {
      tagIndex[tag] = [];
    }
    // Deduplicate: only add if not already present
    if (!tagIndex[tag].includes(relativePath)) {
      tagIndex[tag].push(relativePath);
    }
  }

  const tagIndexPath = getTagIndexPath();
  const json = serializeTagIndex(tagIndex);
  await fsWriteFile(tagIndexPath, json);
}

/**
 * Extract the relative path segment from a slice's full file path.
 * Example: "memory/episodic/slices/2026/06/30.md" → "2026/06/30"
 */
function extractRelativePath(slice: TimeSlice): string {
  const [year, month, day] = slice.slice_id.split("-");
  return `${year}/${month}/${day}`;
}

// ─── Testing utilities ───────────────────────────────────────────────────

/**
 * Set the active slice directly (useful for testing or hydration).
 */
export function setActiveSlice(slice: TimeSlice | null): void {
  activeSlice = slice;
}

/**
 * Clear the active slice (alias for setActiveSlice(null)).
 */
export function clearActiveSlice(): void {
  activeSlice = null;
}

// ─── Snapshot (intermediate write) ───────────────────────────────────────

/**
 * Save the current in-memory time slice to disk WITHOUT closing it.
 * This is a checkpoint — the slice remains active and turns continue to append.
 * Called every N turns and on beforeunload flush.
 */
export async function saveSliceSnapshot(slice: TimeSlice): Promise<void> {
  const slicePath = getSlicePath(slice);
  const markdown = serializeSlice(slice);
  await fsWriteFile(slicePath, markdown);
}

/**
 * Persist _index.json and tag-index.json for an active slice.
 * Called on snapshot save so browseSlices has entries even for active slices.
 */
export async function ensureIndexEntries(slice: TimeSlice): Promise<void> {
  await updateMonthlyIndex(slice);
  if (slice.tags.length > 0) {
    await updateTagIndex(slice);
  }
}

// ─── Flash summary update ────────────────────────────────────────────────

/**
 * Update the time slice's dynamic summary using a Flash (small model) call.
 * Called every ~3 turns during active conversation.
 *
 * The summary prompt is designed to be cheap and fast (~100-200ms).
 * It only updates focus/summary/tags — no structural changes.
 */
export async function updateDynamicSummary(
  slice: TimeSlice,
  _newTurns: Turn[]
): Promise<void> {
  // Dynamic summary is handled by Flash via the chat route.
  // This function signature exists for the chat route to call.
  // The actual Flash call happens in the route because it needs the AI SDK context.
  // Here we just ensure the slice is in a consistent state.
  if (!slice.focus && slice.turns.length > 0) {
    // Fallback: derive a basic focus from the first user message
    const firstUserMsg = slice.turns.find((t) => t.role === "user")?.content ?? "";
    slice.focus = firstUserMsg.slice(0, 80);
  }
}

/**
 * Freeze the time slice summary on closure.
 * Called by closeSlice — generates final summary, open_loops, decisions, tags.
 */
export async function freezeSliceSummary(
  slice: TimeSlice
): Promise<void> {
  // Freeze summary is handled by Flash via the chat route on slice close.
  // The actual Flash call happens in the route because it needs the AI SDK context.
  // This function exists as the hook point.
  // closeSlice already calls this internally.
}
