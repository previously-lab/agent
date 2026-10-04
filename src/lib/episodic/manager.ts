/**
 * Episodic Memory Manager — core CRUD for time slices.
 *
 * Tracks the active time slice in memory, computes file paths, and serializes
 * slices to Markdown (YAML frontmatter + turns body). The monthly index and
 * tag-index projections are retired (v0.19 §A.2.4) — readers live-enumerate
 * the records tree.
 *
 * All file I/O delegates to the existing tools layer, which handles the
 * local-dev vs GitHub-production switch transparently.
 */
import matter from "gray-matter";
import type {
  TimeSlice,
  Turn,
  SlicingSignal,
  SliceFrontmatter,
  StrandIndex,
} from "./types";
import {
  fsReadFile,
  fsWriteFile,
  fsListFiles,
  type WriteBatch,
} from "./io-helpers";
import {
  dayDirForDate,
  readSlicePart,
  slicePartPath,
  RECORDS_ROOT,
  LEGACY_SLICES_ROOT,
} from "./paths";
import {
  newCardTemplate,
  migrateToV3,
  migrateV3ToCard,
  isCardFormat,
} from "./previously-format";

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
 *
 * `continuesFrom` links the slice to the one it continues — set only when the
 * previous slice closed on a time_cap/capacity CHECKPOINT (the same ongoing
 * conversation), never on idle_gap/context_lost (a genuine new conversation).
 */
export function createSlice(userMessage: string, timezone: string, turnId: string, continuesFrom?: string): TimeSlice {
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
    ...(continuesFrom ? { continuesFrom } : {}),
  };

  activeSlice = slice;
  return slice;
}

/**
 * Try to recover today's active time slice from disk/GitHub.
 * Used on page refresh — a day is a directory of slice directories (HHMM/),
 * so we scan today's directory and return the most recent slice that is still
 * `active`. Returns null if the directory is missing or holds no active slice.
 *
 * Dual-root (v0.19 R2): the new records root is scanned first, the legacy
 * slices root on a miss — a still-active slice created before the root move
 * must stay recoverable.
 */
export async function tryLoadTodaySlice(
  batch?: WriteBatch
): Promise<TimeSlice | null> {
  const now = new Date();
  // A conversation that crosses the UTC day boundary (00:00 UTC = 08:00 in
  // UTC+8 — morning chats) lives in YESTERDAY's directory. Without this
  // fallback the still-active slice is orphaned: never recovered, never
  // closed, never reviewed by evolution.
  const dates = [now, new Date(now.getTime() - 86_400_000)];
  for (const d of dates) {
    for (const root of [RECORDS_ROOT, LEGACY_SLICES_ROOT] as const) {
      const found = await scanDirForActiveSlice(
        dayDirForDate(root, d),
        root === LEGACY_SLICES_ROOT,
        batch,
      );
      if (found) return found;
    }
  }
  return null;
}

/**
 * Scan one day directory for the most recent slice still marked `active`.
 * `legacyLayout` selects the on-disk shape: the new records layout is flat
 * (`HHMM/core.md`); the legacy layout nests under `HHMM/timeline/core.md` and
 * may also hold ancient flat `HHMM.md` files.
 */
async function scanDirForActiveSlice(
  dir: string,
  legacyLayout: boolean,
  batch?: WriteBatch
): Promise<TimeSlice | null> {
  try {
    const entries = await fsListFiles(dir);

    const sliceDirs = entries
      .filter((e) => e.type === "dir")
      .sort((a, b) => b.name.localeCompare(a.name));

    for (const d of sliceDirs) {
      try {
        const corePath = legacyLayout
          ? `${dir}/${d.name}/timeline/core.md`
          : `${dir}/${d.name}/core.md`;
        const raw = await fsReadFile(corePath, batch);
        const slice = parseSlice(raw);
        if (slice.status === "active") return slice;
      } catch {
        // core.md may not exist in this directory yet — skip
      }
    }

    if (!legacyLayout) return null;

    // BACKWARD COMPAT: flat .md files (ancient legacy format)
    const files = entries
      .filter((e) => e.type === "file" && e.name.endsWith(".md"))
      .sort((a, b) => b.name.localeCompare(a.name));

    for (const f of files) {
      const raw = await fsReadFile(f.path, batch);
      const slice = parseSlice(raw);
      if (slice.status === "active") return slice;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Close the active time slice, persisting it to disk. Returns the closed
 * slice.
 */
export async function closeSlice(
  slice: TimeSlice,
  signal: SlicingSignal,
  batch?: WriteBatch
): Promise<TimeSlice> {
  slice.status = "closed";
  // The end of the conversation is the LAST TURN's timestamp, not the moment
  // this close executes — closes are lazy (the age cap is detected when the
  // NEXT session arrives, possibly hours later), so stamping "now" would
  // fabricate a false end and zero out the continuity gap.
  slice.end = slice.turns.at(-1)?.timestamp ?? new Date().toISOString();
  slice.closedBy = signal;

  // Persist the closed slice body to disk. The monthly `_index.json` and
  // `strands.json` projections are RETIRED (design v0.19 §A.2.4/§B.5): no
  // index maintenance runs here anymore — readers live-enumerate the records
  // tree instead.
  const slicePath = getSlicePath(slice);
  const markdown = serializeSlice(slice);
  await fsWriteFile(slicePath, markdown, batch);

  // Clear active if this was the active slice
  if (activeSlice?.slice_id === slice.slice_id) {
    activeSlice = null;
  }

  return slice;
}

// ─── Path computation ────────────────────────────────────────────────────

// The roots and the dual-root read probes live in ./paths (v0.19 R2: records
// moved to `memory/records/`, writes go there only, reads dual-probe the
// legacy `memory/episodic/slices/` root). The builders below are the WRITE
// targets — all new-root; `sliceIdToRelPath` is re-exported from ./paths.
export { sliceIdToRelPath } from "./paths";

/**
 * Compute the file path for core.md (the shared conversation record).
 * New layout (flat, no timeline/ level): memory/records/YYYY/MM/DD/HHMM/core.md
 */
export function sliceIdToFilePath(sliceId: string): string {
  return slicePartPath(sliceId, "core");
}

/**
 * Compute the file path for agent.md (the agent's internal cognitive record).
 * New layout: memory/records/YYYY/MM/DD/HHMM/agent.md
 */
export function sliceIdToAgentPath(sliceId: string): string {
  return slicePartPath(sliceId, "agent");
}

/**
 * Compute the file path for previously.md (the agent's belief system about
 * the user). New layout: memory/records/YYYY/MM/DD/HHMM/previously.md
 */
export function sliceIdToPreviouslyPath(sliceId: string): string {
  return slicePartPath(sliceId, "previously");
}

/**
 * Compute the file path for the active time slice's core.md.
 */
export function getSlicePath(slice: TimeSlice): string {
  return sliceIdToFilePath(slice.slice_id);
}

// ─── Serialization ───────────────────────────────────────────────────────

/**
 * Serialize a TimeSlice to a Markdown string with YAML frontmatter.
 * The frontmatter contains metadata; the body contains turn-by-turn content.
 *
 * v0.19 R2 header slimming: `status` / `tags` / `related_slices` are NEVER
 * written anymore — status derives from `closed_by` (F 状态即记录), tags and
 * related_slices die with the projection layer. Legacy keys are still
 * tolerated on READ (see parseSlice).
 */
export function serializeSlice(slice: TimeSlice): string {
  const frontmatter: Omit<SliceFrontmatter, "status" | "tags" | "related_slices"> = {
    slice_id: slice.slice_id,
    focus: slice.focus,
    start: slice.start,
    end: slice.end,
    timezone: slice.timezone,
    summary: slice.summary,
    open_loops: slice.open_loops,
    decisions: slice.decisions,
    loops: slice.loops,
    emotional_tone: slice.emotional_tone,
    closed_by: slice.closedBy,
    evolution_summary: slice.evolutionSummary,
    continues_from: slice.continuesFrom,
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

/** Coerce a value that should be a string — YAML unquoted values with ": "
 *  can be parsed as objects by gray-matter. */
function normalizeString(v: unknown): string {
  if (typeof v === "string") return v;
  if (v && typeof v === "object") return Object.keys(v)[0] ?? "";
  return "";
}

/** Coerce an array where every entry should be a string. */
function normalizeStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((e) => (typeof e === "string" ? e : normalizeString(e)));
}

export function parseSlice(raw: string): TimeSlice {
  const { data, content } = matter(raw);

  const frontmatter = data as Partial<SliceFrontmatter>;

  // Parse turns from body content
  const turns = parseTurns(content);

  // Estimate tokens: rough 1 token per 4 characters
  const estimatedTokens = Math.ceil(raw.length / 4);

  // Normalize open_loops / decisions — YAML unquoted values containing ": "
  // (e.g. "Draft guide on the model: retention chain") are parsed as
  // key-value objects by gray-matter instead of strings. Coerce every
  // entry to a string so React rendering never receives an object.
  const open_loops = normalizeStringArray(frontmatter.open_loops);
  const decisions = normalizeStringArray(frontmatter.decisions);
  const tags = normalizeStringArray(frontmatter.tags);

  // v0.19 R2 read shim: `status` is DERIVED, never written — a `closed_by`
  // cause means closed, its absence means active. Legacy slices carry an
  // explicit `status`; a legacy closed slice without `closed_by` falls back
  // to user_explicit. Consumers keep reading `status` unchanged until R3.
  const closedBy = isSlicingSignal(frontmatter.closed_by)
    ? frontmatter.closed_by
    : frontmatter.status === "closed"
      ? "user_explicit"
      : undefined;

  return {
    slice_id: frontmatter.slice_id ?? "",
    focus: normalizeString(frontmatter.focus) ?? "",
    status: frontmatter.status ?? (closedBy ? "closed" : "active"),
    start: frontmatter.start ?? "",
    end: frontmatter.end,
    timezone: frontmatter.timezone ?? "UTC",
    summary: normalizeString(frontmatter.summary) ?? "",
    open_loops,
    decisions,
    tags,
    related_slices: normalizeStringArray(frontmatter.related_slices),
    loops: normalizeStringArray(frontmatter.loops),
    emotional_tone: frontmatter.emotional_tone as SliceFrontmatter["emotional_tone"],
    // v0.9: evolution summary frozen at slice birth, replayed into the L3
    // slice-head block on every turn of this slice (byte-stable prompt).
    evolutionSummary: normalizeString(frontmatter.evolution_summary) || undefined,
    // The checkpoint continuation link (a slice born from a time_cap/capacity
    // close of the same conversation) — drives the carry-over history prefix.
    continuesFrom: normalizeString(frontmatter.continues_from) || undefined,
    turns,
    estimatedTokens,
    closedBy,
  };
}

const SLICING_SIGNALS: readonly SlicingSignal[] = [
  "time_cap",
  // Legacy (pre-v0.9): inactivity-based closing. Kept so historical slices
  // with closed_by: time_silence are not misread as user_explicit.
  "time_silence",
  "user_explicit",
  "capacity",
  "context_lost",
  "idle_gap",
];

function isSlicingSignal(v: unknown): v is SlicingSignal {
  return typeof v === "string" && (SLICING_SIGNALS as readonly string[]).includes(v);
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

// There is no cache here. Demo mode used to keep persona-keyed `_indexCache` /
// `_bodyCache` Maps over the slice reads below; they are gone (v0.10) because
// the demo backend is now cached where the read actually happens
// (`demo-fs.ts` → the Data Cache, 30-day demo TTL), and a second cache on top
// of a tagged one is strictly worse: a write revalidates the tag, which a
// module-level Map never hears about, so the Map keeps serving the pre-write
// bytes for the rest of its TTL. Persona separation is preserved — the Data
// Cache identity carries the persona (see `readFileDemo`), which is exactly
// what the Maps' `${persona}:` key prefix was for.

/**
 * Read the global strands.json (keyword→slice index) — the RETIRED strand
 * projection, kept only for the game's legacy read path (actions.ts).
 * Returns an empty object if the strand index does not exist.
 */
export async function readStrands(batch?: WriteBatch): Promise<StrandIndex> {
  try {
    const raw = await fsReadFile("memory/episodic/strands.json", batch);
    return JSON.parse(raw) as StrandIndex;
  } catch {
    return {};
  }
}

/**
 * Read the full body (Markdown with frontmatter) of a time slice from disk.
 * Takes a literal path — id-based dual-root reads go through
 * `readSlicePart(sliceId, "core")` in ./paths.
 */
export async function readSliceBody(path: string): Promise<string> {
  return fsReadFile(path);
}

/**
 * Load any slice (active or closed) by id — best-effort, null when the file
 * is missing or unreadable. Used for the checkpoint carry-over: a slice born
 * from a time_cap/capacity close re-reads its `continuesFrom` predecessor so
 * its tail can be prepended to the history window.
 */
export async function loadSlice(
  sliceId: string,
  batch?: WriteBatch,
): Promise<TimeSlice | null> {
  try {
    const raw = await readSlicePart(sliceId, "core", batch);
    return parseSlice(raw);
  } catch {
    return null;
  }
}

// ─── Index maintenance ───────────────────────────────────────────────────
// RETIRED (v0.19 §A.2.4/§B.5): the monthly `_index.json` and `strands.json`
// projection writers lived here. Readers live-enumerate the records tree.

// ─── Agent timeline I/O ──────────────────────────────────────────────────

/**
 * Write (append) a cognition entry to the agent's timeline for a slice.
 * Reads the existing agent.md (if any) and appends the new entry.
 */
export async function writeAgentTimeline(
  sliceId: string,
  cognitionContent: string,
  batch?: WriteBatch,
): Promise<{ path: string; created: boolean }> {
  const agentPath = sliceIdToAgentPath(sliceId);
  let existing = "";
  try {
    // Dual-root read: an agent.md created before the root move still seeds
    // the append; the write itself always lands on the new root.
    existing = await readSlicePart(sliceId, "agent", batch);
  } catch {
    // File doesn't exist yet — will be created
  }
  const fullContent = existing.trimEnd()
    ? existing.trimEnd() + "\n\n" + cognitionContent
    : cognitionContent;
  return fsWriteFile(agentPath, fullContent, batch);
}

/**
 * Read the agent's cognitive timeline for a slice (dual-root).
 * Returns empty string if agent.md doesn't exist.
 */
export async function readAgentTimeline(sliceId: string): Promise<string> {
  try {
    return await readSlicePart(sliceId, "agent");
  } catch {
    return "";
  }
}

// ─── Previously.md I/O ────────────────────────────────────────────────────

/** Empty previously.md template for slices with no prior beliefs (v3). */
export function emptyPreviouslyTemplate(sliceId: string): string {
  return newCardTemplate(sliceId);
}

/**
 * Read the raw previously.md content for a slice (no migration).
 * Returns "" if it doesn't exist yet. Internal — ensurePreviously uses it so
 * it can still detect and persist legacy files.
 */
async function readPreviouslyRaw(
  sliceId: string,
  batch?: WriteBatch
): Promise<string> {
  try {
    return await readSlicePart(sliceId, "previously", batch);
  } catch {
    return "";
  }
}

/**
 * Read the previously.md content for a slice, always in the v3 format: legacy
 * (v1/v2) content is migrated on the fly so the model and every consumer see
 * one consistent structure. Returns "" if it doesn't exist yet.
 */
export async function readPreviously(sliceId: string): Promise<string> {
  const raw = await readPreviouslyRaw(sliceId);
  if (!raw) return "";
  // v4 card is read as-is (the current structure); legacy v1/v2/v3 content is
  // migrated on the fly so old slices stay readable.
  return isCardFormat(raw) ? raw : migrateToV3(raw, sliceId);
}

/**
 * Write (overwrite) previously.md content for a slice.
 */
export async function writePreviously(
  sliceId: string,
  content: string,
  batch?: WriteBatch,
): Promise<void> {
  await fsWriteFile(sliceIdToPreviouslyPath(sliceId), content, batch);
}

/**
 * Find the most recently frozen previously.md by scanning backward through
 * calendar days (up to 30). Returns the content migrated to the v3 format,
 * or null if no frozen previously.md exists within the lookback window.
 */
export async function findMostRecentPreviously(
  batch?: WriteBatch
): Promise<string | null> {
  const now = new Date();
  const MAX_DAYS = 30;

  for (let daysBack = 0; daysBack < MAX_DAYS; daysBack++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - daysBack));

    // Dual-root (v0.19 R2): the new records root first, the legacy slices
    // root on a miss. previously.md sits at the slice-directory root in BOTH
    // layouts, so only the day directory differs.
    for (const root of [RECORDS_ROOT, LEGACY_SLICES_ROOT] as const) {
      const dir = dayDirForDate(root, d);

      try {
        const entries = await fsListFiles(dir);
        const sliceDirs = entries
          .filter((e) => e.type === "dir")
          .sort((a, b) => b.name.localeCompare(a.name)); // newest first

        let found: string | null = null;
        for (const sd of sliceDirs) {
          try {
            const prevPath = `${dir}/${sd.name}/previously.md`;
            const content = await fsReadFile(prevPath, batch);
            if (content.trim()) {
              found = content;
              break;
            }
          } catch {
            // No previously.md in this slice directory
          }
        }
        if (found !== null) {
          return isCardFormat(found) ? found : migrateToV3(found);
        }
      } catch {
        // Day directory doesn't exist on this root
      }
    }
  }

  return null;
}

/**
 * The LIVE previously card — the single source every turn injects into the
 * system prompt, maintained by evolution (slice close + explicit trigger).
 * Per-slice previously.md files remain as historical snapshots; this is the
 * current one the conversation actually reads.
 */
export const CURRENT_PREVIOUSLY_PATH = "memory/episodic/current-previously.md";

/** Read the live card. Returns "" if it doesn't exist yet. */
export async function readCurrentPreviously(
  batch?: WriteBatch
): Promise<string> {
  try {
    return await fsReadFile(CURRENT_PREVIOUSLY_PATH, batch);
  } catch {
    return "";
  }
}

/** Overwrite the live card. */
export async function writeCurrentPreviously(
  content: string,
  batch?: WriteBatch
): Promise<void> {
  await fsWriteFile(CURRENT_PREVIOUSLY_PATH, content, batch);
}

/**
 * Ensure the LIVE card exists and return it — every turn injects this.
 *
 * v0.7b synchronous design: the boundary turn evolves the live card BEFORE the
 * new slice is created, then this copies the live card to the new slice's
 * per-slice file — so the agent uses a freshly-evolved card, never a stale one.
 * The live card is seeded once from the latest snapshot (or a template), then
 * maintained by the inline evolution via `writeCurrentPreviously`. Closed
 * slices keep the snapshot evolution wrote at close.
 */
export async function ensurePreviously(
  sliceId: string,
  batch?: WriteBatch
): Promise<string> {
  // Live card — what the current conversation injects. Normalize a legacy
  // (v1/v2/v3) card to the user-card structure once; seed from the latest
  // snapshot or a template when it doesn't exist yet.
  let current = await readCurrentPreviously(batch);
  if (current.trim() && !isCardFormat(current)) {
    current = migrateV3ToCard(current, sliceId);
    await writeCurrentPreviously(current, batch);
  } else if (!current.trim()) {
    const source = await findMostRecentPreviously(batch);
    current = source
      ? isCardFormat(source)
        ? source
        : migrateV3ToCard(source, sliceId)
      : newCardTemplate(sliceId);
    await writeCurrentPreviously(current, batch);
  }

  // Copy the live card to this slice's per-slice file (the agent uses the new
  // slice's card). Only writes when they differ — within a slice the live card
  // is stable, so this is a single fresh write at slice creation, then silent.
  const existing = await readPreviouslyRaw(sliceId, batch);
  if (existing !== current) {
    await writePreviously(sliceId, current, batch);
  }

  return current;
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
export async function saveSliceSnapshot(
  slice: TimeSlice,
  batch?: WriteBatch
): Promise<void> {
  const slicePath = getSlicePath(slice);
  const markdown = serializeSlice(slice);
  await fsWriteFile(slicePath, markdown, batch);
}
