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
import {
  readFileDemo,
  listFilesDemo,
  writeFileDemo,
  getDemoPersona,
} from "@/lib/demo/demo-fs";
import { resolveDataSource, isDemo } from "@/lib/data-source/resolve";
import { getRepoConfig } from "@/lib/capabilities";
import type {
  TimeSlice,
  Turn,
  SlicingSignal,
  SliceIndexEntry,
  SliceFrontmatter,
  MonthlyIndex,
  StrandIndex,
} from "./types";

// ─── Environment detection ───────────────────────────────────────────────

const DATA_SOURCE = resolveDataSource();
const USE_GITHUB = DATA_SOURCE === "github";
const USE_DEMO = DATA_SOURCE === "demo";

// Demo data is static (writes are no-op'd), so reads can be cached hard.
const DEMO_MODE = isDemo(DATA_SOURCE);

// ─── Internal I/O helpers ────────────────────────────────────────────────

async function fsReadFile(path: string): Promise<string> {
  if (DEMO_MODE) return readFileDemo(path);
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
  if (DEMO_MODE) return writeFileDemo(path, content);
  if (USE_GITHUB) {
    const { owner, repo } = getRepoConfig();
    return writeFileGitHub(path, content, repo, owner);
  }
  return writeFileLocal(path, content);
}

async function fsListFiles(
  path: string
): Promise<Array<{ name: string; type: "file" | "dir"; path: string }>> {
  if (DEMO_MODE) return listFilesDemo(path);
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
export function createSlice(userMessage: string, timezone: string, turnId: string): TimeSlice {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  const day = String(now.getUTCDate()).padStart(2, "0");
  const hh = String(now.getUTCHours()).padStart(2, "0");
  const mm = String(now.getUTCMinutes()).padStart(2, "0");
  const sliceId = `${year}-${month}-${day}-${hh}${mm}`;
  const start = now.toISOString();

  const firstTurn: Turn = {
    timestamp: start,
    role: "user",
    content: userMessage,
    turnId,
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
    loops: [],
    turns: [firstTurn],
    estimatedTokens: Math.ceil(userMessage.length / 4),
  };

  activeSlice = slice;
  return slice;
}

/**
 * Try to recover today's active time slice from disk/GitHub.
 * Used on page refresh — a day is a directory of slice files (DD/HHMM.md),
 * so we scan today's directory and return the most recent slice that is still
 * `active`. Returns null if the directory is missing or holds no active slice.
 */
export async function tryLoadTodaySlice(): Promise<TimeSlice | null> {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  const day = String(now.getUTCDate()).padStart(2, "0");
  const dir = `memory/episodic/slices/${year}/${month}/${day}`;

  try {
    const entries = await fsListFiles(dir);

    // NEW format: slice directories (HHMM/) containing timeline/core.md
    const sliceDirs = entries
      .filter((e) => e.type === "dir")
      .sort((a, b) => b.name.localeCompare(a.name));

    for (const d of sliceDirs) {
      try {
        const corePath = `${dir}/${d.name}/timeline/core.md`;
        const raw = await fsReadFile(corePath);
        const slice = parseSlice(raw);
        if (slice.status === "active") return slice;
      } catch {
        // core.md may not exist in this directory yet — skip
      }
    }

    // BACKWARD COMPAT: flat .md files (old format)
    const files = entries
      .filter((e) => e.type === "file" && e.name.endsWith(".md"))
      .sort((a, b) => b.name.localeCompare(a.name));

    for (const f of files) {
      const raw = await fsReadFile(f.path);
      const slice = parseSlice(raw);
      if (slice.status === "active") return slice;
    }
    return null;
  } catch {
    return null;
  }
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
  await updateStrands(slice);

  // Clear active if this was the active slice
  if (activeSlice?.slice_id === slice.slice_id) {
    activeSlice = null;
  }

  return slice;
}

// ─── Path computation ────────────────────────────────────────────────────

/**
 * Derive the slices-relative path (no `slices/` prefix, no `.md`) from a slice_id.
 * New format:  `YYYY-MM-DD-HHMM` → `YYYY/MM/DD/HHMM`
 * Legacy:      `YYYY-MM-DD`      → `YYYY/MM/DD`   (kept for robustness)
 */
export function sliceIdToRelPath(sliceId: string): string {
  const p = sliceId.split("-");
  return p.length >= 4
    ? `${p[0]}/${p[1]}/${p[2]}/${p[3]}`
    : `${p[0]}/${p[1]}/${p[2]}`;
}

/**
 * Compute the path to the slice's timeline directory (no trailing file).
 * New format: memory/episodic/slices/YYYY/MM/DD/HHMM/timeline/
 */
export function sliceIdToTimelineDir(sliceId: string): string {
  return `memory/episodic/slices/${sliceIdToRelPath(sliceId)}/timeline`;
}

/**
 * Compute the file path for core.md (the shared conversation record).
 * New format: memory/episodic/slices/YYYY/MM/DD/HHMM/timeline/core.md
 */
export function sliceIdToFilePath(sliceId: string): string {
  return `${sliceIdToTimelineDir(sliceId)}/core.md`;
}

/**
 * Compute the file path for agent.md (the agent's internal cognitive record).
 * New format: memory/episodic/slices/YYYY/MM/DD/HHMM/timeline/agent.md
 */
export function sliceIdToAgentPath(sliceId: string): string {
  return `${sliceIdToTimelineDir(sliceId)}/agent.md`;
}

/**
 * Legacy flat-file path for backward compatibility.
 * Old format: memory/episodic/slices/YYYY/MM/DD/HHMM.md
 */
export function sliceIdToLegacyFilePath(sliceId: string): string {
  return `memory/episodic/slices/${sliceIdToRelPath(sliceId)}.md`;
}

/**
 * Compute the file path for the active time slice's core.md.
 */
export function getSlicePath(slice: TimeSlice): string {
  return sliceIdToFilePath(slice.slice_id);
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
 * Get the path to the global strands.json file (the keyword→slice index).
 */
export function getStrandsPath(): string {
  return "memory/episodic/strands.json";
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
    loops: slice.loops,
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
      (turn) =>
        `## Turn ${turn.turnId ?? "?"} — ${turn.timestamp} (${turn.role})\n\n${turn.content}`
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
    loops: frontmatter.loops ?? [],
    emotional_tone: frontmatter.emotional_tone,
    turns,
    estimatedTokens,
    closedBy:
      frontmatter.status === "closed" ? "user_explicit" : undefined,
  };
}

/**
 * Parse turn blocks from the Markdown body of a time slice.
 * Each turn starts with "## Turn {turnId} — ISO_TIMESTAMP (role)" (new) or
 * "## Turn N — ISO_TIMESTAMP (role)" (legacy, numeric index only).
 */
function parseTurns(body: string): Turn[] {
  const turns: Turn[] = [];
  const trimmed = body.trim();
  if (!trimmed) return turns;

  // Match both old and new formats:
  // New: ## Turn a3fk2w — ISO (role)
  // Legacy: ## Turn 1 — ISO (role)
  const turnHeaderRegex = /^## Turn (\S+) — (\S+) \((\w+)\)$/gm;

  // Collect turn headers with the position right after the header line
  const headers: Array<{
    turnLabel: string;
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
      turnLabel: match[1],
      timestamp: match[2],
      role: match[3] as "user" | "agent",
      contentStart: afterHeader,
    });
  }

  // Extract the content between each header and the next.
  // Search for "## Turn " as a generic delimiter — no longer relies on
  // sequential numeric indices (which don't exist with base64url turnIds).
  for (let i = 0; i < headers.length; i++) {
    const nextHeaderIdx = trimmed.indexOf("## Turn ", headers[i].contentStart);
    const contentEnd = nextHeaderIdx !== -1 ? nextHeaderIdx : trimmed.length;

    const turnContent = trimmed
      .slice(headers[i].contentStart, contentEnd)
      .trim();

    // Distinguish: numeric label → legacy format (no turnId), base64url → new
    const isNumeric = /^\d+$/.test(headers[i].turnLabel);

    turns.push({
      timestamp: headers[i].timestamp,
      role: headers[i].role,
      content: turnContent,
      ...(isNumeric ? {} : { turnId: headers[i].turnLabel }),
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
 * Serialize a StrandIndex to a JSON string.
 */
export function serializeStrands(index: StrandIndex): string {
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
async function readSliceIndexRaw(
  year: number,
  month: number
): Promise<SliceIndexEntry[]> {
  const indexPath = getIndexPath(year, month);
  try {
    const raw = await fsReadFile(indexPath);
    const parsed: MonthlyIndex = JSON.parse(raw);
    return parsed.slices ?? [];
  } catch {
    return [];
  }
}

// Persona-aware in-memory cache for demo mode. Keyed by persona + path so
// switching personas doesn't return stale data from the previous persona's
// cache. TTL: 1 hour (demo data is static; remote fetches have their own
// manifest-level cache in demo-fs.ts).

const _indexCache = new Map<string, { data: SliceIndexEntry[]; ttl: number }>();
const _bodyCache = new Map<string, { data: string; ttl: number }>();

function cacheGet<T>(store: Map<string, { data: T; ttl: number }>, key: string): T | null {
  const entry = store.get(key);
  if (entry && Date.now() < entry.ttl) return entry.data;
  store.delete(key);
  return null;
}

function cacheSet<T>(store: Map<string, { data: T; ttl: number }>, key: string, data: T): void {
  store.set(key, { data, ttl: Date.now() + 3_600_000 }); // 1 hour
}

export async function readSliceIndex(
  year: number,
  month: number
): Promise<SliceIndexEntry[]> {
  if (DEMO_MODE) {
    const key = `${getDemoPersona()}:idx:${year}:${month}`;
    const cached = cacheGet(_indexCache, key);
    if (cached) return cached;
    const data = await readSliceIndexRaw(year, month);
    cacheSet(_indexCache, key, data);
    return data;
  }
  return readSliceIndexRaw(year, month);
}

/**
 * Read the global strands.json (keyword→slice index).
 * Returns an empty object if the strand index does not exist.
 */
export async function readStrands(): Promise<StrandIndex> {
  const strandsPath = getStrandsPath();
  try {
    const raw = await fsReadFile(strandsPath);
    return JSON.parse(raw) as StrandIndex;
  } catch {
    return {};
  }
}

/**
 * Read the full body (Markdown with frontmatter) of a time slice from disk.
 */
export async function readSliceBody(path: string): Promise<string> {
  if (DEMO_MODE) {
    const key = `${getDemoPersona()}:body:${path}`;
    const cached = cacheGet(_bodyCache, key);
    if (cached) return cached;
    const data = await fsReadFile(path);
    cacheSet(_bodyCache, key, data);
    return data;
  }
  return fsReadFile(path);
}

// ─── Index maintenance ───────────────────────────────────────────────────

/**
 * Build a SliceIndexEntry from a TimeSlice for storage in a monthly index.
 */
export function toIndexEntry(slice: TimeSlice): SliceIndexEntry {
  return {
    id: slice.slice_id,
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

  // Sort by id ascending (YYYY-MM-DD-HHMM format sorts correctly as string)
  existing.sort((a, b) => a.id.localeCompare(b.id));

  const indexPath = getIndexPath(year, month);
  const json = serializeIndex(existing, `${yearStr}-${monthStr}`);
  await fsWriteFile(indexPath, json);
}

/**
 * Weave the slice's tags into the global strands.json (keyword→slice index).
 * Each tag on the slice is a strand; register the slice's relative path under it.
 */
export async function updateStrands(slice: TimeSlice): Promise<void> {
  const strands = await readStrands();
  const relativePath = extractRelativePath(slice);

  for (const tag of slice.tags) {
    if (!strands[tag]) {
      strands[tag] = [];
    }
    // Deduplicate: only add if not already present
    if (!strands[tag].includes(relativePath)) {
      strands[tag].push(relativePath);
    }
  }

  const strandsPath = getStrandsPath();
  const json = serializeStrands(strands);
  await fsWriteFile(strandsPath, json);
}

/**
 * Extract the relative path segment from a slice's id (used by the tag index).
 * Example: "2026-06-30-1430" → "2026/06/30/1430"
 */
function extractRelativePath(slice: TimeSlice): string {
  return sliceIdToRelPath(slice.slice_id);
}

// ─── Agent timeline I/O ──────────────────────────────────────────────────

/**
 * Serialize a single cognition entry for the agent timeline (agent.md).
 *
 * The agent timeline stores cognitive process, not raw tool results:
 * reasoning, per-tool intent + assessment, and a self-check.
 */
export function serializeAgentTimeline(input: {
  turnId: string;
  timestamp: string;
  reasoning: string;
  toolCalls: Array<{ toolName: string; intent: string; assessment: string }>;
  selfCheck: string;
}): string {
  const header = `## Cognition ${input.turnId} — ${input.timestamp}`;
  const reasoning = `\n### Reasoning\n${input.reasoning}\n`;
  const steps =
    input.toolCalls.length > 0
      ? `\n${input.toolCalls
          .map(
            (tc) =>
              `### Step: \`${tc.toolName}\`\n- **intent**: ${tc.intent}\n- **assessment**: ${tc.assessment}`
          )
          .join("\n\n")}\n`
      : "";
  const selfCheck = `\n### Self-check\n${input.selfCheck}`;
  return header + reasoning + steps + selfCheck;
}

/**
 * Write (append) a cognition entry to the agent's timeline for a slice.
 * Reads the existing agent.md (if any) and appends the new entry.
 */
export async function writeAgentTimeline(
  sliceId: string,
  cognitionContent: string,
): Promise<{ path: string; created: boolean }> {
  const agentPath = sliceIdToAgentPath(sliceId);
  let existing = "";
  try {
    existing = await fsReadFile(agentPath);
  } catch {
    // File doesn't exist yet — will be created
  }
  const fullContent = existing.trimEnd()
    ? existing.trimEnd() + "\n\n" + cognitionContent
    : cognitionContent;
  return fsWriteFile(agentPath, fullContent);
}

/**
 * Read the agent's cognitive timeline for a slice.
 * Returns empty string if agent.md doesn't exist.
 */
export async function readAgentTimeline(sliceId: string): Promise<string> {
  try {
    return await fsReadFile(sliceIdToAgentPath(sliceId));
  } catch {
    return "";
  }
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
 * Persist _index.json and strands.json for an active slice.
 * Called on snapshot save so browseSlices has entries even for active slices.
 */
export async function ensureIndexEntries(slice: TimeSlice): Promise<void> {
  await updateMonthlyIndex(slice);
  if (slice.tags.length > 0) {
    await updateStrands(slice);
  }
}
