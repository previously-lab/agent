"use server";

import { getDemoPersona, listDemoPersonas, setDemoPersona } from "@/lib/demo/demo-fs";
import { resolveDataSource } from "@/lib/data-source/resolve";
import { getUserName } from "@/lib/identity";
import { formatErrorDetail } from "@/lib/chat/workflow-errors";
import { parseSlice, readPreviously, readAgentTimeline, loadSlice, readStrands } from "./manager";
import { readSlicePart, sliceIdToRelPath } from "./paths";
import { fsListFiles, fsReadFile } from "./io-helpers";
import {
  DATED_DOC_KINDS,
  DOC_KINDS,
  docPathCandidates,
  isValidDocFileName,
  normalizeDocRef,
  parseDoc,
  parseDocFileName,
  type DocKind,
  type DocStatus,
  type ParsedDoc,
} from "@/lib/docs";
import {
  CASE_CATEGORIES,
  isCaseCategory,
  isValidCaseName,
  caseIndexPath,
  caseDirPath,
  parseCaseRef,
  resolveCaseRefPaths,
  parseCaseDoc,
  isValidPieceFileName,
  parsePieceFileName,
  type CaseCategory,
} from "@/lib/docs";
import { readDirection } from "@/lib/evolution/store";
import {
  caseAttachmentsDir,
  isImageAttachmentName,
  readCaseAttachment,
} from "@/lib/tools/attachments";
import { loadUserConfig } from "@/lib/config/loader";
import { sliceEntryFromDisk } from "./timeline/store";
import { enumerateSliceIds } from "./timeline/enumerate";
import { readStrandEntity } from "./strand-files";
import { pageCatalog, type CatalogPage } from "./timeline/paginate";
import type { TimelineSliceEntry } from "./timeline/types";
import type { StrandIndex, Turn } from "./types";

export interface SliceSummary {
  slice_id: string;
  focus: string;
  summary: string;
  start: string;
  status: "active" | "closed";
  open_loops: string[];
  decisions: string[];
  /** Always `[]` — the projection was retired (§A.2.4). The field survives
   *  only because the (non-writable) chat stream pipeline still carries it. */
  strands: string[];
  turnCount?: number;
  timezone?: string;
}

export interface EpisodicState {
  hasActiveSlice: boolean;
  hasMore: boolean;
  active: SliceSummary | null;
  recent: SliceSummary[];
}

// ─── Live enumeration + point reads (v0.19 R3b / §A.2.4) ──────────────────
// The UI no longer reads ANY projection (`timeline/index.json`, monthly
// `_index.json`): the slice set is ENUMERATED live from the tree (one GitHub
// Trees call, or a recursive local walk — `timeline/enumerate.ts`), and only
// the slices inside the requested window get their headers point-read
// (`sliceEntryFromDisk`, dual-root via `readSlicePart`). The Data Cache's HTTP
// read cache is what absorbs repeat header reads — it is a read cache, not a
// stored projection.

/** "2026/08/11/1115" → "2026-08-11-1115". */
function relPathToSliceId(rel: string): string {
  return rel.replaceAll("/", "-");
}

/**
 * Every slice id on disk, oldest → newest (the id's UTC timestamp sorts
 * lexicographically). One enumeration call, zero content reads.
 */
async function listLiveSliceIds(): Promise<string[]> {
  const rels = await enumerateSliceIds();
  return rels.map(relPathToSliceId).sort();
}

/** Point-read one slice's header into a catalog-shaped entry (dual-root). */
async function readLiveEntry(id: string): Promise<TimelineSliceEntry | null> {
  return sliceEntryFromDisk(sliceIdToRelPath(id));
}

/** Point-read the headers of exactly `ids` (bounded concurrency, order kept). */
async function readLiveEntries(ids: string[]): Promise<TimelineSliceEntry[]> {
  const entries = await mapLimited(ids, SLICE_READ_CONCURRENCY, readLiveEntry);
  return entries.filter((e): e is TimelineSliceEntry => e !== null);
}

/**
 * A catalog-shaped skeleton derived from the id ALONE — no read. The id
 * encodes the UTC start to the minute, which is all windowing needs; the
 * window's REAL entries are then point-read (`readLiveEntries`).
 */
function skeletonEntry(id: string): TimelineSliceEntry {
  const date = id.slice(0, 10);
  return {
    id,
    date,
    start: `${date}T${id.slice(11, 13)}:${id.slice(13, 15)}:00.000Z`,
    status: "closed",
    focus: "",
    summary: "",
    tags: [],
    open_loops: [],
    decisions: [],
    strands: [],
    needs_marking: true,
  };
}

export async function getEpisodicState(persona?: string): Promise<EpisodicState & { hasMore: boolean }> {
  if (persona) setDemoPersona(persona);
  const PAGE_SIZE = 3;

  // One enumeration answers "what are the newest three slices" — the question
  // the catalog used to answer by definition. Only those three headers are
  // point-read. This runs on every chat mount and is one of the two legs
  // gating the arrival skeleton.
  const ids = await listLiveSliceIds();
  if (ids.length === 0) {
    return { hasActiveSlice: false, hasMore: false, active: null, recent: [] };
  }

  const entries = await readLiveEntries(ids.slice(-PAGE_SIZE));
  const recent = [...entries].sort((a, b) => b.start.localeCompare(a.start));
  const first = recent[0];

  const summary = (e: (typeof recent)[number]): SliceSummary => ({
    slice_id: e.id,
    focus: e.focus,
    summary: e.summary,
    start: e.start,
    status: e.status,
    open_loops: e.open_loops,
    decisions: e.decisions,
    strands: e.strands,
  });

  return {
    hasActiveSlice: recent.length > 0,
    hasMore: ids.length > PAGE_SIZE,
    active: first ? summary(first) : null,
    recent: recent.map(summary),
  };
}

export interface SliceWithContent {
  id: string;
  start: string;
  end?: string;
  focus: string;
  summary: string;
  tags: string[];
  strands: string[];
  turnCount: number;
  continuesFrom?: string;
  closedBy?: string;
  turns: Turn[];
}

export interface SliceContentPage {
  /** Slices in chronological order (oldest → newest), ready to prepend into the message stream. */
  slices: SliceWithContent[];
  /** True when the catalog still holds slices older than this page. */
  hasMore: boolean;
}

/**
 * One page of slices WITH their full turns (v0.10 unified message flow).
 *
 * The pagination source is LIVE ENUMERATION (v0.19 R3b — no projection):
 * `beforeId` is the id of the oldest already-loaded slice (null = initial
 * page from the newest end); the page is the newest `limit` enumerated ids
 * strictly older than it, returned oldest → newest. `hasMore` is exact —
 * derived from whether the enumeration still holds older ids. Headers are
 * point-read for the page's window only; turns are filled in through the
 * same read path as `getSliceContent`; slices whose file is unreadable are
 * skipped, never faked.
 */
/**
 * How many slice reads may be in flight at once. GitHub's secondary rate
 * limits ask for well under 100 concurrent requests, and every one of these is
 * a `getContent`.
 */
const SLICE_READ_CONCURRENCY = 12;

/**
 * Map with a hard cap on how many promises are in flight. In-flight-bounded
 * rather than a queue: each worker pulls the next index when it finishes, so
 * a slow read never blocks the others. Order is preserved in the result.
 */
async function mapLimited<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return out;
}

/**
 * Load a run of catalog entries into `SliceWithContent`. The slice-file reads
 * run CONCURRENTLY — one round trip's latency for the whole batch, not one per
 * slice — but bounded, because a jump window can hold hundreds of them and an
 * unbounded `Promise.all` is a burst the GitHub rate limiter reads as abuse.
 * Catalog entries whose slice file is missing (phantoms) are skipped, never
 * faked.
 */
async function loadEntriesWithContent(
  entries: TimelineSliceEntry[],
): Promise<SliceWithContent[]> {
  const loaded = await mapLimited(
    entries,
    SLICE_READ_CONCURRENCY,
    async (entry): Promise<SliceWithContent | null> => {
      const slice = await loadSlice(entry.id);
      if (!slice) return null;
      return {
        id: entry.id,
        start: entry.start,
        end: entry.end ?? slice.end,
        focus: entry.focus,
        summary: entry.summary,
        tags: entry.tags,
        strands: entry.strands,
        turnCount: slice.turns.length,
        continuesFrom: entry.continues_from,
        closedBy: entry.closed_by,
        turns: slice.turns,
      };
    },
  );
  return loaded.filter((s): s is SliceWithContent => s !== null);
}

export async function getSlicePageWithContent(
  beforeId: string | null,
  limit: number = 10,
  persona?: string,
): Promise<SliceContentPage> {
  if (persona) setDemoPersona(persona);
  const cap = Math.max(1, Math.min(limit, 50));
  const ids = await listLiveSliceIds();

  // The cursor is the oldest already-loaded slice's ID (exclusive) — the
  // enumeration's own ordering, not a projection's `start` field.
  const eligible = beforeId === null ? ids : ids.filter((id) => id < beforeId);
  const pageIds = eligible.slice(-cap);
  const hasMore = eligible.length > pageIds.length;

  // Headers are point-read for the page's ids ONLY — nothing outside the
  // window is read. Turns fill in through the same read path as
  // getSliceContent; an unreadable slice is skipped, never faked.
  const entries = await readLiveEntries(pageIds);
  return {
    slices: await loadEntriesWithContent(entries),
    hasMore,
  };
}

/**
 * One-round-trip slice jump (the timeline-card click path): instead of the
 * client paging one 10-slice page at a time until the target appears (a
 * serial round trip per page — 10+ pages for a slice 100 back), the server
 * enumerates the live slice set once, slices out the WHOLE missing stretch
 * between the jump target and the oldest already-loaded slice, and point-reads
 * every header + slice file in PARALLEL. The client prepends the batch as one
 * page.
 */
export interface SliceJumpWindow extends SliceContentPage {
  /**
   * False when `targetId` isn't in the live enumeration at all — the slice
   * genuinely does not exist on disk (there is no index to lag anymore). The
   * caller falls back to page-at-a-time paging, which reaches the same
   * verdict honestly.
   */
  found: boolean;
}

/**
 * The most slices one jump batch will carry.
 *
 * A batch is FULL slices with every turn in them, so this is a payload bound
 * as much as a request bound: at 500 it allowed tens of megabytes into a
 * single action response for a jump far enough back, and the client's page
 * loop (50 pages × 10) covers the remainder one round trip at a time. Set
 * where one batch is comfortably a single response and still resolves the
 * common jump — a handful of days, or a few dozen slices — in one hop.
 */
const JUMP_WINDOW_CAP = 150;

export async function getSliceJumpWindow(
  targetId: string,
  oldestLoadedId: string | null,
  persona?: string,
): Promise<SliceJumpWindow> {
  if (persona) setDemoPersona(persona);
  const ids = await listLiveSliceIds();

  const targetIndex = ids.indexOf(targetId);
  if (targetIndex === -1) {
    return { found: false, slices: [], hasMore: ids.length > 0 };
  }

  // The stretch to fill runs from the target (inclusive) up to the loaded
  // window's head (exclusive). A head that isn't in the enumeration stretches
  // to the enumeration's end — prependPage dedupes any overlap with the
  // already-loaded window.
  const loadedIndex = oldestLoadedId ? ids.indexOf(oldestLoadedId) : -1;
  const endExclusive = loadedIndex >= 0 ? loadedIndex : ids.length;
  // Cap from the NEWEST side so the batch always sits flush against the
  // loaded window (no hole in the stream); when the cap bites, the target
  // stays unloaded and the caller's page loop walks the rest.
  const start = Math.max(targetIndex, endExclusive - JUMP_WINDOW_CAP);
  const windowIds = ids.slice(start, Math.max(endExclusive, start));

  const entries = await readLiveEntries(windowIds);
  return {
    found: true,
    slices: await loadEntriesWithContent(entries),
    // True when the enumeration still holds slices older than the batch head —
    // the caller's hasMore for continuing to page up from the new head.
    hasMore: start > 0,
  };
}

export type ArrivalState =
  | {
      mode: "resume";
      sliceId: string;
      turns: Turn[];
      focus: string;
      start: string;
      /** Always `[]` — the projection was retired (§A.2.4). The field
       *  survives only because the chat stream pipeline still carries it. */
      strands: string[];
    }
  | { mode: "briefing" };

/**
 * Arrival gate (v0.10 design §2): is the newest slice still alive?
 *
 * Reuses the server's own same-conversation criterion — `slicing.idleGapMinutes`
 * — so a config change moves both the close decision and the arrival decision
 * together. Last activity is the slice's last turn timestamp (falling back to
 * `end`, then `start`); younger than the idle gap → `resume` with the slice's
 * turns, otherwise → `briefing` (the existing EmptyBriefing path).
 *
 * Only slices that can still be the SAME conversation resume: the active
 * one, a time_cap/capacity CHECKPOINT (the next turn's housekeeping creates
 * the continuesFrom follow-up slice, so arriving now continues rather than
 * forks), or a slice with no recorded close reason (legacy/migrated data).
 * A known genuine boundary (idle_gap / context_lost / user_explicit /
 * time_silence) always briefs.
 */
const ARRIVAL_BOUNDARY_SIGNALS: ReadonlySet<string> = new Set([
  "idle_gap",
  "context_lost",
  "user_explicit",
  "time_silence",
]);

export async function getArrivalState(persona?: string): Promise<ArrivalState> {
  if (persona) setDemoPersona(persona);
  const ids = await listLiveSliceIds();
  const lastId = ids[ids.length - 1];
  if (!lastId) return { mode: "briefing" };

  const slice = await loadSlice(lastId);
  if (!slice) return { mode: "briefing" };

  // The boundary verdict reads the slice's OWN header (status is derived from
  // closed_by, v0.19 R2) — no catalog entry exists anymore.
  if (
    slice.status !== "active" &&
    slice.closedBy &&
    ARRIVAL_BOUNDARY_SIGNALS.has(slice.closedBy)
  ) {
    return { mode: "briefing" };
  }

  const lastActivity =
    slice.turns[slice.turns.length - 1]?.timestamp ?? slice.end ?? slice.start;
  const { slicing } = await loadUserConfig();
  if (Date.now() - new Date(lastActivity).getTime() < slicing.idleGapMinutes * 60_000) {
    return {
      mode: "resume",
      sliceId: slice.slice_id,
      turns: slice.turns,
      focus: slice.focus,
      start: slice.start,
      // Strands were a weave-resolved projection field (strands.json) — with
      // the projection gone there is no live source; the restored turns
      // render untinted.
      strands: [],
    };
  }
  return { mode: "briefing" };
}

/**
 * The full live catalog — every slice enumerated from the tree, headers
 * point-read (bounded concurrency, Data Cache absorbs repeats), oldest →
 * newest. This is the "long array" the card field renders from
 * (virtualized), not a paginated page. Returns an empty array when no slices
 * exist yet.
 *
 * Cost note (v0.19 R3b): this is the one read path that point-reads EVERY
 * header — it exists for the targeted entrance (a slice address must be
 * resolvable wherever it sits in history). The paged path
 * (`getTimelineCatalogPage`) reads only the window.
 */
export async function getTimelineCatalog(): Promise<TimelineSliceEntry[]> {
  const ids = await listLiveSliceIds();
  return readLiveEntries(ids);
}

/**
 * One slice's start time, or null when no such slice exists (or its header
 * is unreadable).
 *
 * The jump paths need exactly this and nothing else — the travel clock's
 * destination, and whether a deep link resolves at all — so it point-reads
 * that ONE slice's header rather than enumerating or shipping a catalog.
 */
export async function getSliceStart(sliceId: string): Promise<string | null> {
  const entry = await readLiveEntry(sliceId);
  return entry?.start ?? null;
}

/**
 * Month-windowed catalog (Rev 7 §R7.4): the 3D timeline pages its history —
 * the client loads the latest `months` months, then prefetches older windows
 * as the camera approaches the oldest loaded entry.
 *
 * v0.19 R3b: the window is cut from the LIVE ENUMERATION (skeleton entries
 * derived from the ids — the id carries date + start to the minute, so the
 * pure month pager needs no reads), and only the window's headers are
 * point-read. `before` is a month key (YYYY-MM) from the previous page — the
 * enumeration's date cursor, exclusive so pages never overlap.
 */
export async function getTimelineCatalogPage(
  before: string | null,
  months = 2,
): Promise<CatalogPage> {
  const ids = await listLiveSliceIds();
  const skeletons = ids.map(skeletonEntry);
  const page = pageCatalog(skeletons, before, months);
  const entries = await readLiveEntries(page.entries.map((e) => e.id));
  return { ...page, entries };
}

/**
 * The raw strand path lists — strand → slice positions exactly as stored in
 * `strands.json` (`"2026/06/22/1400"` slash format, NOT normalised to slice
 * ids). The strand-door graph (`src/lib/game/strand-graph.ts`) builds from it.
 *
 * THE SOURCE IS RETIRED (§A.2.4): strands.json has not been written since A1,
 * so this only ever serves a stale snapshot, then nothing. The game handles
 * the empty case explicitly (game-shell.tsx); anchoring rooms to cases is a
 * separate piece of work.
 *
 * ONE read of the thin index, deliberately — no entity-layer round trips, no
 * normalisation; shaping the positions is the pure graph builder's job, so
 * the same payload feeds any consumer's own build. Returns an empty object
 * when the strand index doesn't exist (same fallback as `readStrands`).
 */
export async function getStrandPaths(): Promise<StrandIndex> {
  return readStrands();
}

// ─── Empty-state briefing identity ─────────────────────────────────────────
// The empty-live state shows a small "Previously On" + the user's name (+ a
// persona switcher in demo mode). No episodic re-scan here — ChatPage already
// loads the active slice via getEpisodicState; this only resolves the display
// name and, in demo mode, the persona list.
export interface BriefingIdentity {
  name: string;
  isDemo: boolean;
  personas?: Awaited<ReturnType<typeof listDemoPersonas>>;
}

export async function getBriefingIdentity(
  persona?: string,
): Promise<BriefingIdentity> {
  if (resolveDataSource() === "demo") {
    if (persona) setDemoPersona(persona);
    const personas = await listDemoPersonas().catch(() => []);
    const currentId = persona || getDemoPersona();
    const name = personas.find((p) => p.id === currentId)?.name ?? currentId;
    return { name, isDemo: true, personas };
  }
  const name = await getUserName().catch(() => "Previously");
  return { name, isDemo: false };
}

export interface SliceContent {
  slice_id: string;
  focus: string;
  summary: string;
  start: string;
  status: string;
  /** The card's truncated opening rounds by default; every turn under
   *  `{ full: true }` (see `getSliceContent`). */
  turns: Turn[];
  totalTurns: number;
  totalChars: number;
  open_loops: string[];
  decisions: string[];
  /** Previously.md content for this slice, or null if not found. */
  previously: string | null;
}

/** Options for `getSliceContent` — see the doc there. */
export interface SliceContentOptions {
  /** Ship every turn, not just the card's opening rounds. */
  full?: boolean;
}

/**
 * Single-slice content for the 3D timeline frame card (and, under `full`, for
 * the unified message stream).
 *
 * The card face only ever shows the slice's opening TWO exchanges (four
 * bubbles: user/agent ×2), so the DEFAULT wire payload is cut down server-side:
 * at most FRAME_TURN_COUNT turns, each truncated to FRAME_TURN_CHARS with an
 * ellipsis. `totalTurns`/`totalChars` still describe the untruncated slice.
 *
 * `{ full: true }` lifts that cut and ships every turn. It changes what crosses
 * the wire, not what the read costs — the body is read and parsed in full
 * either way — so the default stays truncated and existing callers are
 * untouched.
 */
const FRAME_TURN_COUNT = 4;
const FRAME_TURN_CHARS = 280;

/** Cut at a word boundary near the limit and strip trailing punctuation so
 *  the ellipsis doesn't land mid-word or after a comma. */
function truncateFrameTurn(content: string): string {
  if (content.length <= FRAME_TURN_CHARS) return content;
  const cut = content.slice(0, FRAME_TURN_CHARS);
  const lastSpace = cut.lastIndexOf(" ");
  const base = (
    lastSpace > FRAME_TURN_CHARS * 0.6 ? cut.slice(0, lastSpace) : cut
  )
    .trimEnd()
    .replace(/[.,;:!?，。；：！？、…—-]+$/, "");
  return `${base}…`;
}

function frameTurns(turns: Turn[]): Turn[] {
  return turns
    .slice(0, FRAME_TURN_COUNT)
    .map((t) => ({ ...t, content: truncateFrameTurn(t.content) }));
}

export async function getSliceContent(
  sliceId: string,
  persona?: string,
  options?: SliceContentOptions,
): Promise<SliceContent | null> {
  if (persona) setDemoPersona(persona);
  const full = options?.full === true;
  try {
    // core slice body (dual-root: new records root first, legacy slices root
    // on a miss) + previously.md ride in PARALLEL — they don't depend
    // on each other, and serializing them doubled the card-open latency.
    // A missing previously.md is normal (not every slice has one) and stays
    // a null, exactly as before.
    const [raw, previously] = await Promise.all([
      readSlicePart(sliceId, "core"),
      readPreviously(sliceId).catch(() => null),
    ]);
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
      turns: full ? slice.turns : frameTurns(slice.turns),
      totalTurns: slice.turns.length,
      totalChars,
      open_loops: slice.open_loops,
      decisions: slice.decisions,
      previously,
    };
  } catch (err) {
    console.error(`[Episodic] getSliceContent failed for ${sliceId}:`, formatErrorDetail(err));
    return null;
  }
}

// ─── Previously / Agent Timeline actions ─────────────────────────────────

/**
 * Read the previously.md belief-system snapshot for a slice.
 * Returns null when the file doesn't exist (e.g. brand-new slice with no
 * previously.md seeded yet).
 */
export async function getPreviously(sliceId: string): Promise<string | null> {
  try {
    return await readPreviously(sliceId);
  } catch {
    return null;
  }
}

/**
 * Read the full agent.md cognition log for a slice.
 * Returns null when the file doesn't exist.
 */
export async function getAgentTimeline(sliceId: string): Promise<string | null> {
  try {
    return await readAgentTimeline(sliceId);
  } catch {
    return null;
  }
}

/**
 * Extract a single cognition block from agent.md by turnId.
 *
 * agent.md blocks follow the convention:
 *   ## Cognition {turnId} — {timestamp}
 *   (thinking + tool-call text…)
 *
 * Returns the body text (without the header line), or null when the turn
 * has no cognition recorded or the file doesn't exist.
 */
export async function getTurnCognition(
  sliceId: string,
  turnId: string,
): Promise<string | null> {
  try {
    const raw = await readAgentTimeline(sliceId);
    if (!raw) return null;

    // Split on cognition headers — each block starts with "## Cognition "
    const blocks = raw.split(/^## Cognition /m);
    for (const block of blocks) {
      if (block.startsWith(turnId)) {
        // Remove the "turnId — timestamp" header line
        const newlineIdx = block.indexOf("\n");
        if (newlineIdx === -1) return ""; // header only, no body
        return block.slice(newlineIdx + 1).trim();
      }
    }
    return null;
  } catch {
    return null;
  }
}

// ─── Memory docs viewer (previously / direction) ─────────────────────────

export interface MemoryDocs {
  /** The slice the previously.md snapshot belongs to (null when no slices exist). */
  sliceId: string | null;
  /** previously.md of the current slice — the latest slice when none is active. */
  previously: string | null;
  /** memory/evolution/direction.md */
  direction: string | null;
}

/**
 * Read the user-facing memory documents in one round-trip. The "current"
 * slice is simply the NEWEST slice in the live enumeration — an active slice
 * is always the newest (a new slice only starts after the previous one
 * closes), so this covers both "the current slice" and "the latest slice
 * when none is active".
 */
export async function getMemoryDocs(persona?: string): Promise<MemoryDocs> {
  if (persona) setDemoPersona(persona);

  const ids = await listLiveSliceIds();
  const latestId = ids[ids.length - 1] ?? null;

  const [previously, direction] = await Promise.all([
    latestId ? readPreviously(latestId).catch(() => null) : Promise.resolve(null),
    readDirection(),
  ]);

  return { sliceId: latestId, previously, direction };
}

// ─── Case shelf (v0.19 R3b: live enumeration + index.md point reads) ──────
// The bookshelf's NEW half, on the case model (§B.1/§B.2): the nine
// categories enumerate their case directories, a case opens by point-reading
// its `index.md` (+ one `ls` for its pieces), and any two-segment reference
// (`分类/case名[/篇名]`) resolves through `parseCaseRef`/`resolveCaseRefPaths`
// — new root first, legacy roots on a miss (§D.1). The legacy `memory/docs`
// shelf below stays as the shelf's second section until the migration (另案).

/** One case row on the shelf — the case's `index.md` header + first line. */
export interface CaseShelfItem {
  category: CaseCategory;
  name: string;
  /** Birth date from the header ("" when absent — tolerated, see §B.3). */
  opened: string;
  /** Seal date, or null while 还在写. */
  closed: string | null;
  /** First prose line of the body, truncated. */
  preview: string | null;
}

/** One category's enumeration: every case directory holding an `index.md`. */
export interface CaseShelfCategory {
  category: CaseCategory;
  cases: CaseShelfItem[];
}

export interface CaseShelf {
  categories: CaseShelfCategory[];
}

const CASE_PREVIEW_CHARS = 140;

/**
 * The case shelf root: enumerate the nine categories' case directories
 * (missing directories list as empty — pre-migration is a normal state) and
 * point-read each case's `index.md` for its row. Categories keep the §B.6
 * table's order; cases sort newest-born first.
 */
export async function getCaseShelf(persona?: string): Promise<CaseShelf> {
  if (persona) setDemoPersona(persona);

  const categories = await Promise.all(
    CASE_CATEGORIES.map(async (category): Promise<CaseShelfCategory> => {
      let entries: Awaited<ReturnType<typeof fsListFiles>>;
      try {
        entries = await fsListFiles(`memory/${category}`);
      } catch {
        return { category, cases: [] };
      }
      const names = entries
        .filter((e) => e.type === "dir" && isValidCaseName(e.name))
        .map((e) => e.name);
      const cases = await mapLimited(
        names,
        SLICE_READ_CONCURRENCY,
        async (name): Promise<CaseShelfItem | null> => {
          const raw = await fsReadFile(caseIndexPath(category, name)).catch(
            () => null,
          );
          if (raw === null) return null;
          const doc = parseCaseDoc(raw, { category, caseName: name, fileName: "index.md" });
          const firstLine =
            doc.body.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? null;
          return {
            category,
            name,
            opened: doc.opened,
            closed: doc.closed,
            preview: firstLine ? truncateDocText(firstLine, CASE_PREVIEW_CHARS) : null,
          };
        },
      );
      return {
        category,
        cases: cases
          .filter((c): c is CaseShelfItem => c !== null)
          .sort((a, b) => b.opened.localeCompare(a.opened) || a.name.localeCompare(b.name)),
      };
    }),
  );

  return { categories };
}

/** One piece inside a case, identified by its file name. */
export interface CasePieceRef {
  fileName: string;
  date: string | null;
  title: string | null;
}

/** A case opened on the shelf: its `index.md` + the flat piece list. */
export interface CaseDetail {
  category: CaseCategory;
  name: string;
  opened: string;
  closed: string | null;
  /** Body + preserved bytes + tail, as Markdown (no frontmatter). */
  markdown: string;
  pieces: CasePieceRef[];
  /** The case's attachments (§C.1) — names only; bytes ride /api/attachments. */
  attachments: CaseAttachmentRef[];
  warnings: string[];
}

/** One attachment on a case — the shelf renders images, links the rest. */
export interface CaseAttachmentRef {
  name: string;
  /** True when the name is an image type (rendered inline). */
  image: boolean;
}

/** Render a parsed case doc for display: body, tolerated bytes, dated tail. */
function caseDocMarkdown(doc: {
  body: string;
  preserved: string;
  tail: Array<{ date: string; text: string }>;
}): string {
  const parts: string[] = [];
  if (doc.body.trim()) parts.push(doc.body.trim());
  if (doc.preserved.trim()) parts.push(doc.preserved.trim());
  if (doc.tail.length > 0) {
    parts.push(
      `—— 尾部 ——\n\n${doc.tail.map((l) => `${l.date}：${l.text}`).join("\n\n")}`,
    );
  }
  return parts.join("\n\n");
}

/**
 * Open one case: point-read its `index.md` (dual-root via the ref resolver —
 * a legacy `memory/docs/<name>.md` hit renders through the old parser) and
 * list its pieces with one `ls`. Illegal names are rejected before any path
 * is touched.
 */
export async function getCaseDetail(
  category: string,
  caseName: string,
  persona?: string,
): Promise<CaseDetail | null> {
  if (persona) setDemoPersona(persona);
  if (!isCaseCategory(category) || !isValidCaseName(caseName)) return null;

  const ref = { kind: "case" as const, category, caseName };
  const hit = await readFirstExisting(resolveCaseRefPaths(ref));
  if (!hit) return null;

  // Pieces live in the new root only — a legacy-hit case has no case dir.
  let pieces: CasePieceRef[] = [];
  let attachments: CaseAttachmentRef[] = [];
  if (hit.path === caseIndexPath(category, caseName)) {
    const dirEntries = await fsListFiles(caseDirPath(category, caseName)).catch(
      () => [],
    );
    pieces = dirEntries
      .filter(
        (e) =>
          e.type === "file" &&
          e.name !== "index.md" &&
          e.name.endsWith(".md") &&
          isValidPieceFileName(e.name),
      )
      .map((e) => {
        const parsed = parsePieceFileName(e.name);
        return { fileName: e.name, date: parsed?.date ?? null, title: parsed?.title ?? null };
      })
      .sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
    // Attachments (§C.1): names only — the browser pulls bytes through
    // /api/attachments, the client never carries base64.
    attachments = (
      await fsListFiles(caseAttachmentsDir(category, caseName)).catch(() => [])
    )
      .filter((e) => e.type === "file")
      .map((e) => ({ name: e.name, image: isImageAttachmentName(e.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  if (hit.path.startsWith(`memory/${category}/`)) {
    const doc = parseCaseDoc(hit.raw, { category, caseName, fileName: "index.md" });
    return {
      category,
      name: caseName,
      opened: doc.opened,
      closed: doc.closed,
      markdown: caseDocMarkdown(doc),
      pieces,
      attachments,
      warnings: doc.warnings,
    };
  }
  // Legacy hit (`memory/docs/<kind>/<name>.md` etc.) — old-format render.
  const legacy = renderLegacyDoc(hit.path, hit.raw);
  return {
    category,
    name: caseName,
    opened: legacy?.opened ?? "",
    closed: legacy?.closed ?? null,
    markdown: legacy?.markdown ?? hit.raw,
    pieces,
    attachments,
    warnings: legacy?.warnings ?? [],
  };
}

/** One document opened by reference — a case's index.md, a piece, or a
 *  tolerated legacy document (§D.1). */
export interface CaseDocContent {
  /** The normalized reference text (`分类/case名[/篇名]` or a legacy name). */
  ref: string;
  opened: string;
  closed: string | null;
  markdown: string;
  warnings: string[];
}

/**
 * Read one document by its two-segment reference (`分类/case名` → the case's
 * `index.md`; `分类/case名/篇名` → the piece). Candidates resolve new-root
 * first, legacy roots on a miss; a ref that resolves against none of them is
 * a dead link and returns null (visible, never blocking).
 */
export async function getCaseDoc(
  refText: string,
  persona?: string,
): Promise<CaseDocContent | null> {
  if (persona) setDemoPersona(persona);
  const ref = parseCaseRef(refText);
  if (!ref) return null;

  const hit = await readFirstExisting(resolveCaseRefPaths(ref));
  if (!hit) return null;

  if (ref.kind !== "legacy" && hit.path.startsWith(`memory/${ref.category}/`)) {
    const fileName = ref.kind === "piece" ? ref.pieceFileName : "index.md";
    const doc = parseCaseDoc(hit.raw, {
      category: ref.category,
      caseName: ref.caseName,
      fileName,
    });
    return {
      ref: refText,
      opened: doc.opened,
      closed: doc.closed,
      markdown: caseDocMarkdown(doc),
      warnings: doc.warnings,
    };
  }

  const legacy = renderLegacyDoc(hit.path, hit.raw);
  return {
    ref: refText,
    opened: legacy?.opened ?? "",
    closed: legacy?.closed ?? null,
    markdown: legacy?.markdown ?? hit.raw,
    warnings: legacy?.warnings ?? [],
  };
}

/** First readable path of a candidate list, or null (a dead link). */
async function readFirstExisting(  paths: string[],
): Promise<{ path: string; raw: string } | null> {
  for (const path of paths) {
    const raw = await fsReadFile(path).catch(() => null);
    if (raw !== null) return { path, raw };
  }
  return null;
}

/** Render a legacy (pre-case) document: v0.15 docs go through the old parser,
 *  anything else (strand entities) shows its body verbatim. */
function renderLegacyDoc(
  path: string,
  raw: string,
): { opened: string; closed: string | null; markdown: string; warnings: string[] } | null {
  const m = /^memory\/docs\/([^/]+)\/([^/]+)$/.exec(path);
  if (!m) {
    // e.g. memory/episodic/strands/<name>.md — strip frontmatter, keep the rest.
    const body = raw.replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
    return { opened: "", closed: null, markdown: body, warnings: [] };
  }
  const kind = m[1] as DocKind;
  const fileName = m[2];
  if (!(DOC_KINDS as readonly string[]).includes(kind)) return null;
  const doc = parseDoc(raw, fileName, kind);
  return {
    opened: doc.frontmatter.opened,
    // The old three-value status maps onto the seal semantics (§D.1): an
    // active doc is 还在写, anything else reads as closed at `updated`.
    closed:
      doc.frontmatter.status === "active"
        ? null
        : doc.frontmatter.updated || null,
    markdown: serializeDocBody(doc),
    warnings: doc.warnings,
  };
}

// ─── Document shelf (v0.15 §4.2: topic → document two-level browse) ────────
// LEGACY half of the shelf — enumerates `memory/docs/` (a legacy root, §D.1),
// not a projection. Stays until the存量 migration (另案).

const DOCS_ROOT = "memory/docs";
const SHELF_ASOF_PREVIEW_CHARS = 140;
const CATALOG_SNIPPET_CHARS = 120;
const DOC_REF_PATTERN = /《([^》]+)》/g;

/** One document under a kind directory, identified purely by its file name. */
export interface DocShelfDocRef {
  fileName: string;
  /** Birth date from the file name (null for unparseable names — kept visible). */
  date: string | null;
  /** Title from the file name (null for topic-kind names). */
  title: string | null;
}

/** The `ls memory/docs/<kind>/` answer for one kind. */
export interface DocShelfKindList {
  kind: DocKind;
  docs: DocShelfDocRef[];
}

/** One topic home on the shelf — the 截至块 + latest entry are its one-liner. */
export interface DocShelfTopic {
  name: string;
  status: DocStatus;
  /** Last-write date from the frontmatter ("" when the field is absent). */
  updated: string;
  /** Truncated 截至块 text — the topic's current one-line understanding. */
  asOf: string | null;
  asOfDate: string | null;
  /** Newest dated entry — what happened there most recently. */
  latestEntry: { date: string; title: string } | null;
  /** Dated entries carrying 《…》 catalog references. */
  catalogCount: number;
}

/**
 * The shelf root in ONE round trip: every topic home (read + parsed for its
 * 截至块 / latest entry / catalog count) plus the plain `ls` of the eight
 * dated kind directories. `topic` is the primary axis and is not repeated
 * under `kinds`. Missing directories are normal pre-migration — they list
 * as empty, never as errors.
 */
export interface DocShelf {
  topics: DocShelfTopic[];
  kinds: DocShelfKindList[];
}

/** List one kind directory; a missing directory lists as empty. */
async function listDocDir(kind: DocKind): Promise<Awaited<ReturnType<typeof fsListFiles>>> {
  try {
    return await fsListFiles(`${DOCS_ROOT}/${kind}`);
  } catch {
    return [];
  }
}

function toDocRef(fileName: string, kind: DocKind): DocShelfDocRef {
  const parsed = parseDocFileName(fileName, kind);
  return { fileName, date: parsed?.date ?? null, title: parsed?.title ?? null };
}

/** Collapse whitespace and cap a prose preview at `max` chars. */
function truncateDocText(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

/** 《…》 references in entry prose → canonical document file names. */
function extractDocRefs(text: string): string[] {
  const refs: string[] = [];
  for (const m of text.matchAll(DOC_REF_PATTERN)) {
    const normalized = normalizeDocRef(m[1]);
    if (normalized && !refs.includes(normalized)) refs.push(normalized);
  }
  return refs;
}

/** Body back to Markdown WITHOUT the frontmatter (heading + 截至块 + stream). */
function serializeDocBody(doc: ParsedDoc): string {
  const parts: string[] = [];
  if (doc.heading) parts.push(`# ${doc.heading}`);
  if (doc.asOf) parts.push(`> 截至 ${doc.asOf.date}：${doc.asOf.text}`);
  for (const s of doc.sections) {
    parts.push(
      s.type === "entry"
        ? `## ${s.entry.date} — ${s.entry.title}\n\n${s.entry.body}`.trimEnd()
        : s.text,
    );
  }
  return parts.join("\n\n");
}

export async function getDocShelf(persona?: string): Promise<DocShelf> {
  if (persona) setDemoPersona(persona);

  const [topicEntries, kindLists] = await Promise.all([
    listDocDir("topic"),
    Promise.all(
      DATED_DOC_KINDS.map(async (kind) => ({
        kind,
        docs: (await listDocDir(kind))
          .filter((e) => e.type === "file" && e.name.endsWith(".md"))
          .map((e) => toDocRef(e.name, kind))
          .sort((a, b) => (b.date ?? "").localeCompare(a.date ?? "")),
      })),
    ),
  ]);

  const topics = await mapLimited(
    topicEntries.filter((e) => e.type === "file" && e.name.endsWith(".md")),
    SLICE_READ_CONCURRENCY,
    async (entry): Promise<DocShelfTopic | null> => {
      const fileName = entry.name;
      const raw = await fsReadFile(`${DOCS_ROOT}/topic/${fileName}`).catch(() => null);
      if (raw === null) return null;
      const doc = parseDoc(raw, fileName, "topic");
      const entries = doc.sections.flatMap((s) => (s.type === "entry" ? [s.entry] : []));
      const last = entries[entries.length - 1];
      return {
        name: fileName.slice(0, -".md".length),
        status: doc.frontmatter.status,
        updated: doc.frontmatter.updated,
        asOf: doc.asOf ? truncateDocText(doc.asOf.text, SHELF_ASOF_PREVIEW_CHARS) : null,
        asOfDate: doc.asOf?.date ?? null,
        latestEntry: last ? { date: last.date, title: last.title } : null,
        catalogCount: entries.filter(
          (e) => extractDocRefs(`${e.title}\n${e.body}`).length > 0,
        ).length,
      };
    },
  );

  return {
    topics: topics
      .filter((t): t is DocShelfTopic => t !== null)
      .sort((a, b) => b.updated.localeCompare(a.updated)),
    kinds: kindLists,
  };
}

/** One 名录 entry of a topic home: the documents it catalogues. */
export interface DocTopicCatalogItem {
  date: string;
  title: string;
  /** Canonical file names referenced via 《…》. */
  refs: string[];
  /** First prose line of the entry, truncated — the one-liner. */
  snippet: string;
}

/** A topic home opened on the shelf: header facts + its 名录. */
export interface DocTopicDetail {
  name: string;
  heading: string | null;
  status: DocStatus;
  opened: string;
  updated: string;
  asOf: string | null;
  asOfDate: string | null;
  catalog: DocTopicCatalogItem[];
  warnings: string[];
}

export async function getDocTopicDetail(
  name: string,
  persona?: string,
): Promise<DocTopicDetail | null> {
  if (persona) setDemoPersona(persona);
  const fileName = `${name}.md`;
  if (!isValidDocFileName(fileName, "topic")) return null;
  const raw = await fsReadFile(`${DOCS_ROOT}/topic/${fileName}`).catch(() => null);
  if (raw === null) return null;

  const doc = parseDoc(raw, fileName, "topic");
  const catalog: DocTopicCatalogItem[] = doc.sections.flatMap((s) => {
    if (s.type !== "entry") return [];
    const refs = extractDocRefs(`${s.entry.title}\n${s.entry.body}`);
    if (refs.length === 0) return [];
    const firstLine =
      s.entry.body.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
    return [{
      date: s.entry.date,
      title: s.entry.title,
      refs,
      snippet: truncateDocText(firstLine, CATALOG_SNIPPET_CHARS),
    }];
  });

  return {
    name,
    heading: doc.heading,
    status: doc.frontmatter.status,
    opened: doc.frontmatter.opened,
    updated: doc.frontmatter.updated,
    asOf: doc.asOf?.text ?? null,
    asOfDate: doc.asOf?.date ?? null,
    catalog,
    warnings: doc.warnings,
  };
}

/** One document opened on the shelf. */
export interface DocContent {
  fileName: string;
  kind: DocKind;
  heading: string | null;
  status: DocStatus;
  opened: string;
  updated: string;
  asOf: string | null;
  asOfDate: string | null;
  /** Body as Markdown (heading + 截至块 + dated entry stream). */
  markdown: string;
  warnings: string[];
}

/**
 * Read one document whole. `kind` is known on the kind-browse path (one read);
 * from a topic catalog only the file name is known, so the kind directories
 * are tried via `docPathCandidates` until the file resolves — the file system
 * IS the index layer (§2.5). Names are validated through `isValidDocFileName`
 * before any path is touched.
 */
export async function getDocContent(
  fileName: string,
  kind?: DocKind,
  persona?: string,
): Promise<DocContent | null> {
  if (persona) setDemoPersona(persona);
  if (kind !== undefined && !(DOC_KINDS as readonly string[]).includes(kind)) {
    return null;
  }

  const tryRead = async (k: DocKind): Promise<DocContent | null> => {
    if (!isValidDocFileName(fileName, k)) return null;
    const raw = await fsReadFile(`${DOCS_ROOT}/${k}/${fileName}`).catch(() => null);
    if (raw === null) return null;
    const doc = parseDoc(raw, fileName, k);
    return {
      fileName,
      kind: k,
      heading: doc.heading,
      status: doc.frontmatter.status,
      opened: doc.frontmatter.opened,
      updated: doc.frontmatter.updated,
      asOf: doc.asOf?.text ?? null,
      asOfDate: doc.asOf?.date ?? null,
      markdown: serializeDocBody(doc),
      warnings: doc.warnings,
    };
  };

  if (kind) return tryRead(kind);
  for (const candidate of docPathCandidates(fileName)) {
    const k = candidate.split("/")[2] as DocKind;
    const doc = await tryRead(k);
    if (doc) return doc;
  }
  return null;
}
