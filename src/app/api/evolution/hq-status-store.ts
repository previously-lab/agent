/**
 * HQ status store — the writers behind `memory/config/hq.json` (v0.21 §4/§5
 * visibility layer).
 *
 * ONE rolling pointer, OVERWRITTEN in place: no history, no ledger. The four
 * record functions are the ONLY writers, called from the dispatch executor
 * (`tool-executors.ts`'s reportToHQ) and the HQ run shell (`hq-run.ts` /
 * `hq-steps.ts`):
 *
 *   recordDispatch      — the field's latest brief (time + preview)
 *   recordRunStarted    — an HQ run claimed the token (runStatus: "running")
 *   recordBriefOutcome  — one brief's landed writes merge into recentWrites
 *   recordRunFinished   — runStatus settles: 完成 / 空转 / 失败 + briefsHandled
 *
 * Every function is BEST-EFFORT: a status write must never break the dispatch
 * it describes or the HQ run it instruments, so all errors are swallowed with
 * a console.warn. Read-modify-write races between the field and HQ are
 * possible (they run in different durable runs) — the loser loses one pointer
 * update, which the next write heals; that is the price of keeping this a
 * pointer instead of a transaction.
 *
 * Imported DYNAMICALLY from hq-steps.ts (a workflow-reachable step module —
 * see the note there) and statically from tool-executors.ts, which already
 * statically reaches io-helpers through `@/lib/evolution/store`.
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
/** The dispatch preview keeps the brief's first line, truncated. */
const BRIEF_PREVIEW_MAX = 120;

/**
 * The brief's first line, single-spaced and capped — the panel shows a
 * glance, and the whole prose stays in the slice record where it belongs.
 */
export function briefPreviewOf(brief: string): string {
  const firstLine = brief.trim().split("\n", 1)[0]?.trim() ?? "";
  return firstLine.length > BRIEF_PREVIEW_MAX
    ? `${firstLine.slice(0, BRIEF_PREVIEW_MAX)}…`
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
 * update (see fsReadFile's contract on reads that feed writes).
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
    await fsWriteFile(HQ_STATUS_PATH, JSON.stringify(patch(current), null, 2));
  } catch (e) {
    console.warn(
      "[hq-status] pointer write skipped:",
      e instanceof Error ? e.message : e,
    );
  }
}

/** The field dispatched a brief to HQ (delivery confirmed by the executor). */
export async function recordHQDispatch(brief: string): Promise<void> {
  const at = new Date().toISOString();
  await mergeHQStatus((s) => ({
    ...s,
    lastDispatchAt: at,
    lastBriefPreview: briefPreviewOf(brief),
  }));
}

/** An HQ run claimed the token and starts work. The last run's outcome stays
 *  visible in the other fields until this one settles. */
export async function recordHQRunStarted(): Promise<void> {
  const at = new Date().toISOString();
  await mergeHQStatus((s) => ({ ...s, runStartedAt: at, runStatus: "running" }));
}

/**
 * One brief's outcome: its landed writes merge into the rolling recentWrites
 * (newest first, deduped, capped). briefsHandled is NOT incremented here —
 * the run reports its definitive count at finish.
 */
export async function recordHQBriefOutcome(outcome: {
  actions: string[];
}): Promise<void> {
  if (outcome.actions.length === 0) return;
  await mergeHQStatus((s) => {
    const merged = [...outcome.actions, ...s.recentWrites];
    return {
      ...s,
      recentWrites: [...new Set(merged)].slice(0, RECENT_WRITES_CAP),
    };
  });
}

/**
 * The run settled. `wrote` / `errored` summarize the whole run (the shell
 * accumulates them across briefs): an errored run is 失败 even when an
 * earlier brief landed something; a run that stored nothing is 空转 (idle) —
 * a legal, often correct outcome (§5), shown as such.
 */
export async function recordHQRunFinished(result: {
  handled: number;
  wrote: boolean;
  errored: boolean;
}): Promise<void> {
  const runStatus = result.errored
    ? "failed"
    : result.wrote
      ? "completed"
      : "idle";
  await mergeHQStatus((s) => ({
    ...s,
    runStatus,
    briefsHandled: Math.max(0, Math.floor(result.handled)),
  }));
}
