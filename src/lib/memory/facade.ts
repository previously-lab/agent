/**
 * The memory-read facade (v0.36) — the field agent's read vocabulary over the
 * memory tree: four verbs (recallRecent / recallFind / recallSearch /
 * recallRead), one entry shape, one discriminated result envelope, and fixed
 * rendering per result kind.
 *
 * EVERYTHING here is read-time parsed and pure-facade: dates come from paths
 * and slice ids for free, content scans run newest-first over the existing
 * tree (60s) + blob (7d) caches, and no new storage, index, or projection file
 * is introduced. The agent never sees the tree — it sees entries
 * (ref / title / date / excerpt) and reads on through refs.
 *
 * Category table (v0.36 §1, rulings #1-#3 applied):
 * - events / people / things / tasks / places / orgs — the tree's case dirs.
 * - research — the tree's research/ AND hypotheses/ (kind "hypothesis"
 *   distinguishes); falsifiability stays a WRITE-side path rule.
 * - self — self/ cases (kind "sop") + the bare file self/agenda (kind "agenda").
 * - people — people/ cases + the bare file people/user/profile (kind "profile").
 * - timeline — no storage: a read-time projection of slice heads.
 * - records — the slices themselves (kind "slice").
 *
 * The backend interface is injected so the module stays pure and unit-testable;
 * the chat executors build a backend from the tool context (demo / GitHub /
 * local), the tests build one over a Map.
 */

import matter from "gray-matter";
import {
  isRecallCategory,
  RECALL_CATEGORIES,
  type RecallCategory,
} from "@/lib/memory/categories";
import { CASE_CATEGORIES, MEMORY_ROOT_DIR } from "@/lib/docs/paths";
import type { CaseCategory } from "@/lib/docs/paths";
import { parseCaseDoc } from "@/lib/docs/case-doc";
import {
  parseCaseRef,
  resolveCaseRefPaths,
  normalizeCaseRefText,
} from "@/lib/docs/case-refs";
import { parsePieceFileName } from "@/lib/docs/case-naming";
import { parseSliceId, parseTurns, applyRange, reassembleSlice } from "@/lib/episodic/turn-parser";
import { slicePartPathCandidates } from "@/lib/episodic/paths";
import { migrateToV3 } from "@/lib/episodic/previously-format";
import { annotateSliceWithLocalTime, sliceLocalBanner } from "@/lib/episodic/time-localize";
import { splitParagraphs, segmentSearch, textLines, searchResultToString } from "@/lib/retrieval/doc-segments";

// ─── Categories (the leaf module owns the enum; re-exported here) ─────────

export { RECALL_CATEGORIES, isRecallCategory };
export type { RecallCategory };

/** Case-tree directories backing each case-shaped facade category. */
const CASE_TREE_DIRS: Record<string, string[]> = {
  events: ["events"],
  people: ["people"],
  things: ["things"],
  tasks: ["tasks"],
  research: ["research", "hypotheses"],
  self: ["self"],
  places: ["places"],
  orgs: ["orgs"],
};

const CASE_TREE_DIR_SET = new Set<string>(CASE_CATEGORIES);

function treeDirInCategories(treeDir: string): boolean {
  return CASE_TREE_DIR_SET.has(treeDir);
}

/** Map a tree directory to its facade category (hypotheses folds into research). */
function facadeCategoryForTreeDir(treeDir: string): RecallCategory {
  return treeDir === "hypotheses" ? "research" : (treeDir as RecallCategory);
}

// ─── Entries and the result envelope ──────────────────────────────────────

/** The unified entry shape — all four verbs return entries at this grain. */
export interface MemoryEntry {
  /** The read-back key, copy-paste ready: "events/手机", "records/2026-10-14-1836", "self/search". */
  ref: string;
  category: RecallCategory;
  /** Subtype: case / piece / hypothesis / slice / sop / agenda / profile. */
  kind?: string;
  /** Case name / slice focus / piece title / document name. */
  title: string;
  /** YYYY-MM-DD — free from the path or frontmatter (same-source discipline). */
  date: string;
  /** Summary or hit snippet; fixed-length, NEVER the whole file. */
  excerpt: string;
  /** Cases only: the last-write stamp (ISO). */
  updated?: string;
  /** Slices only: derived from the close marker. */
  status?: "active" | "closed";
}

/**
 * The discriminated union — the spine of the design (v0.36 §3.1). "No match,
 * here is the recent" (fallback) and "nothing here" (empty) are different
 * TYPES, and "cannot read" (unavailable) is strictly separate from "absent".
 */
export type RecallResult =
  | {
      kind: "entries";
      entries: MemoryEntry[];
      scanned: number;
      truncated: boolean;
      /** Page start (default 0) — present only when an offset was requested. */
      offset?: number;
      /** True when offset landed past the end — an empty page, not absence. */
      pastEnd?: boolean;
      /** Total matching entries in scope (search only: scanned ≠ total). */
      total?: number;
      /**
       * recallFind only: the hit was adopted by approximate name matching —
       * this is the stored (true) name the query resolved to.
       */
      matchedName?: string;
    }
  | { kind: "fallback"; reason: "no_match"; entries: MemoryEntry[] }
  | { kind: "empty" }
  | { kind: "not_found"; nearMisses: MemoryEntry[] }
  | { kind: "unavailable"; note: string };

/** The read verb's own outcome union. */
export type RecallReadResult =
  | {
      kind: "content";
      content: string;
      path: string;
      /** The ref actually read when it was resolved approximately. */
      matchedRef?: string;
    }
  | { kind: "not_found"; nearMisses?: MemoryEntry[] }
  | { kind: "unavailable"; note: string };

// ─── Defaults and caps (v0.36 §2 / §5, ruling #4) ─────────────────────────

export const RECENT_DEFAULT_N = 10;
export const RECENT_MAX_N = 30;
export const SEARCH_DEFAULT_LIMIT = 20;
export const SEARCH_MAX_LIMIT = 30;
/** Files scanned per search call, newest-first; older candidates report truncated. */
export const SEARCH_SCAN_CAP = 50;
/** A slice's "head" for default-scope search: frontmatter + this many body lines. */
const SLICE_HEAD_LINES = 30;
/** Excerpt ceiling (v0.36 §2.1). */
export const EXCERPT_MAX_CHARS = 160;

// ─── Backend ──────────────────────────────────────────────────────────────

/**
 * The two storage primitives the facade needs. Both are read-only. `readFile`
 * takes a repo-relative path and throws when the file is absent; `listMemoryFiles`
 * returns every file path under memory/ (repo-relative) — the tree IS the
 * enumeration, so listing is the only "index" this layer ever touches.
 */
export interface RecallBackend {
  listMemoryFiles(): Promise<string[]>;
  readFile(path: string): Promise<string>;
}

/** True when a thrown read error means "absent", not "unreadable". */
function isAbsentError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /^(File not found|Directory not found|Access denied)|is (a directory, not a file|not a regular file)/.test(
    msg,
  );
}

// ─── Tree index (paths only — zero content reads) ─────────────────────────

interface CaseNode {
  treeDir: string;
  caseName: string;
  indexPath: string | null;
  /** Repo-relative dated piece paths, ascending. */
  pieces: string[];
}

interface MemoryTreeIndex {
  cases: CaseNode[];
  /** Slice ids "YYYY-MM-DD-HHMM", ascending (id order = chronological). */
  slices: string[];
  agendaPath: string | null;
  profilePath: string | null;
}

const RECORDS_CORE_RE = /^memory\/records\/(\d{4})\/(\d{2})\/(\d{2})\/(\d{4})\/core\.md$/;
const LEGACY_CORE_RE =
  /^memory\/episodic\/slices\/(\d{4})\/(\d{2})\/(\d{2})\/(\d{4})\/timeline\/core\.md$/;
const CASE_INDEX_RE = /^memory\/(people|events|things|places|orgs|research|hypotheses|tasks|self)\/([^/]+)\/index\.md$/;
const PIECE_NAME_RE = /^\d{4}-\d{2}-\d{2}-[^/]+\.md$/;

/**
 * Classify the flat path list into cases / slices / the two bare files.
 * Pure — no I/O. config/, user/config.json, and attachment bytes never
 * become entries.
 */
export function buildTreeIndex(paths: string[]): MemoryTreeIndex {
  const cases = new Map<string, CaseNode>();
  const slices = new Set<string>();
  let agendaPath: string | null = null;
  let profilePath: string | null = null;

  const nodeFor = (treeDir: string, caseName: string): CaseNode => {
    const key = `${treeDir}/${caseName}`;
    let node = cases.get(key);
    if (!node) {
      node = { treeDir, caseName, indexPath: null, pieces: [] };
      cases.set(key, node);
    }
    return node;
  };

  for (const path of paths) {
    if (!path.startsWith(`${MEMORY_ROOT_DIR}/`)) continue;
    if (path.startsWith("memory/config/") || path === "memory/user/config.json") continue;
    if (path.includes("/attachments/")) continue;

    const recordsMatch = RECORDS_CORE_RE.exec(path) ?? LEGACY_CORE_RE.exec(path);
    if (recordsMatch) {
      slices.add(
        `${recordsMatch[1]}-${recordsMatch[2]}-${recordsMatch[3]}-${recordsMatch[4]}`,
      );
      continue;
    }
    if (path === "memory/self/agenda.md") {
      agendaPath = path;
      continue;
    }
    if (path === "memory/people/user/profile.md") {
      profilePath = path;
      continue;
    }
    const indexMatch = CASE_INDEX_RE.exec(path);
    if (indexMatch) {
      nodeFor(indexMatch[1]!, indexMatch[2]!).indexPath = path;
      continue;
    }
    const segs = path.split("/");
    if (
      segs.length === 4 &&
      typeof segs[1] === "string" &&
      CASE_TREE_DIR_SET.has(segs[1] as CaseCategory) &&
      PIECE_NAME_RE.test(segs[3]!)
    ) {
      nodeFor(segs[1], segs[2]!).pieces.push(path);
    }
  }

  for (const node of cases.values()) node.pieces.sort();
  return {
    cases: [...cases.values()],
    slices: [...slices].sort(),
    agendaPath,
    profilePath,
  };
}

// ─── Excerpt rules (v0.36 §2.1 — pinned per entry type) ───────────────────

/** First prose line of a case body: skip blanks, headings, the tail marker. */
export function firstProseLine(body: string): string {
  for (const line of body.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith("#")) continue;
    if (/^——/.test(t)) continue;
    if (/^(-{3,}|_{3,}|\*{3,})$/.test(t)) continue;
    return t;
  }
  return "";
}

/** Case-index excerpt: the first prose line after the frontmatter. */
function caseIndexExcerpt(docBody: string): string {
  return firstProseLine(docBody);
}

/** self/agenda: the first `- [due: …]` line; else the first line. */
function agendaExcerpt(raw: string): string {
  for (const line of raw.split("\n")) {
    if (/^\s*-\s*\[due:[^\]]*\]/.test(line)) return line.trim();
  }
  return firstProseLine(raw);
}

/** people/user/profile: the first non-empty, non-heading line. */
function profileExcerpt(raw: string): string {
  return firstProseLine(raw);
}

function truncateExcerpt(s: string): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > EXCERPT_MAX_CHARS ? `${t.slice(0, EXCERPT_MAX_CHARS)}…` : t;
}

// ─── Entry builders (one small read each; blob cache absorbs repeats) ─────

interface BuiltEntry {
  entry: MemoryEntry;
  /** The activity date — recent's sort key (v0.36 §7-3: birth ≠ activity). */
  activity: string;
}

function pieceTitle(piecePath: string): string {
  const fileName = piecePath.slice(piecePath.lastIndexOf("/") + 1);
  const parsed = parsePieceFileName(fileName);
  return parsed?.title ?? fileName.replace(/\.md$/, "");
}

function pieceDate(piecePath: string): string {
  const fileName = piecePath.slice(piecePath.lastIndexOf("/") + 1);
  return parsePieceFileName(fileName)?.date ?? "";
}

function nodeCategory(node: CaseNode): RecallCategory {
  return facadeCategoryForTreeDir(node.treeDir);
}

function nodeKind(node: CaseNode): string {
  if (node.treeDir === "hypotheses") return "hypothesis";
  if (node.treeDir === "self") return "sop";
  return "case";
}

/** Latest piece date of a case — "" when the case has no pieces. */
function latestPieceDate(node: CaseNode): string {
  return node.pieces.length > 0 ? pieceDate(node.pieces[node.pieces.length - 1]!) : "";
}

function maxDate(a: string, b: string): string {
  return a >= b ? a : b;
}

/** Build the case-level entry (index.md header + body first line). */
async function buildCaseEntry(
  backend: RecallBackend,
  node: CaseNode,
): Promise<BuiltEntry | null> {
  if (!node.indexPath) return null;
  let raw: string;
  try {
    raw = await backend.readFile(node.indexPath);
  } catch {
    return null; // unreadable — the caller counts this as a failure
  }
  const doc = parseCaseDoc(raw, {
    category: node.treeDir as CaseCategory,
    caseName: node.caseName,
    fileName: "index.md",
  });
  const activity = maxDate(doc.updated.slice(0, 10), latestPieceDate(node));
  const category = nodeCategory(node);
  return {
    entry: {
      ref: `${category}/${node.caseName}`,
      category,
      kind: nodeKind(node),
      title: node.caseName,
      date: doc.opened || activity,
      excerpt: truncateExcerpt(caseIndexExcerpt(doc.body)),
      updated: doc.updated,
    },
    activity: activity || doc.opened,
  };
}

/** Build one dated-piece entry. */
async function buildPieceEntry(
  backend: RecallBackend,
  node: CaseNode,
  piecePath: string,
): Promise<BuiltEntry | null> {
  let raw: string;
  try {
    raw = await backend.readFile(piecePath);
  } catch {
    return null;
  }
  const fileName = piecePath.slice(piecePath.lastIndexOf("/") + 1);
  const doc = parseCaseDoc(raw, {
    category: node.treeDir as CaseCategory,
    caseName: node.caseName,
    fileName,
  });
  const category = nodeCategory(node);
  const date = pieceDate(piecePath) || doc.opened;
  return {
    entry: {
      ref: `${category}/${node.caseName}/${fileName.replace(/\.md$/, "")}`,
      category,
      kind: node.treeDir === "hypotheses" ? "hypothesis" : "piece",
      title: pieceTitle(piecePath),
      date,
      excerpt: truncateExcerpt(firstProseLine(doc.body)),
      updated: doc.updated,
    },
    activity: date,
  };
}

async function readSliceRaw(
  backend: RecallBackend,
  sliceId: string,
  part: "core" | "agent" | "previously",
): Promise<string> {
  const [primary, fallback] = slicePartPathCandidates(sliceId, part);
  try {
    return await backend.readFile(primary);
  } catch {
    return backend.readFile(fallback);
  }
}

/** Coerce frontmatter scalars — gray-matter parses "A: B" strings as objects. */
function fmStr(v: unknown): string {
  if (typeof v === "string") return v;
  if (v && typeof v === "object") return Object.keys(v)[0] ?? "";
  return "";
}

/** The slice's default excerpt: focus; missing → first user turn's first line. */
function sliceExcerpt(raw: string): { excerpt: string; title: string; closed: boolean } {
  let focus = "";
  let closed = false;
  try {
    const { data } = matter(raw);
    focus = fmStr(data.focus);
    closed = data.status === "closed" || Boolean(fmStr(data.closed_by));
  } catch {
    // unparsable header — degrade to the turn fallback
  }
  let firstUserLine = "";
  try {
    const { turns } = parseTurns(raw);
    const firstUser = turns.find((t) => /\((\w+)\)/.exec(t.header)?.[1] === "user");
    firstUserLine = firstUser?.content.split("\n").find((l) => l.trim())?.trim() ?? "";
  } catch {
    // leave empty
  }
  const excerpt = focus || firstUserLine;
  return {
    excerpt: truncateExcerpt(excerpt),
    title: focus || firstUserLine ? excerpt.split("。")[0] ?? excerpt : "",
    closed,
  };
}

/** Build a slice-head entry (records or timeline category). */
async function buildSliceEntry(
  backend: RecallBackend,
  sliceId: string,
  category: "records" | "timeline",
): Promise<BuiltEntry | null> {
  let raw: string;
  try {
    raw = await readSliceRaw(backend, sliceId, "core");
  } catch {
    return null;
  }
  const { excerpt, title, closed } = sliceExcerpt(raw);
  const date = sliceId.slice(0, 10);
  return {
    entry: {
      ref: `records/${sliceId}`,
      category,
      kind: "slice",
      title: title || `Slice ${sliceId}`,
      date,
      excerpt,
      status: closed ? "closed" : "active",
    },
    activity: date,
  };
}

async function buildAgendaEntry(backend: RecallBackend, path: string): Promise<BuiltEntry | null> {
  try {
    const raw = await backend.readFile(path);
    return {
      entry: {
        ref: "self/agenda",
        category: "self",
        kind: "agenda",
        title: "agenda",
        date: "",
        excerpt: truncateExcerpt(agendaExcerpt(raw)),
      },
      activity: "",
    };
  } catch {
    return null;
  }
}

async function buildProfileEntry(backend: RecallBackend, path: string): Promise<BuiltEntry | null> {
  try {
    const raw = await backend.readFile(path);
    return {
      entry: {
        ref: "people/user/profile",
        category: "people",
        kind: "profile",
        title: "profile",
        date: "",
        excerpt: truncateExcerpt(profileExcerpt(raw)),
      },
      activity: "",
    };
  } catch {
    return null;
  }
}

// ─── Shared scope helpers ─────────────────────────────────────────────────

interface ScopeEntry {
  built: BuiltEntry;
  /** Where the entry came from — for unavailable accounting. */
  sourcePath: string;
}

/** Case-shaped categories (everything but timeline/records). */
function isCaseCategory(c: RecallCategory): boolean {
  return c !== "timeline" && c !== "records";
}

/**
 * Gather the candidate entries of one category (or all, when omitted).
 * Bare-file specials ride along for people (profile) and self (agenda).
 */
async function gatherScopeEntries(
  backend: RecallBackend,
  index: MemoryTreeIndex,
  category: RecallCategory | undefined,
): Promise<ScopeEntry[]> {
  const out: ScopeEntry[] = [];
  const wantNode = (node: CaseNode): boolean => {
    if (category === undefined) return true;
    return isCaseCategory(category) && nodeCategory(node) === category;
  };

  for (const node of index.cases) {
    if (!wantNode(node) || !node.indexPath) continue;
    const built = await buildCaseEntry(backend, node);
    if (built) out.push({ built, sourcePath: node.indexPath });
  }
  if (category === undefined || category === "self") {
    if (index.agendaPath) {
      const built = await buildAgendaEntry(backend, index.agendaPath);
      if (built) out.push({ built, sourcePath: index.agendaPath });
    }
  }
  if (category === undefined || category === "people") {
    if (index.profilePath) {
      const built = await buildProfileEntry(backend, index.profilePath);
      if (built) out.push({ built, sourcePath: index.profilePath });
    }
  }
  if (category === undefined || category === "records" || category === "timeline") {
    const sliceCategory = category === "timeline" ? "timeline" : "records";
    for (const sliceId of index.slices) {
      const built = await buildSliceEntry(backend, sliceId, sliceCategory);
      if (built) out.push({ built, sourcePath: `records/${sliceId}` });
    }
  }
  return out;
}

function inDateRange(activity: string, after?: string, before?: string): boolean {
  if (after && activity < after) return false;
  if (before && activity > before) return false;
  return true;
}

// ─── Verb ① recallRecent ──────────────────────────────────────────────────

export interface RecallRecentInput {
  category?: RecallCategory;
  /** Default 10, hard cap 30. */
  n?: number;
  /** Page start, default 0 — entries before it are skipped (newest-first paging). */
  offset?: number;
  /** Inclusive day bounds (user calendar, string day comparison). */
  before?: string;
  after?: string;
}

export async function recallRecent(
  backend: RecallBackend,
  input: RecallRecentInput,
): Promise<RecallResult> {
  const n = Math.min(Math.max(1, Math.floor(input.n ?? RECENT_DEFAULT_N)), RECENT_MAX_N);
  const offset = Math.max(0, Math.floor(input.offset ?? 0));
  let index: MemoryTreeIndex;
  try {
    index = buildTreeIndex(await backend.listMemoryFiles());
  } catch (e) {
    throw e; // a listing failure is infrastructure — the step retry handles it
  }

  const scope = await gatherScopeEntries(backend, index, input.category);
  const filtered = scope.filter((s) =>
    inDateRange(s.built.activity, input.after, input.before),
  );
  if (filtered.length === 0) {
    return { kind: "empty" };
  }
  filtered.sort((a, b) => (a.built.activity >= b.built.activity ? -1 : 1));
  if (offset >= filtered.length) {
    return {
      kind: "entries",
      entries: [],
      scanned: filtered.length,
      truncated: false,
      offset,
      pastEnd: true,
    };
  }
  const page = filtered.slice(offset, offset + n);
  return {
    kind: "entries",
    entries: page.map((s) => s.built.entry),
    scanned: filtered.length,
    truncated: filtered.length > offset + page.length,
    // Offset rides the result only when the caller actually paged — a full
    // page then teaches the model how to continue.
    ...(input.offset !== undefined ? { offset } : {}),
  };
}

// ─── Verb ② recallFind ────────────────────────────────────────────────────

export interface RecallFindInput {
  category: RecallCategory;
  name: string;
}

/** NFKC fold for approximate name matching (case-refs' folding discipline). */
function foldName(s: string): string {
  return s.normalize("NFKC");
}

// ─── Approximate name matching (v0.11 — the "只差一个空格" lesson) ─────────
//
// The agent recalls names from memory, not by copy-paste: one missing space,
// one full-width paren, one half-width comma and the verbatim compare dies.
// So names are normalized before scoring, scored by three bounded signals,
// and a UNIQUE STRONG candidate is adopted outright (with the true name
// reported back) instead of returning a miss.

/**
 * Punctuation the NFKC fold does not touch, mapped to a canonical ASCII
 * form: 、。… the dash family, and the CJK quote marks. (NFKC itself already
 * folds the full-width ASCII shapes （），：；！？ to half-width.)
 */
const CJK_PUNCT_MAP: Record<string, string> = {
  "、": ",",
  "。": ".",
  "…": ".",
  "—": "-",
  "–": "-",
  "―": "-",
  "‐": "-",
  "‑": "-",
  "‒": "-",
  "−": "-",
  "「": '"',
  "」": '"',
  "『": '"',
  "』": '"',
  "“": '"',
  "”": '"',
  "‘": "'",
  "’": "'",
};

/**
 * The name-normalization both sides go through before comparison: NFKC,
 * case fold, CJK punctuation map, collapse runs of identical punctuation,
 * strip ALL whitespace. Pure and total.
 */
export function normalizeRecallName(s: string): string {
  const folded = s.normalize("NFKC").toLowerCase();
  let out = "";
  for (const ch of folded) out += CJK_PUNCT_MAP[ch] ?? ch;
  return out
    .replace(/([\p{P}\p{S}])\1+/gu, "$1")
    .replace(/\s+/g, "");
}

/** Levenshtein beyond this length is skipped — bigram dice covers long names. */
const NAME_SCORE_LEN_CAP = 64;

/** Char-bigram Dice coefficient — the CJK-friendly similarity signal. */
function bigramDice(a: string, b: string): number {
  const grams = (s: string): Map<string, number> => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i += 1) {
      const g = s.slice(i, i + 2);
      m.set(g, (m.get(g) ?? 0) + 1);
    }
    return m;
  };
  const ga = grams(a);
  const gb = grams(b);
  let overlap = 0;
  for (const [g, n] of ga) overlap += Math.min(n, gb.get(g) ?? 0);
  const total = a.length - 1 + (b.length - 1);
  return total > 0 ? (2 * overlap) / total : 0;
}

/** 1 − (edit distance / max length), two-row DP, bounded by NAME_SCORE_LEN_CAP. */
function levenshteinRatio(a: string, b: string): number {
  const n = a.length;
  const m = b.length;
  if (Math.max(n, m) > NAME_SCORE_LEN_CAP) return 0;
  let prev = Array.from({ length: m + 1 }, (_, j) => j);
  for (let i = 1; i <= n; i += 1) {
    const cur: number[] = [i];
    for (let j = 1; j <= m; j += 1) {
      cur[j] = Math.min(
        prev[j]! + 1,
        cur[j - 1]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return 1 - prev[m]! / Math.max(n, m);
}

/**
 * Similarity of two ALREADY-normalized names in [0, 1] — the strongest of:
 * substring containment (length-weighted), char-bigram Dice, Levenshtein
 * ratio. Every signal is O(len²) at worst and length-capped.
 */
export function nameSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  let score = 0;
  if (a.includes(b) || b.includes(a)) {
    const short = Math.min(a.length, b.length);
    const long = Math.max(a.length, b.length);
    score = 0.55 + 0.45 * (short / long);
  }
  return Math.max(score, bigramDice(a, b), levenshteinRatio(a, b));
}

/** Auto-adopt floor: the best candidate must reach this score… */
const NAME_MATCH_MIN_SCORE = 0.85;
/** …and lead the runner-up by at least this margin (both "very alike" → ask). */
const NAME_MATCH_MIN_MARGIN = 0.1;
/** Below this score a candidate is not even worth listing as a near miss. */
const NEAR_MISS_MIN_SCORE = 0.3;
const NEAR_MISS_MAX = 5;

/**
 * The unique-strong-candidate rule: highest score ≥ NAME_MATCH_MIN_SCORE AND
 * ahead of the second-highest by ≥ NAME_MATCH_MIN_MARGIN. Returns null when
 * the field is ambiguous or weak — the caller then reports near misses.
 */
function bestUniqueNameMatch<T>(
  items: readonly T[],
  scoreOf: (item: T) => number,
): { item: T; score: number } | null {
  let best: { item: T; score: number } | null = null;
  let second = 0;
  for (const item of items) {
    const score = scoreOf(item);
    if (!best || score > best.score) {
      second = best?.score ?? 0;
      best = { item, score };
    } else if (score > second) {
      second = score;
    }
  }
  if (!best) return null;
  if (best.score < NAME_MATCH_MIN_SCORE) return null;
  if (best.score - second < NAME_MATCH_MIN_MARGIN) return null;
  return best;
}

export async function recallFind(
  backend: RecallBackend,
  input: RecallFindInput,
): Promise<RecallResult> {
  const index = buildTreeIndex(await backend.listMemoryFiles());
  const name = normalizeCaseRefText(input.name);
  const { category } = input;

  // records / timeline: the name is a slice id (or truncated to a day).
  if (category === "records" || category === "timeline") {
    const sliceCategory = category === "timeline" ? "timeline" : "records";
    const exact =
      /^\d{4}-\d{2}-\d{2}-\d{4}$/.test(name) && index.slices.includes(name)
        ? [name]
        : [];
    const byDay = /^\d{4}-\d{2}-\d{2}$/.test(name)
      ? index.slices.filter((s) => s.startsWith(name))
      : [];
    const hits = exact.length > 0 ? exact : byDay;
    if (hits.length === 0) {
      const nearIds = index.slices
        .filter((s) => name.length >= 4 && (s.startsWith(name) || s.includes(name)))
        .slice(-5)
        .reverse();
      const nearMisses: MemoryEntry[] = [];
      for (const id of nearIds) {
        const built = await buildSliceEntry(backend, id, sliceCategory);
        if (built) nearMisses.push(built.entry);
      }
      return { kind: "not_found", nearMisses };
    }
    const entries: MemoryEntry[] = [];
    for (const id of hits) {
      const built = await buildSliceEntry(backend, id, sliceCategory);
      if (built) entries.push(built.entry);
    }
    if (entries.length === 0) {
      return { kind: "unavailable", note: "slice heads could not be read" };
    }
    return { kind: "entries", entries, scanned: hits.length, truncated: false };
  }

  // self: a document name (the agenda rides along as a reserved entry).
  if (category === "self" && name === "agenda" && index.agendaPath) {
    const built = await buildAgendaEntry(backend, index.agendaPath);
    if (built) {
      return { kind: "entries", entries: [built.entry], scanned: 1, truncated: false };
    }
    return { kind: "unavailable", note: "self/agenda could not be read" };
  }

  // Case categories: the name is a case name (identity compare, NFKC fallback).
  const dirs = CASE_TREE_DIRS[category] ?? [];
  const nodes = index.cases.filter(
    (n) => dirs.includes(n.treeDir) && n.indexPath,
  );
  const folded = foldName(name);
  const exactNode = nodes.find(
    (n) => n.caseName === name || foldName(n.caseName) === folded,
  );
  if (exactNode) {
    const built = await buildCaseEntry(backend, exactNode);
    if (built) {
      return { kind: "entries", entries: [built.entry], scanned: 1, truncated: false };
    }
    return { kind: "unavailable", note: `${exactNode.indexPath} could not be read` };
  }

  // Fuzzy fallback: normalized-name scoring over the same scope. A unique
  // strong candidate is adopted outright (the true name rides the result);
  // otherwise the scored near misses come back sorted best-first — a miss is
  // still not proof of absence.
  const queryNorm = normalizeRecallName(name);
  const scored = nodes
    .map((node) => ({
      node,
      score: nameSimilarity(normalizeRecallName(node.caseName), queryNorm),
    }))
    .sort((x, y) => y.score - x.score);
  const unique = bestUniqueNameMatch(scored, (s) => s.score);
  if (unique) {
    const built = await buildCaseEntry(backend, unique.item.node);
    if (built) {
      return {
        kind: "entries",
        entries: [built.entry],
        scanned: 1,
        truncated: false,
        matchedName: unique.item.node.caseName,
      };
    }
    return { kind: "unavailable", note: `${unique.item.node.indexPath} could not be read` };
  }
  const nearNodes = scored
    .filter((s) => s.score >= NEAR_MISS_MIN_SCORE)
    .slice(0, NEAR_MISS_MAX);
  const nearMisses: MemoryEntry[] = [];
  let nearFailures = 0;
  for (const { node } of nearNodes) {
    const built = await buildCaseEntry(backend, node);
    if (built) nearMisses.push(built.entry);
    else nearFailures += 1;
  }
  if (nearNodes.length > 0 && nearMisses.length === 0 && nearFailures > 0) {
    return { kind: "unavailable", note: "candidate case headers could not be read" };
  }
  return { kind: "not_found", nearMisses };
}

// ─── Verb ③ recallSearch ──────────────────────────────────────────────────

export interface RecallSearchInput {
  /** One keyword or several — every keyword must hit (AND within a segment). */
  query: string | string[];
  /** Omitted = ALL structured documents (cases + self + timeline heads) —
   *  records (raw conversation) are scanned ONLY when this is "records" or
   *  includeRecords is true (v0.36 §3 扫描面纪律). */
  category?: RecallCategory;
  includeRecords?: boolean;
  /** Inclusive day bounds on the entry's activity date. */
  since?: string;
  until?: string;
  /** Default 20, hard cap 30. */
  limit?: number;
  /** Page start, default 0 — hits before it are skipped (newest-first paging). */
  offset?: number;
}

/** One searchable document: where it lives, how to build its entry, its sort date. */
interface SearchUnit {
  docPath: string;
  /** Set for slice units — slices read through the dual-root core path. */
  sliceId?: string;
  activity: string;
  /** Slices in the default scope scan only the bounded head, not the body. */
  sliceHeadOnly: boolean;
  build(raw: string): Promise<BuiltEntry | null>;
}

async function gatherSearchUnits(
  backend: RecallBackend,
  index: MemoryTreeIndex,
  input: RecallSearchInput,
): Promise<SearchUnit[]> {
  const units: SearchUnit[] = [];
  const scanSlicesHeads = input.category === undefined || input.category === "timeline";
  const scanSlicesFull =
    input.category === "records" || (input.category === undefined && input.includeRecords === true);

  const wantDir = (treeDir: string): boolean => {
    if (input.category === undefined) return treeDirInCategories(treeDir);
    return (CASE_TREE_DIRS[input.category] ?? []).includes(treeDir);
  };

  for (const node of index.cases) {
    if (!wantDir(node.treeDir)) continue;
    // Sort key needs the header — one cached read per case in scope.
    let caseActivity = latestPieceDate(node);
    if (node.indexPath) {
      try {
        const raw = await backend.readFile(node.indexPath);
        const doc = parseCaseDoc(raw, {
          category: node.treeDir as CaseCategory,
          caseName: node.caseName,
          fileName: "index.md",
        });
        caseActivity = maxDate(doc.updated.slice(0, 10), caseActivity);
      } catch {
        // header unreadable — fall back to the piece-date sort key
      }
      units.push({
        docPath: node.indexPath,
        activity: caseActivity,
        sliceHeadOnly: false,
        build: async (raw) => {
          const doc = parseCaseDoc(raw, {
            category: node.treeDir as CaseCategory,
            caseName: node.caseName,
            fileName: "index.md",
          });
          const category = nodeCategory(node);
          return {
            entry: {
              ref: `${category}/${node.caseName}`,
              category,
              kind: nodeKind(node),
              title: node.caseName,
              date: doc.opened || caseActivity,
              excerpt: "",
              updated: doc.updated,
            },
            activity: caseActivity,
          };
        },
      });
    }
    for (const piecePath of node.pieces) {
      const date = pieceDate(piecePath);
      units.push({
        docPath: piecePath,
        activity: date,
        sliceHeadOnly: false,
        build: (raw) => {
          const fileName = piecePath.slice(piecePath.lastIndexOf("/") + 1);
          const doc = parseCaseDoc(raw, {
            category: node.treeDir as CaseCategory,
            caseName: node.caseName,
            fileName,
          });
          const category = nodeCategory(node);
          return Promise.resolve({
            entry: {
              ref: `${category}/${node.caseName}/${fileName.replace(/\.md$/, "")}`,
              category,
              kind: node.treeDir === "hypotheses" ? "hypothesis" : "piece",
              title: pieceTitle(piecePath),
              date,
              excerpt: "",
              updated: doc.updated,
            },
            activity: date,
          });
        },
      });
    }
  }

  if (input.category === undefined || input.category === "self") {
    if (index.agendaPath) {
      const path = index.agendaPath;
      units.push({
        docPath: path,
        activity: "",
        sliceHeadOnly: false,
        build: () => buildAgendaEntry(backend, path),
      });
    }
  }
  if (input.category === undefined || input.category === "people") {
    if (index.profilePath) {
      const path = index.profilePath;
      units.push({
        docPath: path,
        activity: "",
        sliceHeadOnly: false,
        build: () => buildProfileEntry(backend, path),
      });
    }
  }

  if (scanSlicesHeads || scanSlicesFull) {
    for (const sliceId of index.slices) {
      const date = sliceId.slice(0, 10);
      units.push({
        docPath: `records/${sliceId}`,
        sliceId,
        activity: date,
        // Default scope without the flag: heads only. Every explicit records
        // path (category "records", or includeRecords) scans the FULL body.
        sliceHeadOnly: scanSlicesHeads && !scanSlicesFull,
        build: async (raw) => {
          const { excerpt, title, closed } = sliceExcerpt(raw);
          const category: RecallCategory = input.category === "timeline" ? "timeline" : "records";
          return {
            entry: {
              ref: `records/${sliceId}`,
              category,
              kind: "slice",
              title: title || `Slice ${sliceId}`,
              date,
              excerpt,
              status: closed ? "closed" : "active",
            },
            activity: date,
          };
        },
      });
    }
  }
  return units;
}

/** The bounded "head" of a slice core: frontmatter + the first body lines. */
export function sliceHeadText(raw: string, maxLines = SLICE_HEAD_LINES): string {
  const match = /^---\n[\s\S]*?\n---\n?/.exec(raw);
  const frontmatter = match?.[0] ?? "";
  const body = match ? raw.slice(match[0].length) : raw;
  return frontmatter + body.split("\n").slice(0, maxLines).join("\n");
}

export async function recallSearch(
  backend: RecallBackend,
  input: RecallSearchInput,
): Promise<RecallResult> {
  const keywords = (Array.isArray(input.query) ? input.query : [input.query])
    .map((q) => q.trim())
    .filter((q) => q.length > 0);
  const limit = Math.min(
    Math.max(1, Math.floor(input.limit ?? SEARCH_DEFAULT_LIMIT)),
    SEARCH_MAX_LIMIT,
  );
  const offset = Math.max(0, Math.floor(input.offset ?? 0));
  if (keywords.length === 0) {
    return { kind: "unavailable", note: "empty query" };
  }

  const index = buildTreeIndex(await backend.listMemoryFiles());
  const units = (await gatherSearchUnits(backend, index, input)).filter((u) =>
    inDateRange(u.activity, input.since, input.until),
  );
  if (units.length === 0) return { kind: "empty" };

  // Newest-first: the scan cap discards the OLDEST candidates (v0.36 §3.1).
  units.sort((a, b) => (a.activity >= b.activity ? -1 : 1));
  const scanned = Math.min(units.length, SEARCH_SCAN_CAP);
  const truncatedByScan = units.length > SEARCH_SCAN_CAP;
  const scanUnits = units.slice(0, SEARCH_SCAN_CAP);

  const hits: MemoryEntry[] = [];
  let readFailures = 0;
  for (const unit of scanUnits) {
    let raw: string;
    try {
      raw = unit.sliceId
        ? await readSliceRaw(backend, unit.sliceId, "core")
        : await backend.readFile(unit.docPath);
    } catch {
      readFailures += 1;
      continue;
    }
    if (unit.sliceHeadOnly) raw = sliceHeadText(raw);
    const segments = splitParagraphs(raw);
    const found = segmentSearch(segments, keywords, 1, 1);
    if (found.length === 0) continue;
    const built = await unit.build(raw);
    if (!built) continue;
    built.entry.excerpt = truncateExcerpt(found[0]!.content);
    hits.push(built.entry);
  }

  if (hits.length === 0) {
    if (readFailures === scanned) {
      return { kind: "unavailable", note: "every candidate document failed to read" };
    }
    // No match but the scope has content → the recent list is the fallback.
    const recent = await recallRecent(backend, { category: input.category, n: RECENT_DEFAULT_N });
    const entries = recent.kind === "entries" ? recent.entries : [];
    return { kind: "fallback", reason: "no_match", entries };
  }

  if (offset >= hits.length) {
    return {
      kind: "entries",
      entries: [],
      scanned,
      truncated: truncatedByScan,
      offset,
      pastEnd: true,
      total: hits.length,
    };
  }
  const page = hits.slice(offset, offset + limit);
  const truncatedByLimit = hits.length > offset + page.length;
  return {
    kind: "entries",
    entries: page,
    scanned,
    truncated: truncatedByScan || truncatedByLimit,
    // Offset rides the result only when the caller actually paged.
    ...(input.offset !== undefined ? { offset } : {}),
    total: hits.length,
  };
}

// ─── Verb ④ recallRead ────────────────────────────────────────────────────

export interface RecallReadRange {
  type: "turns" | "last" | "date" | "search" | "lines";
  indices?: number[];
  count?: number;
  after?: string;
  keywords?: string[];
  context?: number;
  start?: number;
  end?: number;
}

export interface RecallReadInput {
  /** An entry ref, copy-pasted from a recall result. */
  ref: string;
  /** records only: which slice part (default "core"). */
  part?: "core" | "agent" | "previously";
  /** records core only: the five range filters. */
  range?: RecallReadRange;
  /** User-local rendering for slice parts (turn annotation / snapshot banner). */
  timezone?: string;
}

/** Apply the five range filters to a slice core — the readSlice protocol. */
export function applySliceRange(sliceId: string, raw: string, range?: RecallReadRange): string {
  if (!range) return raw;
  if (range.type === "search") {
    const keywords = range.keywords ?? [];
    const context = range.context ?? 1;
    const turns = sliceTurnSegments(raw);
    const hits = segmentSearch(turns, keywords, context, context);
    return searchResultToString(sliceId, keywords, hits, raw);
  }
  if (range.type === "lines") {
    const { content, clamped } = textLines(raw, range.start ?? 1, range.end ?? 1);
    if (content === "" && (range.start ?? 1) > (range.end ?? 1)) {
      return `ERROR: Invalid line range ${range.start}-${range.end} in ${sliceId}.`;
    }
    const header = `Lines ${range.start}-${range.end} of ${sliceId}${clamped ? " (clamped)" : ""}:\n\n`;
    return content === "" ? `${header}(empty range)` : header + content;
  }
  if (range.type === "turns" || range.type === "last" || range.type === "date") {
    const { frontmatter, turns } = parseTurns(raw);
    const filtered = applyRange(turns, { ...range, type: range.type });
    return filtered.length === 0
      ? `${frontmatter}\n\n_(No turns matched the requested range.)_`
      : reassembleSlice(frontmatter, filtered);
  }
  return `ERROR: Unknown range type "${range.type}" in ${sliceId}.`;
}

/** Split a slice core into turn segments (the episodic turn-parser split). */
function sliceTurnSegments(raw: string): string[] {
  return parseTurns(raw)
    .turns.map((t) => `${t.header}\n${t.content}`.trim())
    .filter((s) => s.length > 0);
}

/** Resolve a ref to candidate paths, new root first (research ↔ hypotheses). */
function recallReadCandidates(ref: string): string[] | null {
  const normalized = normalizeCaseRefText(ref);
  if (!normalized) return null;
  const parsed = parseCaseRef(normalized);
  if (!parsed) return null;
  const candidates = resolveCaseRefPaths(parsed);
  // research on the facade covers hypotheses on the tree (ruling #2) —
  // probe both dirs for a two-segment research ref.
  if (parsed.kind !== "legacy") {
    const dirs =
      parsed.category === "research"
        ? (["research", "hypotheses"] as const)
        : ([parsed.category] as const);
    const extra: string[] = [];
    for (const dir of dirs) {
      if (dir === parsed.category) continue;
      if (parsed.kind === "case") {
        extra.push(`memory/${dir}/${parsed.caseName}/index.md`);
      } else {
        extra.push(`memory/${dir}/${parsed.caseName}/${parsed.pieceFileName}`);
      }
    }
    const seen = new Set(candidates);
    return [...candidates, ...extra.filter((p) => !seen.has(p))];
  }
  return candidates;
}

/** Probe the ordered candidate paths once: first hit, total absence, or a
 *  genuine read failure (strictly separate from "not there"). */
async function readFirstCandidate(
  backend: RecallBackend,
  candidates: string[],
): Promise<
  | { kind: "content"; content: string; path: string }
  | { kind: "allAbsent" }
  | { kind: "unavailable"; note: string }
> {
  for (const path of candidates) {
    try {
      const content = await backend.readFile(path);
      return { kind: "content", content, path };
    } catch (e) {
      if (!isAbsentError(e)) {
        return { kind: "unavailable", note: e instanceof Error ? e.message : String(e) };
      }
    }
  }
  return { kind: "allAbsent" };
}

/**
 * Approximate ref resolution (v0.11): the ref parsed but nothing was there —
 * re-score the case-name component against the category's cases with the
 * shared normalize+score machinery, and on a unique strong candidate rebuild
 * the ref with the TRUE on-disk name (research probes both roots, so a
 * hypotheses case resolves too).
 */
async function fuzzyResolveCaseRef(
  backend: RecallBackend,
  ref: string,
): Promise<{
  matched: { ref: string; candidates: string[] } | null;
  nearMisses: MemoryEntry[];
 } | null> {
  const parsed = parseCaseRef(ref);
  if (!parsed || parsed.kind === "legacy") return null;
  const index = buildTreeIndex(await backend.listMemoryFiles());
  const dirs =
    parsed.category === "research"
      ? (["research", "hypotheses"] as const)
      : ([parsed.category] as const);
  const nodes = index.cases.filter(
    (n) => (dirs as readonly string[]).includes(n.treeDir) && n.indexPath,
  );
  const queryNorm = normalizeRecallName(parsed.caseName);
  const scored = nodes
    .map((node) => ({
      node,
      score: nameSimilarity(normalizeRecallName(node.caseName), queryNorm),
    }))
    .sort((x, y) => y.score - x.score);
  const unique = bestUniqueNameMatch(scored, (s) => s.score);
  let matched: { ref: string; candidates: string[] } | null = null;
  if (unique) {
    const rebuilt =
      parsed.kind === "case"
        ? `${parsed.category}/${unique.item.node.caseName}`
        : `${parsed.category}/${unique.item.node.caseName}/${parsed.pieceFileName.replace(/\.md$/, "")}`;
    const candidates = recallReadCandidates(rebuilt);
    matched = candidates ? { ref: rebuilt, candidates } : null;
  }
  const nearMisses: MemoryEntry[] = [];
  for (const { node } of scored
    .filter((s) => s.score >= NEAR_MISS_MIN_SCORE)
    .slice(0, NEAR_MISS_MAX)) {
    const built = await buildCaseEntry(backend, node);
    if (built) nearMisses.push(built.entry);
  }
  return { matched, nearMisses };
}

export async function recallRead(
  backend: RecallBackend,
  input: RecallReadInput,
): Promise<RecallReadResult> {
  const ref = normalizeCaseRefText(input.ref);

  // records/<sliceId> — the slice's parts.
  if (ref.startsWith("records/")) {
    const sliceId = ref.slice("records/".length);
    if (!parseSliceId(sliceId)) return { kind: "not_found" };
    const part = input.part ?? "core";
    let raw: string;
    try {
      raw = await readSliceRaw(backend, sliceId, part);
    } catch (e) {
      return isAbsentError(e) ? { kind: "not_found" } : { kind: "unavailable", note: e instanceof Error ? e.message : String(e) };
    }
    if (part === "agent") {
      return { kind: "content", content: raw, path: `records/${sliceId} (agent)` };
    }
    if (part === "previously") {
      const content = raw.trim() ? migrateToV3(raw, sliceId) : raw;
      const withBanner =
        input.timezone && content
          ? `${sliceLocalBanner(sliceId, input.timezone)}\n\n${content}`
          : content;
      return { kind: "content", content: withBanner, path: `records/${sliceId} (previously)` };
    }
    // core: range filter, then the local-time annotation.
    const ranged = applySliceRange(sliceId, raw, input.range);
    const content = input.timezone
      ? annotateSliceWithLocalTime(ranged, input.timezone, sliceId)
      : ranged;
    return { kind: "content", content, path: `records/${sliceId}` };
  }

  // The two reserved bare-file refs (ruling #3).
  if (ref === "self/agenda") {
    return readBareFile(backend, "memory/self/agenda.md");
  }
  if (ref === "people/user/profile") {
    return readBareFile(backend, "memory/people/user/profile.md");
  }

  const candidates = recallReadCandidates(ref);
  if (!candidates) return { kind: "not_found" };
  const direct = await readFirstCandidate(backend, candidates);
  if (direct.kind === "content") {
    return { kind: "content", content: direct.content, path: direct.path };
  }
  if (direct.kind === "unavailable") return direct;

  // Exact resolution missed every candidate — approximate the case-name
  // component with the shared normalize+score machinery. A unique strong
  // candidate is read as-is (the true ref rides the result for the render
  // note); otherwise the near misses come back sorted best-first.
  const fuzzy = await fuzzyResolveCaseRef(backend, ref);
  if (!fuzzy) return { kind: "not_found" };
  if (fuzzy.matched) {
    const retry = await readFirstCandidate(backend, fuzzy.matched.candidates);
    if (retry.kind === "content") {
      return {
        kind: "content",
        content: retry.content,
        path: retry.path,
        matchedRef: fuzzy.matched.ref,
      };
    }
    if (retry.kind === "unavailable") return retry;
    // the adopted candidate vanished mid-flight — fall through to near misses
  }
  return fuzzy.nearMisses.length > 0
    ? { kind: "not_found", nearMisses: fuzzy.nearMisses }
    : { kind: "not_found" };
}

async function readBareFile(backend: RecallBackend, path: string): Promise<RecallReadResult> {
  try {
    return { kind: "content", content: await backend.readFile(path), path };
  } catch (e) {
    return isAbsentError(e)
      ? { kind: "not_found" }
      : { kind: "unavailable", note: e instanceof Error ? e.message : String(e) };
  }
}

// ─── Fixed rendering (v0.36 §3.2 — pinned text per kind) ────────────────

export interface RenderMeta {
  category?: RecallCategory;
  query?: string;
  name?: string;
  /** The limit that capped the entries (for the truncated half-sentence). */
  limit?: number;
}

function renderEntryLines(entries: MemoryEntry[]): string {
  return entries
    .map((e) => {
      const core = `- [${e.date || "undated"}] ${e.title}`;
      return e.excerpt ? `${core} — ${e.excerpt} (ref: ${e.ref})` : `${core} (ref: ${e.ref})`;
    })
    .join("\n");
}

/**
 * Render a result with the FIXED template per kind — the model reads these
 * exact sentences, never improvised fallback wording.
 */
export function renderRecallResult(result: RecallResult, meta: RenderMeta = {}): string {
  switch (result.kind) {
    case "entries": {
      if (result.pastEnd) {
        return (
          `No more entries — offset ${result.offset ?? 0} is past the end; ` +
          `only ${result.total ?? result.scanned} exist in this scope, newest first.`
        );
      }
      const head =
        meta.query !== undefined
          ? `${result.entries.length} match(es) for "${meta.query}":`
          : `The ${result.entries.length} most recent ${meta.category ?? "memory"} entries:`;
      const lines = renderEntryLines(result.entries);
      // Paging notes (fixed wording): an offset page with more entries behind
      // it tells the model exactly how to continue; otherwise the legacy
      // truncation note applies (both verbs, offset 0).
      const note = !result.truncated
        ? ""
        : result.offset !== undefined
          ? `\nShowing ${result.entries.length} from offset ${result.offset} — ` +
            `pass offset=${result.offset + result.entries.length} for older ones.`
          : `\nShowing the newest ${meta.limit ?? result.entries.length} of ${result.scanned} scanned — narrow by date or add keywords for the older ones.`;
      const matched = result.matchedName
        ? `\n(matched the near-name "${result.matchedName}" — that is the stored name)`
        : "";
      return lines ? `${head}\n${lines}${note}${matched}` : `${head}${note}${matched}`;
    }
    case "fallback": {
      const head = `Nothing matches "${meta.query ?? ""}". Here are the ${result.entries.length} most recent entries instead:`;
      return result.entries.length > 0 ? `${head}\n${renderEntryLines(result.entries)}` : head;
    }
    case "empty":
      return `There is nothing here yet — no ${meta.category ?? "memory"} entries exist in this scope.`;
    case "not_found": {
      const near = result.nearMisses.map((e) => e.ref);
      return near.length > 0
        ? `Nothing named "${meta.name ?? ""}" exists in ${meta.category ?? "memory"}. Closest matches: ${near.join(", ")}.`
        : `Nothing named "${meta.name ?? ""}" exists in ${meta.category ?? "memory"} — and nothing similar.`;
    }
    case "unavailable":
      return `This could not be read right now (${result.note}). That is a read failure, not absence — it may still exist.`;
  }
}

/** Render a recallRead outcome. */
export function renderRecallReadResult(result: RecallReadResult, ref: string): string {
  switch (result.kind) {
    case "content":
      return result.matchedRef
        ? `(matched the near-name "${result.matchedRef}" — read it under that stored name)\n\n${result.content}`
        : result.content;
    case "not_found": {
      const near = result.nearMisses?.map((e) => e.ref) ?? [];
      return near.length > 0
        ? `Nothing named "${ref}" exists in memory. Closest matches: ${near.join(", ")}.`
        : `Nothing named "${ref}" exists in memory — and nothing similar.`;
    }
    case "unavailable":
      return `This could not be read right now (${result.note}). That is a read failure, not absence — it may still exist.`;
  }
}
