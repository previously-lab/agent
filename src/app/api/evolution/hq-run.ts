/**
 * HQ run — the reflection unit's shell (v0.21 §4 P2; v0.30 §2 机械铃).
 *
 * There is ONE agent with two execution units: the field (the conversation
 * workflow, user-facing) and the reflection unit (archives/evolution, no
 * mouth). Nobody briefs it: it is woken ONLY by the mechanical bell — the
 * engineering layer hands over a pure pointer ({sliceId, turnId, date})
 * after each turn lands on disk (v0.30 裁决 1/2) — works while wakes keep
 * arriving, and DESTROYS ITSELF after an idle window (不常驻, 裁决 4).
 *
 * Lifecycle:
 *   createHook({ token: HQ_TOKEN }) → await hook.getConflict()
 *     conflict → hand the wake to the primary run, then exit { dedupedTo };
 *       the wake is never dropped (§11 ③).
 *     no conflict → claim the token, handle the initial wake (the payload
 *       that started this run arrives as the run's INPUT, not through the
 *       hook), then loop: next wake vs an idle-grace sleep race — "idle" or
 *       "done" ends the run and releases the token (下一次铃重新 start).
 *
 * This is a WORKFLOW file: its static import graph is bundled into the
 * workflow sandbox, which has no Node modules (docs/errors/
 * node-js-module-in-workflow). Everything impure therefore lives in
 * hq-steps.ts behind "use step" — this module imports only `workflow`, the
 * pure contract, and those step functions.
 *
 * Each wake is handled by `handleHQBrief`, which hands it to the reflection
 * unit itself (hq-agent.ts — the pointer verbatim plus a date stamp; the
 * unit reads the raw records and decides for itself, §5). The P2 mechanical
 * bridge (pointer extraction → executeBoundaryRun) is gone, and so is the
 * v0.21 prose-brief channel (v0.30: the record is the channel).
 *
 * Lives under src/app so the withWorkflow loader picks up the directives.
 */
import { createHook, sleep } from "workflow";
import {
  HQ_TOKEN,
  type ReflectionWakePayload,
  type HQRunOutcome,
} from "./hq-contract";
import { handoffBriefToPrimary, handleHQBrief, markHQRunStarted, markHQRunFinished } from "./hq-steps";

export { HQ_TOKEN } from "./hq-contract";
export type { ReflectionWakePayload, HQRunOutcome } from "./hq-contract";

/**
 * Idle grace before the unit packs up. The hook has no queue length to
 * inspect — "the queue is empty" is undecidable, so the end-of-work call is
 * a race between the next wake and this sleep (§4). The window length is an
 * implementation parameter, not a semantic judgment: 2 minutes covers a
 * conversation's burst of turns (ten messages = ONE run) without keeping
 * the unit resident.
 */
const HQ_IDLE_GRACE_MS = 120_000;

export async function hqRun(initial: ReflectionWakePayload): Promise<HQRunOutcome> {
  "use workflow";
  const hook = createHook<ReflectionWakePayload>({ token: HQ_TOKEN });
  try {
    // 认领（裁决 9）：awaiting getConflict() suspends the run and COMMITS the
    // hook registration — from here the field's resumeHook can reach us.
    const conflict = await hook.getConflict();
    if (conflict) {
      // 转交链：先把唤醒交给主，再自退（不自退前转交，唤醒会丢——§11 ③）。
      if (await handoffBriefToPrimary(initial)) {
        return { kind: "dedupedTo", runId: conflict.runId };
      }
      // 闭环：主 run 恰在转交窗口内收工（HookNotFoundError）——重新核对冲突
      // （有界：仅此一次），新主已认领则再转交；仍无主则这次唤醒由本 run
      // 自己认领处理，唤醒绝不丢。
      const again = await hook.getConflict();
      if (again && (await handoffBriefToPrimary(initial))) {
        return { kind: "dedupedTo", runId: again.runId };
      }
    }

    // The visibility pointer (hq-status-store.ts): "running" from the claim
    // until the finish mark below settles 完成 / 空转 / 失败. A deduped rival
    // exits BEFORE this mark — the primary's run owns the pointer.
    await markHQRunStarted();

    // 收工前的循环：每次唤醒 = 一轮独立工作；下一次与宽限 race。Run-level
    // facts accumulate across wakes for the finish mark. R1 (v0.30 §2.4): a
    // round stages its note as the 暂存 ONLY when it wrote something (空转
    // 不留痕) — the last substantive round's note wins; the rolling read
    // pointer (lastSeen) advances with EVERY wake that named one.
    let handled = 0;
    let wrote = false;
    let errored = false;
    let lastError: string | undefined;
    let stagedNote: string | undefined;
    let furthestSeen: { sliceId?: string; turnId?: string } | undefined;
    let pending: ReflectionWakePayload | null = initial;
    try {
      const iterator = hook[Symbol.asyncIterator]();
      try {
        while (pending) {
          const round = await handleHQBrief(pending);
          handled += 1;
          if (round.actions.length > 0) {
            wrote = true;
            if (round.note) stagedNote = round.note;
          }
          if (round.seen) furthestSeen = round.seen;
          if (round.error) {
            errored = true;
            lastError = round.error;
          }
          pending = null;
          const next = await Promise.race<
            ReflectionWakePayload | "idle" | "done"
          >([
            iterator
              .next()
              .then((r): ReflectionWakePayload | "done" => (r.done ? "done" : r.value)),
            sleep(HQ_IDLE_GRACE_MS).then((): "idle" => "idle"),
          ]);
          if (next === "idle" || next === "done") break;
          pending = next;
        }
      } finally {
        await iterator.return?.();
      }
    } catch (e) {
      errored = true;
      lastError = e instanceof Error ? e.message : String(e);
      throw e;
    } finally {
      await markHQRunFinished({
        handled,
        wrote,
        errored,
        ...(lastError ? { error: lastError } : {}),
        ...(stagedNote ? { note: stagedNote } : {}),
        ...(furthestSeen ? { seen: furthestSeen } : {}),
      });
    }
    return { kind: "claimed", handled };
  } finally {
    // Token released with the run — the next report starts a fresh HQ run.
    hook.dispose();
  }
}
