/**
 * HQ activity stream — the contract and the client half of
 * GET /api/evolution/hq/[runId]/stream (v0.21 §4 visibility layer).
 *
 * HQ runs in its own durable workflow run. That run's output stream is
 * durable (replayable), so "reconnect" here is simply RE-ATTACHING to the
 * same run's stream — the world replays whatever the client missed. The run
 * id travels out of band via the hq.json pointer (`HQStatus.runId`, written
 * by the claiming run itself), which the pod reads through the existing
 * GET /api/evolution/hq-status poll.
 *
 * Frames are ONE chunk type — `data-hq-activity` — with a small enumerable
 * `kind`. They are third-person ACTIVITY descriptions ("reading the scene",
 * "wrote research/X"), never conversation: HQ has no mouth (v0.21 §9), so
 * nothing here is phrased as speech to the user. The run's stream may also
 * carry the sub-agent machinery's `data-tool-progress` chunks (handleBrief
 * runs through runSubAgent); the route filters those out so this file's
 * vocabulary is the whole wire contract.
 *
 * PURE module (no fs, no next): the route, the HQ steps and the pod all
 * import it. The reader is DOM-free (fetch + TextDecoder, injectable fetch)
 * so the wire parsing is unit-testable under vitest's node environment —
 * same discipline as src/lib/companion/narrate.ts.
 */
import type { UIMessageChunk } from "ai";

// ─── The frame contract ───────────────────────────────────────────────────

/** The chunk type every HQ activity frame rides. */
export const HQ_ACTIVITY_CHUNK = "data-hq-activity";

/**
 * What HQ is doing, one kind per beat. Third-person activity, not speech:
 *  - started  — a run claimed the token ("checking in")
 *  - reading  — a brief's round began: HQ reads the raw records first
 *  - wrote    — the round landed writes (paths)
 *  - idle     — the round deliberately wrote nothing (note says why — a
 *               substantive veto's short reason rides here, since a veto
 *               that produced no write is mechanically an empty round)
 *  - failed   — a round failed (HQ never throws; the error rides here)
 *  - finished — the run packed up (idle grace / done / failure), with the
 *               terminal status the hq.json pointer also settles to
 */
export type HQActivityKind =
  | "started"
  | "reading"
  | "wrote"
  | "idle"
  | "failed"
  | "finished";

export interface HQActivityFrame {
  kind: HQActivityKind;
  /** ISO time the beat was emitted (the server's clock). */
  at: string;
  /** reading: the slice the brief points at, when it names one. */
  sliceId?: string;
  /** wrote: memory-relative paths the round landed. */
  paths?: string[];
  /** idle/wrote: HQ's own one-paragraph account of the round (its note). */
  note?: string;
  /** failed: the round's error line. */
  error?: string;
  /** finished: how the run settled — mirrors HQRunStatus minus "running". */
  status?: "completed" | "idle" | "failed";
  /** finished: briefs the run handled. */
  handled?: number;
}

const KINDS: readonly HQActivityKind[] = [
  "started",
  "reading",
  "wrote",
  "idle",
  "failed",
  "finished",
];

/**
 * Tolerant normalize: a malformed frame degrades to null (the reader skips
 * it), never throws. The stream is a debug surface — one bad chunk must not
 * kill the feed.
 */
export function normalizeHQActivity(raw: unknown): HQActivityFrame | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (!KINDS.includes(o.kind as HQActivityKind)) return null;
  const frame: HQActivityFrame = {
    kind: o.kind as HQActivityKind,
    at: typeof o.at === "string" ? o.at : "",
  };
  if (typeof o.sliceId === "string" && o.sliceId) frame.sliceId = o.sliceId;
  if (Array.isArray(o.paths)) {
    frame.paths = o.paths.filter((p): p is string => typeof p === "string");
  }
  if (typeof o.note === "string" && o.note) frame.note = o.note;
  if (typeof o.error === "string" && o.error) frame.error = o.error;
  if (o.status === "completed" || o.status === "idle" || o.status === "failed") {
    frame.status = o.status;
  }
  if (typeof o.handled === "number" && Number.isFinite(o.handled)) {
    frame.handled = Math.max(0, Math.floor(o.handled));
  }
  return frame;
}

// ─── The route's filter ───────────────────────────────────────────────────

/**
 * Pass ONLY HQ activity chunks through. The HQ run's durable stream is
 * shared with the sub-agent machinery's `data-tool-progress` writes (the
 * brief rounds run through runSubAgent); those are chat-shaped telemetry,
 * not part of this contract, so the route pipes the raw run stream through
 * this transform and the wire stays small, stable and enumerable.
 *
 * Deliberately stateless and 1:1 (like the chat route's mixed transform) —
 * reconnects resume by chunk index against the raw run stream, and the
 * filter never invents chunks of its own.
 */
export function createHQStreamFilter(): TransformStream<
  unknown,
  UIMessageChunk
> {
  return new TransformStream<unknown, UIMessageChunk>({
    transform(chunk: unknown, controller) {
      const c = chunk as Record<string, unknown> | null;
      if (c && typeof c === "object" && c.type === HQ_ACTIVITY_CHUNK) {
        controller.enqueue(chunk as UIMessageChunk);
      }
    },
  });
}

// ─── The client reader ────────────────────────────────────────────────────

/** fetch signature the reader depends on (injectable for tests). */
export type HQStreamFetch = typeof fetch;

export interface StreamHQActivityOptions {
  /** The durable HQ run to attach to. */
  runId: string;
  /** Abort the attachment (panel closed, a newer run superseded). */
  signal?: AbortSignal;
  /** Test seam — defaults to the global fetch. */
  fetchImpl?: HQStreamFetch;
}

/** Stable error codes the pod maps to behavior (retry / give up). */
export type HQStreamErrorCode = "not_found" | "request_failed" | "aborted";

export class HQStreamError extends Error {
  readonly code: HQStreamErrorCode;
  readonly status?: number;

  constructor(code: HQStreamErrorCode, message: string, status?: number) {
    super(message);
    this.name = "HQStreamError";
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

/**
 * Attach to an HQ run's activity stream. Frames arrive in run order — the
 * durable stream REPLAYS from the start, so a reconnecting client re-sees
 * the run's whole beat log (the pod treats replayed frames as history, not
 * news). Resolves when the stream ends (run finished, or a replay of a
 * finished run drained); throws HQStreamError on transport failures — a 404
 * means the run is gone (retention expired / never existed), so the caller
 * drops its stored run id and falls back to the hq.json pointer.
 */
export async function streamHQActivity(
  opts: StreamHQActivityOptions,
  onFrame: (frame: HQActivityFrame) => void,
): Promise<void> {
  const fetchFn = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await fetchFn(
      `/api/evolution/hq/${encodeURIComponent(opts.runId)}/stream`,
      {
        cache: "no-store",
        ...(opts.signal ? { signal: opts.signal } : {}),
      },
    );
  } catch (e) {
    if (opts.signal?.aborted) throw new HQStreamError("aborted", "aborted");
    throw new HQStreamError(
      "request_failed",
      e instanceof Error ? e.message : String(e),
    );
  }
  if (!res.ok) {
    if (res.status === 404) {
      throw new HQStreamError("not_found", "HQ run not available", 404);
    }
    throw new HQStreamError(
      "request_failed",
      `hq stream answered ${res.status}`,
      res.status,
    );
  }
  if (!res.body) throw new HQStreamError("request_failed", "no stream body");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // SSE frames are `data: {json}\n\n`; the terminator is `data: [DONE]`.
      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) >= 0) {
        const rawEvent = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        for (const line of rawEvent.split("\n")) {
          if (!line.startsWith("data: ")) continue;
          const payload = line.slice(6).trim();
          if (!payload || payload === "[DONE]") continue;
          let chunk: unknown;
          try {
            chunk = JSON.parse(payload);
          } catch {
            continue; // a corrupt chunk is skipped, never fatal
          }
          const c = chunk as Record<string, unknown> | null;
          if (!c || c.type !== HQ_ACTIVITY_CHUNK) continue;
          const frame = normalizeHQActivity(c.data);
          if (frame) onFrame(frame);
        }
      }
    }
  } catch (e) {
    if (opts.signal?.aborted) throw new HQStreamError("aborted", "aborted");
    throw new HQStreamError(
      "request_failed",
      e instanceof Error ? e.message : String(e),
    );
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }
}

// ─── Reconnect persistence (localStorage) ─────────────────────────────────

/**
 * The pod's stash of the HQ run it is (or was) attached to. Written when a
 * running run id is observed; cleared when that run settles or turns out
 * gone. Mirrors the chat turn's RUN_ID_KEY discipline: guarded so a
 * private-mode / SSR environment (no localStorage) degrades to no-op.
 */
const HQ_RUN_ID_KEY = "previously:hqRunId";

export function readStoredHQRunId(): string | null {
  if (typeof localStorage === "undefined") return null;
  try {
    return localStorage.getItem(HQ_RUN_ID_KEY);
  } catch {
    return null;
  }
}

export function writeStoredHQRunId(runId: string): void {
  try {
    localStorage.setItem(HQ_RUN_ID_KEY, runId);
  } catch {
    /* private mode — reconnection is best-effort */
  }
}

export function clearStoredHQRunId(): void {
  try {
    localStorage.removeItem(HQ_RUN_ID_KEY);
  } catch {
    /* private mode — best-effort */
  }
}
