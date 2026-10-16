/**
 * The field↔reflection channel's Node-side steps (v0.21 §4/§5; v0.30 §2
 * 机械铃; v0.34 常驻形态 R1).
 *
 * `reflection-run.ts` (the workflow file) imports this module, and the SDK
 * splits "use step" bodies out of the workflow bundle — so the impure work
 * below stays on the Node side. The `./hq-agent` import is dynamic on
 * purpose: the workflow plugin still traces a *static* edge out of a
 * workflow-reachable module, and the HQ agent statically pulls the episodic
 * / sub-agent / card-evolution machinery, which reaches `fs` / `next` —
 * that is exactly what broke the dev server with node-js-module-in-workflow
 * errors in P2. A static edge would also close a module cycle
 * (tool-executors → reflection-run → reflection-steps → hq-agent →
 * sub-agent-runner → models/provider → … → turn-workflow → tools →
 * tool-executors).
 * (docs/errors/node-js-module-in-workflow)
 *
 * The static imports stay sandbox-safe: `workflow` / `workflow/api`
 * primitives plus the PURE frame contract (`@/lib/chat/hq-stream` — no fs,
 * no next). Each beat of the run emits ONE `data-hq-activity` frame into the
 * run's durable stream (getWritable in a step — the tool-executors pattern),
 * so the companion pod can watch the reflection unit live and re-attach
 * after a reload; the frames are third-person activity, never speech (the
 * unit has no mouth, §9).
 */
import { getWritable, getWorkflowMetadata } from "workflow";
import { resumeHook } from "workflow/api";
import { HookNotFoundError } from "workflow/errors";
import type { UIMessageChunk } from "ai";
import {
  REFLECTION_TOKEN,
  type ReflectionWakePayload,
} from "./reflection-contract";
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
 * One lap's round summary, returned to the run shell so IT can settle the
 * pointer (settleReflectionRound). Type export only — the step-module rule
 * (step files export step functions + types).
 */
export interface ReflectionRound {
  /** What the unit landed this round (paths / case refs; empty = idle). */
  actions: string[];
  /** Set when the round failed (the unit never throws — a failure rides here). */
  error?: string;
  /**
   * The unit's own one-line account of the round (its hqReport note), when
   * non-empty. The settle step decides whether it is staged as `lastNote`
   * (R1: only a round that WROTE something stages — 空转不留痕).
   */
  note?: string;
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
 * The caller (reflection-run.ts) re-checks the conflict and, with no live
 * primary left, claims and handles the wake itself — the wake never drops.
 */
export async function handoffBriefToPrimary(payload: ReflectionWakePayload): Promise<boolean> {
  "use step";
  try {
    await resumeHook(REFLECTION_TOKEN, payload);
    return true;
  } catch (e) {
    if (HookNotFoundError.is(e)) return false;
    throw e;
  }
}

/**
 * Handle ONE lap's round ("use step"): hand the lap's pointer to the
 * reflection unit (hq-agent.ts) — the furthest sealed slice the drained
 * mailbox named, verbatim, plus a date stamp. There is NO semantic payload
 * at all (v0.30 §2.2): the record is the channel, and the unit re-reads the
 * raw records itself before touching anything (§5 独立审查 — a pointer is
 * not a fact), so the shell neither interprets nor pre-decides an agenda.
 *
 * The unit's write stamp rides the USER's clock: the field attaches its
 * local calendar date as `payload.date` (the same clock the slice ids
 * themselves are named by); bare wakes carry none and the UTC date is the
 * fallback. Failure never throws out of here: handleBrief returns { error }
 * and logs it, and a failed round simply lands nothing (§5 — the unit's
 * products are writes).
 *
 * The pointer settlement is NOT here — it is the shell's next step
 * (settleReflectionRound), so the round step stays a pure act/read beat and
 * the settle step owns the hq.json write (v0.34 R1: per-round immediate
 * settlement, the D2 batching retired).
 */
export async function handleReflectionRound(payload: ReflectionWakePayload): Promise<ReflectionRound> {
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
  });
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
      // sub-agent's failure — e.g. an interruption cuts the report, not the
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
  };
}

/**
 * Per-round settlement ("use step") — v0.34 R1: the pointer settles EVERY
 * round, immediately (the run's finish comes only when the visit ends, so
 * the D2 accumulate-and-flush-at-finish batching retired). The store owns
 * the rules (§4.2): recentWrites merge at once, the generation's round
 * count ticks, `lastNote` stages only from a substantive round
 * (空转不留痕), `lastError` lands a failed round's real line and clears on
 * a clean one, and the cursor (`lastSeen`) advances ONLY on success or a
 * deliberate idle — a failed round leaves it so the next lap re-reads from
 * the same edge.
 *
 * `pointer` is the lap's drained-mailbox pointer (the shell owns it — the
 * round no longer echoes it).
 */
export async function settleReflectionRound(
  round: ReflectionRound,
  pointer: ReflectionWakePayload,
): Promise<void> {
  "use step";
  const { recordReflectionRoundSettled } = await import("./hq-status-store");
  await recordReflectionRoundSettled({
    actions: round.actions,
    ...(round.error ? { error: round.error } : {}),
    ...(round.note ? { note: round.note } : {}),
    ...(pointer.sliceId ? { seen: { sliceId: pointer.sliceId } } : {}),
  });
}

/**
 * Run-start mark ("use step"): a reflection run claimed the mailbox — the
 * pointer's runStatus goes "running" (the in-visit常态) until the idle-exit
 * mark settles it, and the generation's round count resets. The run's OWN
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
 * Idle-exit mark ("use step"): the visit's terminal beat — the mailbox has
 * been quiet for the whole visit grace (60 minutes) at a lap boundary,
 * never mid-round. The pointer settles `runStatus: "idle"` and the
 * "finished" frame closes the activity feed with the same verdict — pointer
 * first, frame second, so a lost frame never costs the settlement. NO
 * successor follows (用户裁决：寿命 = 一次访问): the pointer honestly reads
 * "idle" until the next visit's first bell starts a fresh generation via
 * the delivery fallback and its started mark overwrites — the on-disk
 * cursor (lastSeen) carries the continuity, so the seam is invisible.
 */
export async function markReflectionRunIdleExit(result: {
  /** Rounds this generation settled (the definitive count). */
  rounds: number;
}): Promise<void> {
  "use step";
  const { recordReflectionRunIdleExit } = await import("./hq-status-store");
  await recordReflectionRunIdleExit(result);
  await emitHQActivity({
    kind: "finished",
    at: new Date().toISOString(),
    status: "idle",
    handled: Math.max(0, Math.floor(result.rounds)),
  });
}

