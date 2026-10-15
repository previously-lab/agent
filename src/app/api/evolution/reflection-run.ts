/**
 * Reflection run — the reflection unit's shell (v0.21 §4 P2; v0.30 §2
 * 机械铃; v0.34 常驻形态 R1).
 *
 * There is ONE agent with two execution units: the field (the conversation
 * workflow, user-facing) and the reflection unit (archives/evolution, no
 * mouth). v0.34 makes the unit RESIDENT: one durable run that spends almost
 * all of its life suspended on its mailbox or its own clocks (zero compute
 * while waiting — sleep.mdx:12, child-workflows.mdx:149-153), and NEVER
 * exits on idle. Nobody briefs it: the field rings the bell ONLY when a
 * slice is sealed on disk (v0.34 R1 — the per-turn tail bell retired), and
 * the bell is a doorbell, not a work order: N bells ≠ N rounds. The unit
 * wakes, drains the mailbox (a bounded race against a short sleep — the
 * doorbell count resets, nothing merges), runs ONE round off the furthest
 * pointer, settles the pointer EVERY round (the D2 batching retired), and
 * goes back to sleep.
 *
 * Lifecycle (代际接力, versioning.mdx §Self-upgrading sequence-of-runs):
 *   createHook({ token: REFLECTION_TOKEN }) → await hook.getConflict()
 *     conflict → hand the wake to the primary run, then exit { dedupedTo };
 *       the wake is never dropped (§11 ③).
 *     no conflict → claim the token, then loop the laps above. Retirement
 *       comes ONLY at a lap boundary (never mid-round, 修订 B) when one of
 *       the two clocks wins the blocking race — idle 24h ∨ age 7d, whichever
 *       first: settle the pointer { retired } → dispose the mailbox →
 *       start the successor on `deploymentId: "latest"` → return.
 *   Death (cancel/crash/platform) runs no sequence: the next bell's
 *   delivery fallback (reflection-wake.ts) starts a fresh generation, and
 *   the status route's self-heal settles the stale "running" pointer.
 *
 * R1 scope: the loop is world→gate→round→settle with the world MINIMAL (no
 * gate) — a round's material is the drained mailbox's furthest pointer, fed
 * to the unchanged hq-agent. R2's `loadReflectionWorld` (cursor-based scope
 * + the two beats + the agenda arm) plugs into the same loop position.
 *
 * This is a WORKFLOW file: its static import graph is bundled into the
 * workflow sandbox, which has no Node modules (docs/errors/
 * node-js-module-in-workflow). Everything impure therefore lives in
 * reflection-steps.ts behind "use step" — this module imports only
 * `workflow`, the pure contract, and those step functions.
 *
 * Lives under src/app so the withWorkflow loader picks up the directives.
 */
import { createHook, sleep } from "workflow";
import {
  REFLECTION_TOKEN,
  furthestWakePointer,
  type ReflectionWakePayload,
  type ReflectionRunOutcome,
} from "./reflection-contract";
import {
  handoffBriefToPrimary,
  handleReflectionRound,
  markHQRunStarted,
  markReflectionRunRetired,
  settleReflectionRound,
  startReflectionSuccessor,
} from "./reflection-steps";

export { REFLECTION_TOKEN, furthestWakePointer } from "./reflection-contract";
export type {
  ReflectionWakePayload,
  ReflectionRunOutcome,
} from "./reflection-contract";

/**
 * Retirement clocks (修订 B — whichever fires FIRST, at a lap boundary only):
 *  - IDLE: 24h without a bell or a round. An implementation parameter, not a
 *    semantic judgment (the HQ_IDLE_GRACE_MS precedent) — an idle generation
 *    still pins its deployment and drags its event log, so it retires and
 *    relays. Configurable constant.
 *  - AGE: 7d since this generation's birth — the platform's run retention
 *    window ("Expiry in 7d") is the hard outer bound on how long a run's
 *    state stays inspectable/replayable, and the two standing reasons ride
 *    it: deployment pinning (versioning.mdx:14/37 — a suspended run resumes
 *    on its ORIGINAL deployment forever) and event-log length (the log
 *    grows per step/hook event; replay cost grows with it).
 */
const REFLECTION_IDLE_CAP_MS = 24 * 60 * 60 * 1000;
const REFLECTION_AGE_CAP_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Mailbox drain (§3.2): the hook has no queue length to inspect ("the queue
 * is empty" is undecidable), so the drain races each next() against a short
 * sleep until the sleep wins. NOT a merge window — it waits for nothing and
 * folds no semantics; it just zeroes the doorbell count before the lap's one
 * round. Un-drained stragglers cost one mechanical lap each, never content
 * (the cursor is the truth). The cap guards a pathological flood.
 */
const MAILBOX_DRAIN_PROBE_MS = 2_000;
const MAILBOX_DRAIN_CAP = 50;

export async function reflectionRun(
  initial?: ReflectionWakePayload,
): Promise<ReflectionRunOutcome> {
  "use workflow";
  const hook = createHook<ReflectionWakePayload>({ token: REFLECTION_TOKEN });
  // dispose() is idempotent-guarded: the retirement sequence releases the
  // mailbox BEFORE starting the successor (§2.3 ordering), and the finally
  // below covers every other exit — without the guard the second call would
  // fire after the successor may already hold the token.
  let disposed = false;
  const dispose = (): void => {
    if (!disposed) {
      hook.dispose();
      disposed = true;
    }
  };
  try {
    // 认领（裁决 9）：awaiting getConflict() suspends the run and COMMITS the
    // hook registration — from here the field's resumeHook can reach us.
    const conflict = await hook.getConflict();
    if (conflict) {
      if (!initial) {
        // A successor/rival carrying no wake has nothing to hand over — it
        // simply yields to the mailbox holder.
        return { kind: "dedupedTo", runId: conflict.runId };
      }
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
    // until the retirement mark settles it. A deduped rival exits BEFORE
    // this mark — the mailbox holder's run owns the pointer. The step
    // returns the birth clock stamp (the workflow body has no Date — clocks
    // live in steps, the ownRunId/episodeClockMs precedent); the age clock
    // derives from it.
    const birthMs = await markHQRunStarted();
    const retireAtMs = birthMs + REFLECTION_AGE_CAP_MS;
    let clockMs = birthMs;
    let rounds = 0;

    const iterator = hook[Symbol.asyncIterator]();
    // THE one pending next() promise (§3.1 实现纪律): a race-losing next()
    // does NOT die with the race — it stays queued in the iterator protocol
    // and would eat the NEXT arriving bell for a promise nobody observes
    // (the bell would be lost to the loop). So the loop never issues a
    // second next() while one is in flight: a race loser is REUSED on the
    // next lap, and only a resolved bell arm clears the slot. The losing
    // sleep arms are harmless — their timer events land in the log
    // unobserved (≤3 per lap, and the log resets with each generation).
    let pendingNext: Promise<ReflectionWakePayload | "done"> | null = null;
    const nextBell = (): Promise<ReflectionWakePayload | "done"> => {
      if (!pendingNext) {
        pendingNext = iterator
          .next()
          .then((r): ReflectionWakePayload | "done" =>
            r.done ? "done" : r.value,
          );
      }
      return pendingNext;
    };

    const retire = async (): Promise<ReflectionRunOutcome> => {
      // 退休序列（§2.2 — 只在 lap 边界，此刻天然无在跑轮）: settle the
      // pointer → release the mailbox → start the successor on the latest
      // deployment → exit. A bell arriving in the dispose→start window is
      // caught by the delivery path's start-fallback, which then dedupes
      // against the official successor (§2.3) — the handoff is lossless
      // because bells carry no work, only the doorbell semantics.
      await markReflectionRunRetired({ rounds });
      dispose();
      const successorId = await startReflectionSuccessor();
      return {
        kind: "retired",
        rounds,
        ...(successorId ? { successorId } : {}),
      };
    };

    try {
      let inbox: ReflectionWakePayload[] = initial ? [initial] : [];
      for (;;) {
        if (inbox.length === 0) {
          // Block: the bell vs the two retirement clocks (修订 B — whichever
          // first). R2 adds the fourth arm here: sleep(下一议程到期点).
          const woke = await Promise.race<
            ReflectionWakePayload | "done" | "retire"
          >([
            nextBell(),
            sleep(REFLECTION_IDLE_CAP_MS).then((): "retire" => "retire"),
            sleep(Math.max(1, retireAtMs - clockMs)).then(
              (): "retire" => "retire",
            ),
          ]);
          if (woke === "retire" || woke === "done") {
            return await retire();
          }
          pendingNext = null; // the bell arm resolved — consume the slot
          inbox = [woke];
          // 排空（§3.2）：清零门铃计数，封顶防病态。排不净无所谓——遗留铃
          // 只会让后续 lap 空转一次机械检查。
          for (let drained = 0; drained < MAILBOX_DRAIN_CAP; drained += 1) {
            const more = await Promise.race<
              ReflectionWakePayload | "done" | "quiet"
            >([
              nextBell(),
              sleep(MAILBOX_DRAIN_PROBE_MS).then((): "quiet" => "quiet"),
            ]);
            if (more === "quiet" || more === "done") break;
            pendingNext = null;
            inbox.push(more);
          }
        }
        // ONE round per lap off the furthest pointer (N 铃 ≠ N 轮 — R1's
        // minimal world: no gate; R2's loadReflectionWorld plugs in here).
        // A failed round does NOT kill the unit (§3.1 行为变更): the round
        // step never throws, the settle below records the failure honestly,
        // and the loop continues.
        const pointer = furthestWakePointer(inbox);
        inbox = [];
        const round = await handleReflectionRound(pointer);
        rounds += 1;
        clockMs = await settleReflectionRound(round, pointer);
      }
    } finally {
      await iterator.return?.();
    }
  } finally {
    dispose();
  }
}
