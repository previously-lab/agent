/**
 * HQ run — the field↔HQ communication shell (v0.21 §4, phase P2).
 *
 * There is ONE agent with two execution units: the field (the conversation
 * workflow, user-facing) and HQ (archives/evolution, no mouth). The field
 * REPORTS to HQ; HQ is woken ONLY by a report (no mechanical triage, no
 * slice-close trigger — v0.21 裁决 1/8/9), works while reports keep
 * arriving, and DESTROYS ITSELF after an idle window (不常驻, 裁决 4).
 *
 * Lifecycle:
 *   createHook({ token: HQ_TOKEN }) → await hook.getConflict()
 *     conflict → hand the brief to the primary run, then exit { dedupedTo };
 *       the brief is never dropped (§11 ③).
 *     no conflict → claim the token, process the initial brief (the payload
 *       that started this run arrives as the run's INPUT, not through the
 *       hook), then loop: next brief vs an idle-grace sleep race — "idle" or
 *       "done" ends the run and releases the token (下一条简报重新 start).
 *
 * This is a WORKFLOW file: its static import graph is bundled into the
 * workflow sandbox, which has no Node modules (docs/errors/
 * node-js-module-in-workflow). Everything impure therefore lives in
 * hq-steps.ts behind "use step" — this module imports only `workflow`, the
 * pure contract, and those two step functions.
 *
 * P2 scope: each brief is handled by `handleHQBrief`, which bridges to the
 * EXISTING background execution entry so behavior stays available. P4 swaps
 * that bridge for the HQ agent itself (hq-agent.ts).
 *
 * Lives under src/app so the withWorkflow loader picks up the directives.
 */
import { createHook, sleep } from "workflow";
import {
  HQ_TOKEN,
  type HQBriefPayload,
  type HQRunOutcome,
} from "./hq-contract";
import { handoffBriefToPrimary, handleHQBrief } from "./hq-steps";

export { HQ_TOKEN } from "./hq-contract";
export type { HQBriefPayload, HQRunOutcome } from "./hq-contract";

/**
 * Idle grace before HQ packs up. The hook has no queue length to inspect —
 * "the queue is empty" is undecidable, so the end-of-work call is a race
 * between the next brief and this sleep (§4). The window length is an
 * implementation parameter, not a semantic judgment: 2 minutes covers a
 * conversation's burst of reports (ten messages = ONE run) without keeping
 * HQ resident.
 */
const HQ_IDLE_GRACE_MS = 120_000;

export async function hqRun(initial: HQBriefPayload): Promise<HQRunOutcome> {
  "use workflow";
  const hook = createHook<HQBriefPayload>({ token: HQ_TOKEN });
  try {
    // 认领（裁决 9）：awaiting getConflict() suspends the run and COMMITS the
    // hook registration — from here the field's resumeHook can reach us.
    const conflict = await hook.getConflict();
    if (conflict) {
      // 转交链：先把简报交给主，再自退（不自退前转交，简报会丢——§11 ③）。
      await handoffBriefToPrimary(initial);
      return { kind: "dedupedTo", runId: conflict.runId };
    }

    // 收工前的循环：每条简报 = 一轮独立工作；下一条与宽限 race。
    let handled = 0;
    let pending: HQBriefPayload | null = initial;
    const iterator = hook[Symbol.asyncIterator]();
    try {
      while (pending) {
        await handleHQBrief(pending);
        handled += 1;
        pending = null;
        const next = await Promise.race<
          HQBriefPayload | "idle" | "done"
        >([
          iterator
            .next()
            .then((r): HQBriefPayload | "done" => (r.done ? "done" : r.value)),
          sleep(HQ_IDLE_GRACE_MS).then((): "idle" => "idle"),
        ]);
        if (next === "idle" || next === "done") break;
        pending = next;
      }
    } finally {
      await iterator.return?.();
    }
    return { kind: "claimed", handled };
  } finally {
    // Token released with the run — the next report starts a fresh HQ run.
    hook.dispose();
  }
}
