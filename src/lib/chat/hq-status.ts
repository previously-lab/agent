/**
 * HQ status — the client-safe shape of `memory/config/hq.json` and the pod
 * panel's fetch helper (v0.21 §5 visibility layer).
 *
 * hq.json is the ONE rolling pointer for "what HQ is doing" — engineering
 * state under `memory/config/` (design v0.19 §B.1: config/ is engineering
 * state, NOT documents), overwritten in place, never appended. It exists so
 * the companion pod can answer three questions without a session-local bus:
 * when the field last dispatched, whether HQ is running and how its last run
 * ended, and which documents it wrote most recently. HQ's own "store results
 * only, no run ledger" discipline (裁决 12) is a DOCUMENT-layer rule; this is
 * the debug/visibility layer, and it stays a pointer, not a ledger.
 *
 * This module is PURE (no fs, no next) — the server store
 * (`app/api/evolution/hq-status-store.ts`) and the route both build on it,
 * and the pod imports it client-side.
 */

/** How the last HQ run ended — 完成 / 空转 / 失败, plus the live "running". */
export type HQRunStatus = "running" | "completed" | "idle" | "failed";

export interface HQStatus {
  /** ISO time the current/last HQ run started (claimed the token). */
  runStartedAt: string | null;
  /** Null before the first run ever claims the token. */
  runStatus: HQRunStatus | null;
  /** Briefs the LAST run handled (written at run finish). */
  briefsHandled: number;
  /** ISO time of the field's most recent dispatch (reportToHQ). */
  lastDispatchAt: string | null;
  /** The last brief's first line, truncated — a preview, never the whole prose. */
  lastBriefPreview: string | null;
  /** Memory-relative paths HQ wrote most recently, newest first (capped). */
  recentWrites: string[];
}

export const HQ_STATUS_EMPTY: HQStatus = {
  runStartedAt: null,
  runStatus: null,
  briefsHandled: 0,
  lastDispatchAt: null,
  lastBriefPreview: null,
  recentWrites: [],
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
    runStartedAt: typeof o.runStartedAt === "string" ? o.runStartedAt : null,
    runStatus: RUN_STATUSES.includes(o.runStatus as HQRunStatus)
      ? (o.runStatus as HQRunStatus)
      : null,
    briefsHandled:
      typeof o.briefsHandled === "number" && Number.isFinite(o.briefsHandled)
        ? Math.max(0, Math.floor(o.briefsHandled))
        : 0,
    lastDispatchAt: typeof o.lastDispatchAt === "string" ? o.lastDispatchAt : null,
    lastBriefPreview:
      typeof o.lastBriefPreview === "string" ? o.lastBriefPreview : null,
    recentWrites: Array.isArray(o.recentWrites)
      ? o.recentWrites.filter((p): p is string => typeof p === "string")
      : [],
  };
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
