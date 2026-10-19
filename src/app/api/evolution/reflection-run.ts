/**
 * Reflection run — the reflection unit's SHORT-LIVED shell (v0.38 §5; the
 * v0.34 resident shell RETIRED: no mailbox drain, no idle clock, no agenda
 * clock, no handoff chain).
 *
 * One wake starts one unit, and the unit lives ONLY as long as the world has
 * work:
 *
 *   claim token (createHook + getConflict)
 *     conflict → holder liveness (readRunClaim):
 *       终态/死 → the platform disposes the token at run terminal state —
 *                 treat as unowned and re-claim (bounded — a propagation
 *                 window may briefly re-report the dead holder);
 *       活 且 age ≤ REFLECTION_TAKEOVER_MS → 撞车即退 (dedupedTo — 不等不杀
 *                 不转交, bells carry no work so nothing is lost);
 *       活 且 age > 阈值 → zombie 接管: cancel the holder, 留痕 (log +
 *                 tookOver attribute), re-claim in a bounded loop (Supersede
 *                 paradigm — the retry covers the cleanup-propagation window).
 *   stamp the claim (startedAt — the age base for the NEXT challenger).
 *   loop:
 *     docket ← loadReflectionWorld()      // 全读、永不抛 (v0.34 R2 形状)
 *     无活 → settle 指针 (idle) → dispose token → return   // 无活即退, no clock
 *     有活 → round ← handleReflectionRound(docket)         // HQ never throws
 *          → settleReflectionRound(round, docket)          // 失败轮游标不动
 *          → 立即再 loop（积压由循环本身消化 — 工作驱动, not a timer）
 *
 * 活性由事件链供给（消息 → turn → writer → 铃), the agenda degrades to
 * 机会式补查 (each lap's docket carries due items), and a lost bell is made
 * up by the next writer's bell — the work sits on disk past the on-disk
 * cursor (hq.json lastSeen), which is the only continuity a generation needs.
 *
 * This is a WORKFLOW file: its static import graph is bundled into the
 * workflow sandbox, which has no Node modules (docs/errors/
 * node-js-module-in-workflow). Everything impure lives in reflection-steps.ts
 * behind "use step" — this module imports only `workflow`, the pure contract,
 * the pure lap-plan module (sandbox-safe — judgment only), and those step
 * functions.
 *
 * Lives under src/app so the withWorkflow loader picks up the directives.
 */
import { createHook } from "workflow";
import {
  REFLECTION_TOKEN,
  REFLECTION_TAKEOVER_MAX_ATTEMPTS,
  REFLECTION_TAKEOVER_MS,
  type ReflectionRunOutcome,
} from "./reflection-contract";
import { lapHasWork } from "./reflection-plan";
import {
  cancelReflectionHolder,
  handleReflectionRound,
  loadReflectionWorld,
  markHQRunStarted,
  markReflectionRunIdleExit,
  readRunClaim,
  settleReflectionRound,
  stampReflectionClaim,
  stampReflectionTakeover,
} from "./reflection-steps";

export {
  REFLECTION_TOKEN,
  furthestWakePointer,
} from "./reflection-contract";
export type {
  ReflectionRunOutcome,
  ReflectionWakePayload,
} from "./reflection-contract";

export async function reflectionRun(): Promise<ReflectionRunOutcome> {
  "use workflow";
  // The hook is now ONLY a mutex + liveness marker (§5): the run never
  // iterates it — no mailbox, no drain. dispose() is idempotent-guarded and
  // covers every exit path; the platform also disposes the token when the
  // run reaches a terminal state.
  const hook = createHook({ token: REFLECTION_TOKEN });
  let disposed = false;
  const dispose = (): void => {
    if (!disposed) {
      hook.dispose();
      disposed = true;
    }
  };
  try {
    // ── Claim (§5): conflict → holder liveness decides — yield to a healthy
    //    holder, treat a dead one as unowned, take over a zombie. Bounded:
    //    the loop can only spin on the propagation window, never forever.
    for (let takeoverAttempts = 0; ; takeoverAttempts += 1) {
      const conflict = await hook.getConflict();
      if (!conflict) break; // claimed
      const holder = await readRunClaim(conflict.runId);
      const holderAlive =
        holder !== null &&
        holder.status !== "completed" &&
        holder.status !== "failed" &&
        holder.status !== "cancelled";
      if (!holderAlive) {
        // 终态/死: the token is (being) freed — re-claim. A persistent dead
        // holder report exhausts the loop below; the next bell retries.
        if (takeoverAttempts >= REFLECTION_TAKEOVER_MAX_ATTEMPTS) {
          console.warn(
            `[Reflection] claim held by a terminal holder ${conflict.runId} — exiting; the next bell retries`,
          );
          return { kind: "dedupedTo", runId: conflict.runId };
        }
        continue;
      }
      if (
        holder.ageMs !== null &&
        holder.ageMs <= REFLECTION_TAKEOVER_MS
      ) {
        // 撞车即退 — a healthy holder owns the round; bells carry no work.
        return { kind: "dedupedTo", runId: conflict.runId };
      }
      // Zombie 接管: alive past the threshold — cancel, 留痕, re-claim.
      if (takeoverAttempts >= REFLECTION_TAKEOVER_MAX_ATTEMPTS) {
        console.warn(
          `[Reflection] takeover of ${conflict.runId} could not complete — exiting; the next bell retries`,
        );
        return { kind: "dedupedTo", runId: conflict.runId };
      }
      if (!(await cancelReflectionHolder(conflict.runId))) {
        return { kind: "dedupedTo", runId: conflict.runId };
      }
      await stampReflectionTakeover(conflict.runId);
      // loop: getConflict again (the Supersede re-claim)
    }

    // The age base for the next challenger + the pointer's "running" mark.
    await stampReflectionClaim();
    await markHQRunStarted();

    // ── The work loop (§5): no clocks — the loop IS the event chain. Each
    //    lap re-reads the world; a lap with work runs ONE round and settles
    //    it immediately (失败轮不推游标 — §4.2); an empty docket retires the
    //    unit on the spot.
    let rounds = 0;
    for (;;) {
      const docket = await loadReflectionWorld();
      if (!lapHasWork(docket)) {
        await markReflectionRunIdleExit({ rounds });
        dispose();
        return { kind: "retired", rounds };
      }
      const round = await handleReflectionRound(docket);
      rounds += 1;
      await settleReflectionRound(round, docket);
      // 立即再 loop — the backlog drains lap by lap, work-driven (§7).
    }
  } finally {
    dispose();
  }
}
