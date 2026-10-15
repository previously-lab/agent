/**
 * The field↔HQ channel's Node-side steps (v0.21 §4/§5).
 *
 * `hq-run.ts` (the workflow file) imports this module, and the SDK splits
 * "use step" bodies out of the workflow bundle — so the impure work below
 * stays on the Node side. The `./hq-agent` import is dynamic on purpose: the
 * workflow plugin still traces a *static* edge out of a workflow-reachable
 * module, and the HQ agent statically pulls the episodic / sub-agent /
 * card-evolution machinery, which reaches `fs` / `next` — that is exactly
 * what broke the dev server with node-js-module-in-workflow errors in P2.
 * A static edge would also close a module cycle (tool-executors → hq-run →
 * hq-steps → hq-agent → sub-agent-runner → models/provider → … →
 * turn-workflow → tools → tool-executors).
 * (docs/errors/node-js-module-in-workflow)
 *
 * The static imports stay sandbox-safe: `workflow` / `workflow/api`
 * primitives plus the PURE frame contract (`@/lib/chat/hq-stream` — no fs,
 * no next). Each beat of the run emits ONE `data-hq-activity` frame into the
 * run's durable stream (getWritable in a step — the tool-executors pattern),
 * so the companion pod can watch HQ live and re-attach after a reload; the
 * frames are third-person activity, never speech (HQ has no mouth, §9).
 */
import { getWritable, getWorkflowMetadata } from "workflow";
import { resumeHook } from "workflow/api";
import { HookNotFoundError } from "workflow/errors";
import type { UIMessageChunk } from "ai";
import { HQ_TOKEN, type ReflectionWakePayload } from "./hq-contract";
import {
  HQ_ACTIVITY_CHUNK,
  type HQActivityFrame,
} from "@/lib/chat/hq-stream";

// ─── Activity frames (the pod's live feed) ────────────────────────────────

/** Per-invocation frame sequence; the ms timestamp disambiguates across steps. */
let frameSeq = 0;

/**
 * Emit ONE activity frame into the run's stream. Best-effort: a gone stream
 * (client disconnected, or no run context when a unit test drives the step
 * directly) must never break the beat the frame describes. The writer is
 * acquired per frame and released immediately — never held across the
 * round's await, where runSubAgent's own tool-progress writer takes the
 * same stream's lock.
 */
async function emitHQActivity(frame: HQActivityFrame): Promise<void> {
  try {
    const writer = getWritable<UIMessageChunk>().getWriter();
    try {
      await writer.write({
        type: HQ_ACTIVITY_CHUNK,
        id: `hq-${Date.now().toString(36)}-${(frameSeq++).toString(36)}`,
        data: frame,
      } as UIMessageChunk);
    } finally {
      writer.releaseLock();
    }
  } catch {
    /* stream gone / no run context — the beat itself already happened */
  }
}

/**
 * One wake's round summary, returned to the run shell so IT can accumulate
 * the run-level facts (did anything land, did anything fail) it reports to
 * the status pointer at finish. Type export only — the step-module rule
 * (step files export step functions + types).
 */
export interface HQBriefRound {
  /** What HQ landed this round (paths / case refs; empty = an idle round). */
  actions: string[];
  /** Set when the round failed (HQ never throws — a failure rides here). */
  error?: string;
  /**
   * The unit's own one-line account of the round (its hqReport note), when
   * non-empty. The shell decides whether it is staged as `lastNote` (R1:
   * only a round that WROTE something stages — 空转不留痕).
   */
  note?: string;
  /**
   * The wake's pointer, echoed back when it named anything — the shell
   * advances the rolling `lastSeen` with it (every round pushes it forward).
   */
  seen?: { sliceId?: string; turnId?: string };
}

/**
 * Conflict handoff. `resumeHook` is a runtime function that MUST be called
 * outside a workflow function (SDK contract) — hence this "use step". It
 * durably writes `hook_received` and only then wakes the primary run, so a
 * duplicate run that loses the claim hands its wake over instead of dropping
 * it (§11 ③).
 *
 * Returns false when the primary is GONE (HookNotFoundError — it finished
 * inside the handoff window): swallowing that here matters because a step's
 * retry budget would otherwise burn out and the wake would die silently.
 * The caller (hq-run.ts) re-checks the conflict and, with no live primary
 * left, claims and handles the wake itself — the wake never drops.
 */
export async function handoffBriefToPrimary(payload: ReflectionWakePayload): Promise<boolean> {
  "use step";
  try {
    await resumeHook(HQ_TOKEN, payload);
    return true;
  } catch (e) {
    if (HookNotFoundError.is(e)) return false;
    throw e;
  }
}

/**
 * Handle ONE wake ("use step"): hand the pointer to the reflection unit
 * (hq-agent.ts) — the slice/turn it names, verbatim, plus a date stamp.
 * There is NO semantic payload at all (v0.30 §2.2): the record is the
 * channel, and the unit re-reads the raw records itself before touching
 * anything (§5 独立审查 — a pointer is not a fact), so the shell neither
 * interprets nor pre-decides an agenda.
 *
 * The unit's write stamp rides the USER's clock: the field attaches its
 * local calendar date as `payload.date` (the same clock the slice ids
 * themselves are named by); bare wakes (the cancel route holds only a
 * runId) carry none and the UTC date is the fallback. Failure never throws
 * out of here: handleBrief returns { error } and logs it, and a failed
 * round simply lands nothing (§5 — the unit's products are writes).
 *
 * The round's outcome is ALSO recorded into the hq.json status pointer
 * (hq-status-store.ts — the pod panel's visibility layer) and returned to
 * the shell, which accumulates the run-level facts for recordHQRunFinished.
 * The status store is imported dynamically for the same reason `./hq-agent`
 * is (see the module header).
 */
export async function handleHQBrief(payload: ReflectionWakePayload): Promise<HQBriefRound> {
  "use step";
  // 开始核对 — the pod sees the round begin before the (possibly minutes-long)
  // agent work below.
  await emitHQActivity({
    kind: "reading",
    at: new Date().toISOString(),
    ...(payload.sliceId ? { sliceId: payload.sliceId } : {}),
  });
  const date = payload.date ?? new Date().toISOString().slice(0, 10);
  const { handleBrief } = await import("./hq-agent");
  const outcome = await handleBrief({
    date,
    ...(payload.sliceId ? { sliceId: payload.sliceId } : {}),
    ...(payload.turnId ? { turnId: payload.turnId } : {}),
  });
  const { recordHQBriefOutcome } = await import("./hq-status-store");
  await recordHQBriefOutcome({ actions: outcome.actions });
  // The round's beat: landed writes ("wrote research/X"), a deliberate
  // no-write ("idle — nothing to write" — a veto that produced no write is
  // mechanically an empty round, its short reason riding the note), or the
  // failure line. The unit's own one-paragraph account (outcome.note) rides
  // the wrote/idle frames so the panel can show WHY, not only WHAT.
  if (outcome.error) {
    await emitHQActivity({
      kind: "failed",
      at: new Date().toISOString(),
      error: outcome.error,
      // A failed round may still have LANDED writes (the flush survives the
      // sub-agent's failure — e.g. a timeout cuts the report, not the
      // writes that preceded it) — carry them so the feed says so.
      ...(outcome.actions.length > 0 ? { paths: outcome.actions } : {}),
    });
  } else if (outcome.actions.length > 0) {
    await emitHQActivity({
      kind: "wrote",
      at: new Date().toISOString(),
      paths: outcome.actions,
      ...(outcome.note ? { note: outcome.note } : {}),
    });
  } else {
    await emitHQActivity({
      kind: "idle",
      at: new Date().toISOString(),
      ...(outcome.note ? { note: outcome.note } : {}),
    });
  }
  return {
    actions: outcome.actions,
    ...(outcome.error ? { error: outcome.error } : {}),
    ...(outcome.note ? { note: outcome.note } : {}),
    ...(payload.sliceId || payload.turnId
      ? {
          seen: {
            ...(payload.sliceId ? { sliceId: payload.sliceId } : {}),
            ...(payload.turnId ? { turnId: payload.turnId } : {}),
          },
        }
      : {}),
  };
}

/**
 * Run-start mark ("use step"): an HQ run claimed the token — the pointer's
 * runStatus goes "running" until markHQRunFinished settles it. The run's OWN
 * durable id rides along (read from the workflow metadata HERE, inside the
 * claiming run — a dispatch receipt can name a duplicate that loses the
 * claim, so the pointer never trusts it): that id is the pod's stream-attach
 * target. The "started" frame opens the run's activity feed.
 */
export async function markHQRunStarted(): Promise<void> {
  "use step";
  const { recordHQRunStarted } = await import("./hq-status-store");
  let runId: string | undefined;
  try {
    runId = getWorkflowMetadata().workflowRunId;
  } catch {
    // No workflow context (a unit test driving the step directly) — the
    // pointer keeps its previous runId rather than learning a false one.
  }
  await recordHQRunStarted(runId);
  await emitHQActivity({ kind: "started", at: new Date().toISOString() });
}

/**
 * Run-finish mark ("use step"): the shell's loop ended (idle grace, hook
 * done, or a failure that escaped a round). `wrote` / `errored` are the
 * RUN-level accumulation across all of its wakes; the store maps them to
 * the terminal status (完成 / 空转 / 失败) and the definitive round count,
 * and a failed run's real error line rides along to the pointer's lastError.
 * The "finished" frame closes the activity feed with the same mapping —
 * pointer first, frame second, so a lost frame never costs the settlement.
 */
export async function markHQRunFinished(result: {
  handled: number;
  wrote: boolean;
  errored: boolean;
  /** The run's failure line (a round's error or the exception that escaped
   *  the loop) — carried to the pointer so a 失败 says why. */
  error?: string;
  /** The last SUBSTANTIVE round's note (R1 — idle rounds never stage one);
   *  lands as the 暂存 `lastNote` the panel shows and the next turn carries. */
  note?: string;
  /** The furthest wake pointer the run handled — advances `lastSeen`. */
  seen?: { sliceId?: string; turnId?: string };
}): Promise<void> {
  "use step";
  const { recordHQRunFinished } = await import("./hq-status-store");
  await recordHQRunFinished(result);
  await emitHQActivity({
    kind: "finished",
    at: new Date().toISOString(),
    status: result.errored ? "failed" : result.wrote ? "completed" : "idle",
    handled: Math.max(0, Math.floor(result.handled)),
  });
}
