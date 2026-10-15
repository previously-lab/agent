/**
 * HQ status store — the writers behind `memory/config/hq.json` (v0.21 §4/§5
 * visibility layer; v0.30 §2.3/§2.4; v0.34 常驻形态 R1).
 *
 * ONE rolling pointer, OVERWRITTEN in place: no history, no ledger. The
 * record functions are the ONLY writers, all called from the reflection run
 * shell (`reflection-run.ts` / `reflection-steps.ts`):
 *
 *   recordHQRunStarted            — a generation claimed the mailbox (runId +
 *                                   start stamp + 本代轮数清零); writes
 *                                   IMMEDIATELY (a run that hangs or dies
 *                                   mid-flight must still read "running")
 *   recordReflectionRoundSettled  — ONE ROUND settled (v0.34 R1: per-round
 *                                   immediate — the resident run's finish may
 *                                   be days away, so the D2
 *                                   accumulate-in-module-and-flush-at-finish
 *                                   batching is RETIRED, pendingRun slot and
 *                                   recordHQBriefOutcome with it). Rules:
 *                                   recentWrites merge at once; briefsHandled
 *                                   ticks +1; lastNote stages only from a
 *                                   SUBSTANTIVE round (R1: 空转不留痕);
 *                                   lastError lands a failed round's real
 *                                   first line and CLEARS on a clean one;
 *                                   the cursor (lastSeen) advances ONLY on
 *                                   success or deliberate idle — a failed
 *                                   round leaves it (§4.2 行为变更: the old
 *                                   shell advanced furthestSeen on failed
 *                                   rounds too, silently skipping content)
 *   recordReflectionRunRetired    — the generation's ONLY clean terminal:
 *                                   runStatus "retired" (修订 B: idle-24h ∨
 *                                   age-7d at a lap boundary), then the
 *                                   successor's started mark overwrites
 *                                   within seconds
 *
 * A run that dies between marks (cancel/crash/platform) leaves the pointer
 * reading "running" with its start stamp — stale but dated and honest; the
 * status route heals it against the run registry (settleHQRunIfStale — a
 * CANCELLED run's marks never execute, so the next generation's start alone
 * is not the only repair).
 *
 * Every function is BEST-EFFORT: a status write must never break the
 * reflection run it instruments, so all errors are swallowed with a
 * console.warn. Read-modify-write races between turns and the unit are
 * possible (they run in different durable runs) — the loser loses one pointer
 * update, which the next write heals; that is the price of keeping this a
 * pointer instead of a transaction.
 *
 * Imported DYNAMICALLY from reflection-steps.ts (a workflow-reachable step
 * module — see the note there) and statically from tool-executors.ts /
 * steps.ts, which already statically reach io-helpers.
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
 * never moves BACKWARDS: any writer's read can predate a concurrent mark —
 * the newer of the two wins (ISO stamps compare lexicographically). Prevents
 * the 2759674fe class: a settle write regressing runStartedAt to an older
 * value.
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

/** A reflection generation claimed the mailbox and stands ready. The started
 *  mark lands IMMEDIATELY (the 2026-10-14 reversal stands: a run that hangs
 *  or dies mid-flight must still read "running" with its start stamp instead
 *  of leaving the previous run's terminal status standing). `runId` is the
 *  claiming run's OWN durable id (read from the workflow metadata inside the
 *  step): the pod attaches its activity stream to it. The generation's round
 *  count RESETS here — briefsHandled is per-generation (本代轮数). */
export async function recordHQRunStarted(runId?: string): Promise<void> {
  const at = new Date().toISOString();
  await mergeHQStatus((s) => ({
    ...s,
    runStatus: "running",
    ...(runId ? { runId } : {}),
    runStartedAt: at,
    briefsHandled: 0,
  }));
}

/**
 * ONE round's settlement, written IMMEDIATELY (v0.34 R1 — see the module
 * header). The rules (§4.2):
 *  - the generation's round count ticks +1 (every round that ran counts —
 *    wrote, idle, or failed alike);
 *  - landed writes merge into recentWrites at once (newest-first, deduped,
 *    capped);
 *  - a failed round's real error line lands in `lastError` (7f1afc1
 *    honesty); a clean round CLEARS it — the pointer answers "how is the
 *    unit NOW", not a ledger of past failures;
 *  - `lastNote` stages only from a SUBSTANTIVE round (wrote something and
 *    said why — R1: 空转不留痕);
 *  - the cursor (`lastSeen`) advances ONLY when the round did NOT fail —
 *    success or deliberate idle. A failed round leaves the cursor so the
 *    next lap re-reads from the same edge (writer-is-reader converges the
 *    redo).
 */
export async function recordReflectionRoundSettled(round: {
  actions: string[];
  /** Set when the round failed — the real error line lands in lastError. */
  error?: string;
  /** The round's own one-line account; stages only from a substantive round. */
  note?: string;
  /** The lap's furthest sealed slice — the cursor target. */
  seen?: { sliceId?: string };
}): Promise<void> {
  const at = new Date().toISOString();
  await mergeHQStatus((s) => ({
    ...s,
    briefsHandled: s.briefsHandled + 1,
    ...(round.actions.length > 0
      ? {
          recentWrites: [
            ...new Set([...round.actions, ...s.recentWrites]),
          ].slice(0, RECENT_WRITES_CAP),
        }
      : {}),
    lastError: round.error ? errorPreviewOf(round.error) : null,
    ...(round.actions.length > 0 && round.note
      ? { lastNote: { note: round.note, at } }
      : {}),
    ...(!round.error && round.seen ? { lastSeen: round.seen } : {}),
  }));
}

/**
 * The generation retired (修订 B — the unit's ONLY clean terminal): the idle
 * clock (24h) or the age clock (7d) won the blocking race at a lap boundary.
 * The pointer settles `runStatus: "retired"` with the definitive round count
 * (belt and braces — the per-round settle already ticks it). `lastError` is
 * NOT touched: retirement is not a failure, and a previous failure line
 * stays until a clean round of the NEW generation clears it. The successor's
 * started mark lands seconds later — the pointer never leaves the
 * "running 系" for longer than the relay takes.
 */
export async function recordReflectionRunRetired(result: {
  /** Rounds this generation settled (the definitive count). */
  rounds: number;
}): Promise<void> {
  await mergeHQStatus((s) => ({
    ...s,
    runStatus: "retired",
    briefsHandled: Math.max(0, Math.floor(result.rounds)),
  }));
}

// ─── Stale-"running" settle (the cancelled-run hole) ───────────────────────

/**
 * Settle a pointer whose "running" run is TERMINAL in the workflow registry
 * (cancelled/failed/completed without a finish mark). Run cancellation stops
 * the workflow at its next suspension point — a cancelled run's remaining
 * steps are never scheduled, so without this the pointer reads "running"
 * forever (observed 2026-10-14: a run cancelled at 1h24m left the pointer
 * running; Workflow docs, foundations/cancellation). The status route calls
 * this when its read finds the pointer claiming a run the registry says is
 * over. The merge's fresh read re-checks BOTH the runStatus and the runId,
 * so a run that settled (or a new generation that claimed the pointer)
 * between the route's read and this write is never clobbered. Returns the
 * settled (or untouched) status for the route's response.
 */
export async function settleHQRunIfStale(
  runId: string,
  registryStatus: string,
): Promise<HQStatus> {
  let settled: HQStatus = HQ_STATUS_EMPTY;
  await mergeHQStatus((s) => {
    if (s.runStatus !== "running" || s.runId !== runId) {
      settled = s;
      return s;
    }
    settled = {
      ...s,
      runStatus: "failed",
      lastError: errorPreviewOf(
        `run ended as "${registryStatus}" in the registry without a finish mark — cancelled or died mid-run`,
      ),
    };
    return settled;
  });
  return settled;
}
