import { parseRecordRef } from "@/lib/archive/refs";
import type {
  TaskEntry,
  TaskLedger,
  TaskLedgerReadResult,
  TaskStatus,
} from "./contracts";

/**
 * The task panel's READ-ONLY projection (v0.11 streams). Everything the panel
 * shows derives from the canonical `readTaskLedger` result — never from prose,
 * never from a task's own words about itself, and a task's STATUS is the only
 * authority for which filter bucket it sits in. A pending delivery result is
 * shown as pending; it NEVER completes a task or moves it to "finished".
 */

export const TASK_PANEL_FILTERS = [
  "active",
  "waiting",
  "paused",
  "finished",
  "all",
] as const;
export type TaskPanelFilter = (typeof TASK_PANEL_FILTERS)[number];

export const TASK_PANEL_DEFAULT_LIMIT = 20;
export const TASK_PANEL_MAX_LIMIT = 50;

/** Per-filter totals, always derived from the FULL canonical ledger. */
export interface TaskPanelCounts {
  active: number;
  waiting: number;
  paused: number;
  finished: number;
  all: number;
}

export interface TaskPanelEvidenceItem {
  sliceId: string;
  turnId: string;
  /** The desk ref the evidence opens — only present when the slice id is a
   *  legal `records/<sliceId>` ref; otherwise there is no source to open. */
  docRef: string | null;
  statement: string;
}

export interface TaskPanelPendingResult {
  id: string;
  statement: string;
  createdAt: string;
}

export interface TaskPanelItem {
  ref: string;
  summary: string;
  status: TaskStatus;
  /** needs_review tasks render inside "active" under a visible badge. */
  needsReview: boolean;
  dueOn?: string;
  nextCheckOn?: string;
  waitingCondition?: string;
  nextAction?: string;
  updatedAt: string;
  evidence: TaskPanelEvidenceItem[];
  pendingResults: TaskPanelPendingResult[];
}

export interface TaskPanelPageQuery {
  filter: TaskPanelFilter;
  offset: number;
  limit: number;
}

export interface TaskPanelReadyPage {
  status: "ready";
  /** Opaque server-read identity required to append a later offset. */
  snapshot: string;
  counts: TaskPanelCounts;
  filter: TaskPanelFilter;
  /** Total matching the filter in the full ledger (never capped). */
  total: number;
  items: TaskPanelItem[];
  hasMore: boolean;
  /** Null when hasMore is false. */
  nextOffset: number | null;
}

export type TaskPanelResponse =
  | TaskPanelReadyPage
  | { status: "missing" }
  | { status: "corrupt"; message: string }
  | { status: "unavailable"; message: string }
  | { status: "stale" };

function clampInt(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

/**
 * Validate and clamp raw action input. An unknown/absent filter falls back to
 * "active"; offset/limit are clamped to sane bounds. Technical read metadata
 * (basisHeadSha and friends) is deliberately NOT part of the product surface.
 */
export function parseTaskPanelQuery(input: unknown): TaskPanelPageQuery {
  const raw = (input ?? {}) as Record<string, unknown>;
  const filter = TASK_PANEL_FILTERS.includes(raw.filter as TaskPanelFilter)
    ? (raw.filter as TaskPanelFilter)
    : "active";
  return {
    filter,
    offset: clampInt(raw.offset, 0, 0, Number.MAX_SAFE_INTEGER),
    limit: clampInt(raw.limit, TASK_PANEL_DEFAULT_LIMIT, 1, TASK_PANEL_MAX_LIMIT),
  };
}

function matchesFilter(task: TaskEntry, filter: TaskPanelFilter): boolean {
  switch (filter) {
    case "active":
      return task.status === "open" || task.status === "needs_review";
    case "waiting":
      return task.status === "waiting";
    case "paused":
      return task.status === "paused";
    case "finished":
      return task.status === "completed" || task.status === "cancelled";
    case "all":
      return true;
  }
}

/**
 * Deterministic, sensible ordering: the earliest actionable date first
 * (dueOn, else nextCheckOn), undated tasks last; ties break by updatedAt
 * then ref, so the same ledger always renders the same order.
 */
function compareTasks(a: TaskEntry, b: TaskEntry): number {
  const dateKey = (task: TaskEntry): string | null =>
    task.dueOn ?? task.nextCheckOn ?? null;
  const aKey = dateKey(a);
  const bKey = dateKey(b);
  if (aKey !== bKey) {
    if (aKey === null) return 1;
    if (bKey === null) return -1;
    const byDate = aKey.localeCompare(bKey);
    if (byDate !== 0) return byDate;
  }
  const byUpdated = a.updatedAt.localeCompare(b.updatedAt);
  if (byUpdated !== 0) return byUpdated;
  return a.ref.localeCompare(b.ref);
}

function projectTask(
  task: TaskEntry,
  ledger: TaskLedger,
): TaskPanelItem {
  const pendingResults = ledger.results
    .filter(
      (result) =>
        result.taskRef === task.ref && result.delivery.state === "pending",
    )
    .map((result) => ({
      id: result.id,
      statement: result.evidence.statement,
      createdAt: result.createdAt,
    }))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return {
    ref: task.ref,
    summary: task.summary,
    status: task.status,
    needsReview: task.status === "needs_review",
    ...(task.dueOn !== undefined ? { dueOn: task.dueOn } : {}),
    ...(task.nextCheckOn !== undefined ? { nextCheckOn: task.nextCheckOn } : {}),
    ...(task.waitingCondition !== undefined
      ? { waitingCondition: task.waitingCondition }
      : {}),
    ...(task.nextAction !== undefined ? { nextAction: task.nextAction } : {}),
    updatedAt: task.updatedAt,
    evidence: task.evidence.map((evidence) => {
      const docRef = `records/${evidence.sliceId}`;
      return {
        sliceId: evidence.sliceId,
        turnId: evidence.turnId,
        docRef: parseRecordRef(docRef) !== null ? docRef : null,
        statement: evidence.statement,
      };
    }),
    pendingResults,
  };
}

export function taskPanelCounts(ledger: TaskLedger): TaskPanelCounts {
  let active = 0;
  let waiting = 0;
  let paused = 0;
  let finished = 0;
  for (const task of ledger.tasks) {
    if (matchesFilter(task, "active")) active += 1;
    if (matchesFilter(task, "waiting")) waiting += 1;
    if (matchesFilter(task, "paused")) paused += 1;
    if (matchesFilter(task, "finished")) finished += 1;
  }
  return { active, waiting, paused, finished, all: ledger.tasks.length };
}

/** One page of the projection against a canonical ledger. Read-only. */
export function projectTaskPanel(
  ledger: TaskLedger,
  query: TaskPanelPageQuery,
  snapshot = "projection",
): TaskPanelReadyPage {
  const matching = ledger.tasks
    .filter((task) => matchesFilter(task, query.filter))
    .sort(compareTasks);
  const total = matching.length;
  const items = matching
    .slice(query.offset, query.offset + query.limit)
    .map((task) => projectTask(task, ledger));
  const nextOffset = query.offset + items.length;
  const hasMore = nextOffset < total;
  return {
    status: "ready",
    snapshot,
    counts: taskPanelCounts(ledger),
    filter: query.filter,
    total,
    items,
    hasMore,
    nextOffset: hasMore ? nextOffset : null,
  };
}

/**
 * Map an authoritative ledger read to the panel response. ready-with-zero is
 * a REAL empty state and stays distinct from a missing ledger; corrupt and
 * unavailable are honest failures, never faked as zero/finished. The
 * basisHeadSha and other technical read metadata stay server-side.
 */
export function projectTaskLedgerRead(
  read: TaskLedgerReadResult,
  query: TaskPanelPageQuery,
  snapshot?: string,
): TaskPanelResponse {
  switch (read.status) {
    case "ready":
      return projectTaskPanel(read.ledger, query, snapshot);
    case "missing":
      return { status: "missing" };
    case "corrupt":
      return { status: "corrupt", message: read.message };
    case "unavailable":
      return { status: "unavailable", message: read.message };
  }
}
