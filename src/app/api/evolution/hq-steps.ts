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
import type { UIMessageChunk } from "ai";
import { HQ_TOKEN, type HQBriefPayload } from "./hq-contract";
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
 * brief's await, where runSubAgent's own tool-progress writer takes the
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
 * One brief's round summary, returned to the run shell so IT can accumulate
 * the run-level facts (did anything land, did anything fail) it reports to
 * the status pointer at finish. Type export only — the step-module rule
 * (step files export step functions + types).
 */
export interface HQBriefRound {
  /** What HQ landed this round (paths / case refs; empty = an idle round). */
  actions: string[];
  /** Set when the round failed (HQ never throws — a failure rides here). */
  error?: string;
}

/**
 * Conflict handoff. `resumeHook` is a runtime function that MUST be called
 * outside a workflow function (SDK contract) — hence this "use step". It
 * durably writes `hook_received` and only then wakes the primary run, so a
 * duplicate HQ that loses the claim hands its brief over instead of dropping
 * it (§11 ③).
 */
export async function handoffBriefToPrimary(payload: HQBriefPayload): Promise<void> {
  "use step";
  await resumeHook(HQ_TOKEN, payload);
}

/**
 * Handle ONE brief ("use step"): hand it to the HQ agent (hq-agent.ts) —
 * the verbatim prose, a date stamp, and the slice pointer the mechanical
 * replyToken carries. There is NO pointer extraction here anymore (P4b):
 * the brief's pointers are CLUES, and HQ re-reads the raw records itself
 * before touching anything (§5 独立审查 — a pointer is not a fact), so the
 * shell neither parses the prose nor pre-decides an agenda.
 *
 * HQ has no user-timezone channel (the payload contract carries none), so
 * the write stamp is the UTC date — the same clock the slice ids themselves
 * are named by (createSlice). Failure never throws out of here: handleBrief
 * returns { error } and logs it, and a failed brief simply lands nothing
 * (§5 — HQ's products are writes).
 *
 * The round's outcome is ALSO recorded into the hq.json status pointer
 * (hq-status-store.ts — the pod panel's visibility layer) and returned to
 * the shell, which accumulates the run-level facts for recordHQRunFinished.
 * The status store is imported dynamically for the same reason `./hq-agent`
 * is (see the module header).
 */
export async function handleHQBrief(payload: HQBriefPayload): Promise<HQBriefRound> {
  "use step";
  // replyToken is `field:<sliceId>:<startedAtIso>` (attached mechanically by
  // the reportToHQ executor) — the slice id is the one pointer the shell
  // legitimately owns; the ISO tail carries colons, so index, not split-all.
  const sliceId = payload.replyToken.startsWith("field:")
    ? payload.replyToken.split(":")[1] || undefined
    : undefined;
  // 开始核对 — the pod sees the round begin before the (possibly minutes-long)
  // agent work below.
  await emitHQActivity({
    kind: "reading",
    at: new Date().toISOString(),
    ...(sliceId ? { sliceId } : {}),
  });
  const date = new Date().toISOString().slice(0, 10);
  const { handleBrief } = await import("./hq-agent");
  const outcome = await handleBrief({
    brief: payload.brief,
    date,
    ...(sliceId ? { sliceId } : {}),
  });
  const { recordHQBriefOutcome } = await import("./hq-status-store");
  await recordHQBriefOutcome({ actions: outcome.actions });
  // The round's beat: landed writes ("wrote research/X"), a deliberate
  // no-write ("idle — nothing to write" — a veto that produced no write is
  // mechanically an empty round, its short reason riding the note), or the
  // failure line. HQ's own one-paragraph account (outcome.note) rides the
  // wrote/idle frames so the panel can show WHY, not only WHAT.
  if (outcome.error) {
    await emitHQActivity({
      kind: "failed",
      at: new Date().toISOString(),
      error: outcome.error,
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
 * done, or a failure that escaped a brief). `wrote` / `errored` are the
 * RUN-level accumulation across all of its briefs; the store maps them to
 * the terminal status (完成 / 空转 / 失败) and the definitive brief count.
 * The "finished" frame closes the activity feed with the same mapping —
 * pointer first, frame second, so a lost frame never costs the settlement.
 */
export async function markHQRunFinished(result: {
  handled: number;
  wrote: boolean;
  errored: boolean;
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
