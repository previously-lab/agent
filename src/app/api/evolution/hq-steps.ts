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
 */
import { resumeHook } from "workflow/api";
import { HQ_TOKEN, type HQBriefPayload } from "./hq-contract";

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
 */
export async function handleHQBrief(payload: HQBriefPayload): Promise<void> {
  "use step";
  // replyToken is `field:<sliceId>:<startedAtIso>` (attached mechanically by
  // the reportToHQ executor) — the slice id is the one pointer the shell
  // legitimately owns; the ISO tail carries colons, so index, not split-all.
  const sliceId = payload.replyToken.startsWith("field:")
    ? payload.replyToken.split(":")[1] || undefined
    : undefined;
  const date = new Date().toISOString().slice(0, 10);
  const { handleBrief } = await import("./hq-agent");
  await handleBrief({
    brief: payload.brief,
    date,
    ...(sliceId ? { sliceId } : {}),
  });
}
