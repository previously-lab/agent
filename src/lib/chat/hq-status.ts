/**
 * HQ status — the client-safe shape of `memory/config/hq.json` and the pod
 * panel's fetch helper (v0.21 §5 visibility layer; v0.30 §2.3/§2.4).
 *
 * hq.json is the ONE rolling pointer for "what the reflection unit is doing"
 * — engineering state under `memory/config/` (design v0.19 §B.1: config/ is
 * engineering state, NOT documents), overwritten in place, never appended. It
 * exists so the companion pod can answer three questions without a
 * session-local bus: whether the unit is running and how its last run ended,
 * which documents it wrote most recently, and what its last substantive
 * round's one-line note said (the 暂存 the next turn carries). It also holds
 * `lastSeen`, the unit's rolling read pointer (how far it has read — range
 * semantics, §2.3). The unit's own "store results only, no run ledger"
 * discipline (裁决 12) is a DOCUMENT-layer rule; this is the debug/visibility
 * layer, and it stays a pointer, not a ledger.
 *
 * This module is PURE (no fs, no next) — the server store
 * (`app/api/evolution/hq-status-store.ts`) and the route both build on it,
 * and the pod imports it client-side.
 */

/** How the last HQ run ended — 完成 / 空转 / 失败, plus the live "running". */
export type HQRunStatus = "running" | "completed" | "idle" | "failed";

export interface HQStatus {
  /**
   * The current/last HQ run's durable workflow run id — written by the
   * CLAIMING run itself (never by a dispatch, which may name a duplicate
   * that loses the claim and exits). This is the pod's attach target for
   * the activity stream (GET /api/evolution/hq/[runId]/stream): the stream
   * replays, so reconnecting is simply re-attaching to this id.
   */
  runId: string | null;
  /** ISO time the current/last HQ run started (claimed the token). */
  runStartedAt: string | null;
  /** Null before the first run ever claims the token. */
  runStatus: HQRunStatus | null;
  /** Rounds the LAST run handled (written at run finish). */
  briefsHandled: number;
  /** Why the last failed run failed — the error's first line, capped at the
   *  store; a clean finish clears it. Null when the last run did not fail
   *  (or the file predates the field). */
  lastError: string | null;
  /**
   * LEGACY (v0.21 dispatch era): ISO time of the field's last reportToHQ
   * dispatch. The dispatch retired in v0.30 — nothing writes this anymore;
   * the field survives only in older hq.json files.
   */
  lastDispatchAt: string | null;
  /**
   * LEGACY (v0.21): the last brief's first line. Retired with the dispatch;
   * kept so old files still normalize.
   */
  lastBriefPreview: string | null;
  /** Memory-relative paths HQ wrote most recently, newest first (capped). */
  recentWrites: string[];
  /**
   * The 暂存 (v0.30 §2.4): the LAST SUBSTANTIVE round's one-line account
   * (from its hqReport note) and when it landed. An idle round never
   * overwrites it (R1 — 空转不留痕); the next turn carries it (once) and
   * the panel shows it.
   */
  lastNote: { note: string; at: string } | null;
  /**
   * The rolling read pointer (v0.30 §2.3): how far the unit has read,
   * advanced with EVERY round whose wake named a slice/turn. Range
   * semantics, not a ledger — the next round reads everything after it.
   */
  lastSeen: { sliceId?: string; turnId?: string } | null;
}

export const HQ_STATUS_EMPTY: HQStatus = {
  runId: null,
  runStartedAt: null,
  runStatus: null,
  briefsHandled: 0,
  lastError: null,
  lastDispatchAt: null,
  lastBriefPreview: null,
  recentWrites: [],
  lastNote: null,
  lastSeen: null,
};

/** The GET /api/evolution/hq-status payload. */
export interface HQStatusResponse {
  status: HQStatus;
  /** Server clock at answer time — the panel renders relative times from it. */
  asOf: string;
}

const RUN_STATUSES: readonly HQRunStatus[] = ["running", "completed", "idle", "failed"];

/**
 * Tolerant normalize: anything that is not the expected shape degrades
 * field-by-field to EMPTY. hq.json is a debug pointer — a corrupt or older
 * file must never break the panel (or the writers' read-modify-write).
 */
export function normalizeHQStatus(raw: unknown): HQStatus {
  if (!raw || typeof raw !== "object") return HQ_STATUS_EMPTY;
  const o = raw as Record<string, unknown>;
  return {
    runId: typeof o.runId === "string" ? o.runId : null,
    runStartedAt: typeof o.runStartedAt === "string" ? o.runStartedAt : null,
    runStatus: RUN_STATUSES.includes(o.runStatus as HQRunStatus)
      ? (o.runStatus as HQRunStatus)
      : null,
    briefsHandled:
      typeof o.briefsHandled === "number" && Number.isFinite(o.briefsHandled)
        ? Math.max(0, Math.floor(o.briefsHandled))
        : 0,
    lastError: typeof o.lastError === "string" ? o.lastError : null,
    lastDispatchAt: typeof o.lastDispatchAt === "string" ? o.lastDispatchAt : null,
    lastBriefPreview:
      typeof o.lastBriefPreview === "string" ? o.lastBriefPreview : null,
    recentWrites: Array.isArray(o.recentWrites)
      ? o.recentWrites.filter((p): p is string => typeof p === "string")
      : [],
    lastNote: normalizeLastNote(o.lastNote),
    lastSeen: normalizeLastSeen(o.lastSeen),
  };
}

/** Tolerant field decode for the 暂存 — a shaped-wrong note degrades to null. */
function normalizeLastNote(raw: unknown): HQStatus["lastNote"] {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.note !== "string" || typeof o.at !== "string") return null;
  return { note: o.note, at: o.at };
}

/** Tolerant field decode for the rolling read pointer. */
function normalizeLastSeen(raw: unknown): HQStatus["lastSeen"] {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const sliceId = typeof o.sliceId === "string" ? o.sliceId : undefined;
  const turnId = typeof o.turnId === "string" ? o.turnId : undefined;
  if (sliceId === undefined && turnId === undefined) return null;
  return { ...(sliceId ? { sliceId } : {}), ...(turnId ? { turnId } : {}) };
}

/**
 * The panel's read. Throws on a non-2xx (the endpoint is read-only; a failure
 * is the server's, not "no data" — an absent hq.json arrives as EMPTY).
 */
export async function fetchHQStatus(signal?: AbortSignal): Promise<HQStatusResponse> {
  const res = await fetch("/api/evolution/hq-status", {
    cache: "no-store",
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) throw new Error(`hq-status answered ${res.status}`);
  const body = (await res.json()) as Partial<HQStatusResponse>;
  return {
    status: normalizeHQStatus(body.status),
    asOf: typeof body.asOf === "string" ? body.asOf : new Date().toISOString(),
  };
}
