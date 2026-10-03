"use server";

import { getDemoPersona, listDemoPersonas, setDemoPersona } from "@/lib/demo/demo-fs";
import { resolveDataSource } from "@/lib/data-source/resolve";
import { getUserName } from "@/lib/identity";
import { formatErrorDetail } from "@/lib/chat/workflow-errors";
import { readSliceIndex, readSliceBody, parseSlice, sliceIdToFilePath, readPreviously, readAgentTimeline, loadSlice, readStrands } from "./manager";
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
import { readDirection } from "@/lib/evolution/store";
import { loadUserConfig } from "@/lib/config/loader";
import { readTimelineIndex } from "./timeline/store";
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
  /** The slice's strands — the chat user bubble's tint source. */
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

const SCAN_BATCH = 6;

/**
 * Scan monthly indexes backwards from (startYear, startMonth), reading each
 * batch of months CONCURRENTLY (not one round-trip at a time — that's what made
 * the timeline slow over the GitHub API). Stops early once `enough` entries are
 * collected, so cost is bounded by "batches until enough found".
 */
async function scanMonthsBack(
  startYear: number,
  startMonth: number,
  maxMonths: number,
  enough: number,
): Promise<{ entries: Awaited<ReturnType<typeof readSliceIndex>>; exhausted: boolean }> {
  const entries: Awaited<ReturnType<typeof readSliceIndex>> = [];
  let scanned = 0;
  let exhausted = true;

  while (scanned < maxMonths) {
    const size = Math.min(SCAN_BATCH, maxMonths - scanned);
    const batch: Array<{ y: number; m: number }> = [];
    for (let j = 0; j < size; j++) {
      let m = startMonth - (scanned + j);
      let y = startYear;
      while (m <= 0) { m += 12; y -= 1; }
      batch.push({ y, m });
    }
    const results = await Promise.all(
      batch.map(({ y, m }) => readSliceIndex(y, m).catch(() => [])),
    );
    for (const idx of results) for (const e of idx) entries.push(e);
    scanned += size;
    if (entries.length >= enough) { exhausted = false; break; }
  }

  return { entries, exhausted };
}

export async function getEpisodicState(persona?: string): Promise<EpisodicState & { hasMore: boolean }> {
  if (persona) setDemoPersona(persona);
  const PAGE_SIZE = 3;

  // The timeline catalog already holds every slice, newest last, with the
  // fields this needs — focus, summary, open_loops, decisions AND strands.
  // Reading it is ONE backend round trip, against the six concurrent monthly
  // index reads (`scanMonthsBack`) plus a SECOND catalog read that this used
  // to spend answering "what are the newest three slices" — a question the
  // catalog answers by definition. It ran on every chat mount, and it is one
  // of the two legs gating the arrival skeleton.
  const idx = await readTimelineIndex();
  const catalog = idx?.slices ?? [];

  if (catalog.length === 0) {
    // No catalog yet (never woven, or an unreadable index) — fall back to the
    // monthly scan, which is the only other place the slice list exists.
    return { hasActiveSlice: false, hasMore: false, active: null, recent: [] };
  }

  const sorted = [...catalog].sort((a, b) => b.start.localeCompare(a.start));
  const recent = sorted.slice(0, PAGE_SIZE);
  const hasMore = sorted.length > PAGE_SIZE;
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
    hasMore,
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
 * The pagination source is the catalog (`timeline/index.json`, oldest →
 * newest): `before` is the ISO `start` of the oldest already-loaded slice
 * (null = initial page from the newest end); the page is the newest `limit`
 * entries whose `start < before`, returned oldest → newest. `hasMore` is
 * exact — derived from whether the catalog still holds older entries, not
 * from page-fill heuristics. Turns are filled in through the same read path
 * as `getSliceContent`; catalog entries whose slice file is missing
 * (phantoms) are skipped, never faked.
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
  before: string | null,
  limit: number = 10,
  persona?: string,
): Promise<SliceContentPage> {
  if (persona) setDemoPersona(persona);
  const cap = Math.max(1, Math.min(limit, 50));
  const idx = await readTimelineIndex();
  const catalog = idx?.slices ?? [];

  const eligible = before === null
    ? catalog
    : catalog.filter((e) => e.start < before);
  const pageEntries = eligible.slice(-cap);
  const hasMore = eligible.length > pageEntries.length;

  return {
    slices: await loadEntriesWithContent(pageEntries),
    hasMore,
  };
}

/**
 * One-round-trip slice jump (the timeline-card click path): instead of the
 * client paging one 10-slice page at a time until the target appears (a
 * serial round trip per page — 10+ pages for a slice 100 back), the server
 * reads the single timeline index, slices out the WHOLE missing stretch
 * between the jump target and the oldest already-loaded slice, and loads
 * every slice file in PARALLEL. The client prepends the batch as one page.
 */
export interface SliceJumpWindow extends SliceContentPage {
  /**
   * False when `targetId` isn't in the catalog at all (e.g. the index lags
   * a just-written slice) — the caller falls back to page-at-a-time paging,
   * which scans by `start` cursor rather than by id.
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
  const idx = await readTimelineIndex();
  const catalog = idx?.slices ?? [];

  const targetIndex = catalog.findIndex((e) => e.id === targetId);
  if (targetIndex === -1) {
    return { found: false, slices: [], hasMore: catalog.length > 0 };
  }

  // The stretch to fill runs from the target (inclusive) up to the loaded
  // window's head (exclusive). A head that isn't in the catalog (restored
  // cache, index lag) stretches to the catalog's end — prependPage dedupes
  // any overlap with the already-loaded window.
  const loadedIndex = oldestLoadedId
    ? catalog.findIndex((e) => e.id === oldestLoadedId)
    : -1;
  const endExclusive = loadedIndex >= 0 ? loadedIndex : catalog.length;
  // Cap from the NEWEST side so the batch always sits flush against the
  // loaded window (no hole in the stream); when the cap bites, the target
  // stays unloaded and the caller's page loop walks the rest.
  const start = Math.max(targetIndex, endExclusive - JUMP_WINDOW_CAP);
  const windowEntries = catalog.slice(start, Math.max(endExclusive, start));

  return {
    found: true,
    slices: await loadEntriesWithContent(windowEntries),
    // True when the catalog still holds slices older than the batch head —
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
      /** The resumed slice's strands — the restored turns' tint source. */
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
  const idx = await readTimelineIndex();
  const catalog = idx?.slices ?? [];
  const last = catalog[catalog.length - 1];
  if (!last) return { mode: "briefing" };

  const slice = await loadSlice(last.id);
  if (!slice) return { mode: "briefing" };

  if (
    last.status !== "active" &&
    last.closed_by &&
    ARRIVAL_BOUNDARY_SIGNALS.has(last.closed_by)
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
      strands: last.strands,
    };
  }
  return { mode: "briefing" };
}

/**
 * The full timeline catalog — every slice entry from `timeline/index.json`,
 * oldest → newest (the weave keeps it sorted ascending by id). This is the
 * "long array" the timeline wheel renders from (virtualized), not a paginated
 * page. Returns an empty array when the catalog hasn't been built yet.
 */
export async function getTimelineCatalog(): Promise<TimelineSliceEntry[]> {
  const idx = await readTimelineIndex();
  return idx?.slices ?? [];
}

/**
 * One slice's start time, or null when the catalog has no such slice.
 *
 * The jump paths need exactly this and nothing else — the travel clock's
 * destination, and whether a deep link resolves at all — and they used to call
 * `getTimelineCatalog` for it, shipping the entire catalog (every entry, every
 * tag and open-loop array) to the client so it could read one `.start`.
 */
export async function getSliceStart(sliceId: string): Promise<string | null> {
  const idx = await readTimelineIndex();
  return idx?.slices.find((e) => e.id === sliceId)?.start ?? null;
}

/**
 * Month-windowed catalog (Rev 7 §R7.4): the 3D timeline pages its history —
 * the client loads the latest `months` months, then prefetches older windows
 * as the camera approaches the oldest loaded entry. The on-disk index stays
 * whole; the window only bounds what the client holds and lays out.
 */
export async function getTimelineCatalogPage(
  before: string | null,
  months = 2,
): Promise<CatalogPage> {
  const idx = await readTimelineIndex();
  return pageCatalog(idx?.slices ?? [], before, months);
}

/** One strand's selector row (Rev 8 §R8 筛选器). */
export interface StrandListItem {
  name: string;
  /** Slices carrying the strand. */
  count: number;
  /** UTC ISO start of the newest carrier — sort key for "最近活跃". */
  lastStart: string;
}

/**
 * The strand list for the timeline filter, aggregated from the FULL catalog
 * (the client's month window would miss strands that only appear in unloaded
 * history). Sorted by most recent activity first.
 *
 * ONE read, deliberately. It used to also load the strand ENTITY layer —
 * `strands/<name>.md`, one backend round trip PER STRAND — to populate a
 * `description` field that nothing rendered: the filter shows a swatch, a name
 * and a count, and the band shows names. On a cold cache most of those reads
 * were 404s, which still cost a request. The entity layer has one consumer,
 * the recall sub-agent, and it reads it through its own tools.
 */
export async function getStrandList(): Promise<StrandListItem[]> {
  const idx = await readTimelineIndex();
  const acc = new Map<string, StrandListItem>();
  for (const s of idx?.slices ?? []) {
    for (const name of s.strands) {
      const item = acc.get(name);
      if (item) {
        item.count += 1;
        if (s.start > item.lastStart) item.lastStart = s.start;
      } else {
        acc.set(name, { name, count: 1, lastStart: s.start });
      }
    }
  }
  return [...acc.values()].sort((a, b) => b.lastStart.localeCompare(a.lastStart));
}

/**
 * The raw strand path lists — strand → slice positions exactly as stored in
 * `strands.json` (`"2026/06/22/1400"` slash format, NOT normalised to slice
 * ids). This is the read `getStrandList` doesn't do (v0.11-strand-field §5):
 * the strand-door graph (`src/lib/game/strand-graph.ts`) builds from it.
 *
 * ONE read of the thin index, deliberately — no entity-layer round trips, no
 * normalisation; shaping the positions is the pure graph builder's job, so
 * the same payload feeds any consumer's own build. Returns an empty object
 * when the strand index doesn't exist yet (same fallback as `readStrands`).
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
    const path = sliceIdToFilePath(sliceId);
    // core slice body + previously.md ride in PARALLEL — they don't depend
    // on each other, and serializing them doubled the card-open latency.
    // A missing previously.md is normal (not every slice has one) and stays
    // a null, exactly as before.
    const [raw, previously] = await Promise.all([
      readSliceBody(path),
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
 * slice is simply the NEWEST slice — an active slice is always the newest (a
 * new slice only starts after the previous one closes), so this covers both
 * "the current slice" and "the latest slice when none is active".
 */
export async function getMemoryDocs(persona?: string): Promise<MemoryDocs> {
  if (persona) setDemoPersona(persona);

  const now = new Date();
  const { entries } = await scanMonthsBack(
    now.getUTCFullYear(),
    now.getUTCMonth() + 1,
    120,
    1,
  );
  const latest = entries.sort((a, b) => b.start.localeCompare(a.start))[0] ?? null;

  const [previously, direction] = await Promise.all([
    latest ? readPreviously(latest.id).catch(() => null) : Promise.resolve(null),
    readDirection(),
  ]);

  return { sliceId: latest?.id ?? null, previously, direction };
}

// ─── Document shelf (v0.15 §4.2: topic → document two-level browse) ────────

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
