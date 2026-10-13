/**
 * HQ status store — the writers behind `memory/config/hq.json` (v0.21 §4/§5
 * visibility layer; v0.30 §2.3/§2.4).
 *
 * ONE rolling pointer, OVERWRITTEN in place: no history, no ledger. The three
 * record functions are the ONLY writers, all called from the reflection run
 * shell (`hq-run.ts` / `hq-steps.ts`) — v0.30 retired the field's dispatch
 * (reportToHQ) and with it `recordHQDispatch`; the unit is woken by the
 * mechanical bell and the record itself is the channel:
 *
 *   recordRunStarted    — a reflection run claimed the token (runId + start
 *                         stamp); writes IMMEDIATELY (a run that hangs or
 *                         dies mid-flight must still read "running")
 *   recordBriefOutcome  — one round's landed writes
 *   recordRunFinished   — runStatus settles: 完成 / 空转 / 失败 + rounds
 *                         handled; also lands the 暂存 (`lastNote` — the last
 *                         SUBSTANTIVE round's one-line note, R1: an idle
 *                         round never overwrites it) and the rolling read
 *                         pointer (`lastSeen`, advanced every round)
 *
 * DEFERRED WRITE (aggregation wave, decision D2), partially reversed
 * 2026-10-14: the run's STARTED mark lands IMMEDIATELY (runStatus "running" +
 * runId + runStartedAt). The reversal's reason is honesty, not traffic — a
 * run that hangs or dies mid-flight must still read "running", and the
 * 2026-10-13 incident left a live run invisible behind a day-old "failed".
 * What still defers: per-round outcomes ACCUMULATE in module run-state and
 * ride the finish mark — ≤2 hq.json commits per run (start + finish). A
 * failed finish also lands its real error line (lastError). The buffer is
 * per-process and best-effort: if a run resumes on another instance between
 * rounds, the unflushed marks for earlier rounds are lost (never written
 * elsewhere) — accepted for a glance pointer, consistent with the tolerances
 * below. A run that dies between start and finish leaves the pointer reading
 * "running" with its start stamp — stale but dated and honest, and the next
 * run heals it.
 *
 * Every function is BEST-EFFORT: a status write must never break the
 * reflection run it instruments, so all errors are swallowed with a
 * console.warn. Read-modify-write races between turns and the unit are
 * possible (they run in different durable runs) — the loser loses one pointer
 * update, which the next write heals; that is the price of keeping this a
 * pointer instead of a transaction.
 *
 * Imported DYNAMICALLY from hq-steps.ts (a workflow-reachable step module —
 * see the note there) and statically from tool-executors.ts / steps.ts, which
 * already statically reach io-helpers.
 */
import { fsReadFile, fsWriteFile } from "@/lib/episodic/io-helpers";
import {
  HQ_STATUS_EMPTY,
  normalizeHQStatus,
  type HQStatus,
} from "@/lib/chat/hq-status";

export const HQ_STATUS_PATH = "memory/config/hq.json";

/** recentWrites is a glance, not an archive — the newest few paths only. */
const RECENT_WRITES_CAP = 8;
/** The failure line keeps the error's first line, truncated. */
const ERROR_PREVIEW_MAX = 200;

/** The failure's first line, single-spaced and capped — a glance, never the
 *  stack (that stays in the logs). */
function errorPreviewOf(message: string | undefined): string | null {
  const firstLine = message?.trim().split("\n", 1)[0]?.trim() ?? "";
  if (!firstLine) return null;
  return firstLine.length > ERROR_PREVIEW_MAX
    ? `${firstLine.slice(0, ERROR_PREVIEW_MAX)}…`
    : firstLine;
}

/** Tolerant read: a missing or corrupt pointer is the empty state, never an error. */
export async function readHQStatus(): Promise<HQStatus> {
  try {
    return normalizeHQStatus(JSON.parse(await fsReadFile(HQ_STATUS_PATH)));
  } catch {
    return HQ_STATUS_EMPTY;
  }
}

/**
 * Merge `patch` into the stored pointer and overwrite the file. The read is
 * `{ fresh: true }` — a cached base would silently drop a concurrent writer's
 * update (see fsReadFile's contract on reads that feed writes). A timestamp
 * never moves BACKWARDS: the finish mark's runStartedAt comes from the
 * pending slot (the run's own start, possibly hours old) and any writer's
 * read can predate a concurrent mark — the newer of the two wins (ISO stamps
 * compare lexicographically). Prevents the 2759674fe class: a settle write
 * regressing runStartedAt to an older value.
 */
async function mergeHQStatus(
  patch: (status: HQStatus) => HQStatus,
): Promise<void> {
  try {
    let current: HQStatus = HQ_STATUS_EMPTY;
    try {
      current = normalizeHQStatus(
        JSON.parse(await fsReadFile(HQ_STATUS_PATH, undefined, { fresh: true })),
      );
    } catch {
      // absent or corrupt — start from the empty pointer
    }
    const next = patch(current);
    for (const key of ["runStartedAt"] as const) {
      const prev = current[key];
      const v = next[key];
      if (prev && (!v || prev > v)) next[key] = prev;
    }
    await fsWriteFile(HQ_STATUS_PATH, JSON.stringify(next, null, 2));
  } catch (e) {
    console.warn(
      "[hq-status] pointer write skipped:",
      e instanceof Error ? e.message : e,
    );
  }
}

// ─── Deferred run marks (D2): accumulate in run-state, ONE write at finish ──

/**
 * The claiming run's unflushed marks. A single slot (not a per-run map): a
 * run's store calls execute sequentially in one process and finish is always
 * the last of them, so one slot per process is exact. A new claim replaces
 * an unflushed slot (only possible if a previous run died between rounds —
 * its marks were never promised anywhere).
 */
interface PendingRunMarks {
  runId?: string;
  runStartedAt?: string;
  recentWrites: string[];
}
let pendingRun: PendingRunMarks | null = null;

/** A reflection run claimed the token and starts work. The started mark lands
 *  IMMEDIATELY (D2 reversed for this mark, 2026-10-14 — see the module
 *  header): runStatus "running" + runId + runStartedAt overwrite in place, so
 *  a run that never reaches finish still reads "running" with its start stamp
 *  instead of leaving the previous run's terminal status standing. `runId` is
 *  the claiming run's OWN durable id (read from the workflow metadata inside
 *  the step): the pod attaches its activity stream to it. The pending slot
 *  keeps accumulating this run's round outcomes, which ride the finish
 *  write. */
export async function recordHQRunStarted(runId?: string): Promise<void> {
  const at = new Date().toISOString();
  pendingRun = {
    ...(runId ? { runId } : {}),
    runStartedAt: at,
    recentWrites: [],
  };
  await mergeHQStatus((s) => ({
    ...s,
    runStatus: "running",
    ...(runId ? { runId } : {}),
    runStartedAt: at,
  }));
}

/**
 * One round's outcome: its landed writes ACCUMULATE into the pending slot
 * (newest-first, deduped, capped at flush). briefsHandled is NOT incremented
 * here — the run reports its definitive count at finish.
 */
export async function recordHQBriefOutcome(outcome: {
  actions: string[];
}): Promise<void> {
  if (outcome.actions.length === 0) return;
  if (!pendingRun) pendingRun = { recentWrites: [] };
  pendingRun.recentWrites = [
    ...new Set([...outcome.actions, ...pendingRun.recentWrites]),
  ].slice(0, RECENT_WRITES_CAP);
}

/**
 * The run settled — the pointer's settle write (the run's second, after the
 * immediate started mark). `wrote` / `errored` summarize the whole run (the
 * shell accumulates them across rounds): an errored run is 失败 even when an
 * earlier round landed something; a run that stored nothing is 空转 (idle) —
 * a legal, often correct outcome (§5), shown as such. A failed run's real
 * error line lands in `lastError` (first line, capped); a clean finish CLEARS
 * it. The pending slot's runId / runStartedAt / recentWrites ride along; the
 * slot is cleared whether or not the write lands (best-effort).
 *
 * v0.30 §2.3/§2.4 payload extensions: `note` (the last SUBSTANTIVE round's
 * one-line account — the shell already filtered idle rounds out, R1) lands as
 * the 暂存 `lastNote` stamped with the finish clock; `seen` (the furthest
 * wake pointer the run handled) advances `lastSeen`. Absent fields leave the
 * stored values untouched.
 */
export async function recordHQRunFinished(result: {
  handled: number;
  wrote: boolean;
  errored: boolean;
  /** The run's failure line — a round's error or the exception that escaped
   *  the loop. Carried to `lastError` so a 失败 says why. */
  error?: string;
  /** The last substantive round's note (空转轮不上交 — R1). */
  note?: string;
  /** The furthest {sliceId, turnId} the run's wakes named (每轮推进). */
  seen?: { sliceId?: string; turnId?: string };
}): Promise<void> {
  const runStatus = result.errored
    ? "failed"
    : result.wrote
      ? "completed"
      : "idle";
  const marks = pendingRun;
  pendingRun = null;
  const at = new Date().toISOString();
  await mergeHQStatus((s) => ({
    ...s,
    runStatus,
    briefsHandled: Math.max(0, Math.floor(result.handled)),
    ...(marks?.runId ? { runId: marks.runId } : {}),
    ...(marks?.runStartedAt ? { runStartedAt: marks.runStartedAt } : {}),
    lastError: result.errored ? errorPreviewOf(result.error) : null,
    recentWrites: [
      ...new Set([...(marks?.recentWrites ?? []), ...s.recentWrites]),
    ].slice(0, RECENT_WRITES_CAP),
    ...(result.note ? { lastNote: { note: result.note, at } } : {}),
    ...(result.seen ? { lastSeen: result.seen } : {}),
  }));
}
