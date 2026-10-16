/**
 * Reflection run — the reflection unit's shell (v0.21 §4 P2; v0.30 §2
 * 机械铃; v0.34 常驻形态 R1 + R2 的 world/gate).
 *
 * There is ONE agent with two execution units: the field (the conversation
 * workflow, user-facing) and the reflection unit (archives/evolution, no
 * mouth). v0.34 makes the unit RESIDENT for ONE VISIT (用户裁决：不追求一
 * 条永远存在的线): one durable run that spends almost all of its life
 * suspended on its mailbox or its clocks (zero compute while waiting —
 * sleep.mdx:12, child-workflows.mdx:149-153), and exits when the visit is
 * over — an hour without a bell or a round. Nobody briefs it: the field
 * rings the bell ONLY when a slice is sealed on disk (v0.34 R1 — the
 * per-turn tail bell retired), and the bell is a doorbell, not a work
 * order: N bells ≠ N rounds. What a lap DOES is decided by the world read,
 * not by the queue (§3.1): the loop is 取世界 → lapHasWork 判 → 有活才跑
 * 一轮 → 立即再查（积压由循环本身消化）→ 无活才阻塞。R2's
 * `loadReflectionWorld` (cursor-based scope + the two beats + the agenda)
 * is the world; the drained mailbox contributes only the lap's user-clock
 * date. A round's settlement is immediate (per-round, the D2 batching
 * retired), and a failed round does NOT kill the unit.
 *
 * Lifecycle (寿命 = 一次访问 + 60 分钟空闲宽限):
 *   createHook({ token: REFLECTION_TOKEN }) → await hook.getConflict()
 *     conflict → hand the wake to the primary run, then exit { dedupedTo };
 *       the wake is never dropped (§11 ③).
 *     no conflict → claim the token, then loop the laps above. The exit
 *       comes ONLY at a lap boundary (never mid-round) when the idle grace
 *       wins the blocking race: settle the pointer { idle } → dispose the
 *       mailbox → return. NO successor is started — the generation simply
 *       ends with the visit.
 *   The next visit's first bell revives the unit through the delivery
 *   path's existing fallback (no live hook → start, reflection-wake.ts):
 *   the cursor lives on disk (hq.json lastSeen), so the fresh generation
 *   continues seamlessly from where the last one stopped reading. Death
 *   (cancel/crash/platform) runs no sequence either — same fallback, and
 *   the status route's self-heal settles the stale "running" pointer.
 *
 * This is a WORKFLOW file: its static import graph is bundled into the
 * workflow sandbox, which has no Node modules (docs/errors/
 * node-js-module-in-workflow). Everything impure therefore lives in
 * reflection-steps.ts behind "use step" — this module imports only
 * `workflow`, the pure contract, the pure lap-plan module (sandbox-safe —
 * judgment only), and those step functions.
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
import { lapHasWork } from "./reflection-plan";
import {
  handoffBriefToPrimary,
  handleReflectionRound,
  loadReflectionWorld,
  markHQRunStarted,
  markReflectionRunIdleExit,
  settleReflectionRound,
} from "./reflection-steps";

export { REFLECTION_TOKEN, furthestWakePointer } from "./reflection-contract";
export type {
  ReflectionWakePayload,
  ReflectionRunOutcome,
} from "./reflection-contract";

/**
 * The visit's lifetime grace (一次访问的寿命宽限): the unit exits when no
 * bell and no round has happened for this long, at a lap boundary only.
 * An implementation parameter, not a semantic judgment (the
 * HQ_IDLE_GRACE_MS precedent). 用户裁决：单元不永生——它只需在用户这一
 * 次访问期间在；用户走了（一小时无铃无轮）它自然退场，下次开口时由投
 * 递路径的既有 fallback 叫起新一代（游标在盘上，无缝续上——见文件头
 * Lifecycle）。Configurable constant.
 */
const REFLECTION_IDLE_EXIT_MS = 60 * 60 * 1000;

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
  // dispose() is idempotent-guarded: the idle exit releases the mailbox
  // explicitly (so the very next bell finds no live hook and the delivery
  // fallback starts a fresh generation at once), and the finally below
  // covers every other exit path.
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
        // A rival carrying no wake has nothing to hand over — it
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
    // until the idle-exit mark settles it. A deduped rival exits BEFORE
    // this mark — the mailbox holder's run owns the pointer.
    await markHQRunStarted();
    let rounds = 0;

    const iterator = hook[Symbol.asyncIterator]();
    // THE one pending next() promise (§3.1 实现纪律): a race-losing next()
    // does NOT die with the race — it stays queued in the iterator protocol
    // and would eat the NEXT arriving bell for a promise nobody observes
    // (the bell would be lost to the loop). So the loop never issues a
    // second next() while one is in flight: a race loser is REUSED on the
    // next lap, and only a resolved bell arm clears the slot. The losing
    // sleep arms are harmless — their timer events land in the log
    // unobserved (≤1 per lap from the blocking race; drain probes bounded by
    // the cap — the log resets with each generation).
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

    const exitIdle = async (): Promise<ReflectionRunOutcome> => {
      // 空闲退场（只在 lap 边界，此刻天然无在跑轮）: settle the pointer →
      // release the mailbox → return. NO successor is started — the unit's
      // lifetime is ONE visit, not a relay (用户裁决：不追求永生). A bell
      // arriving any time later finds no live hook, so the delivery path's
      // start-fallback (reflection-wake.ts) spins up a FRESH generation,
      // which continues from the on-disk cursor (hq.json lastSeen) — the
      // handoff is lossless because bells carry no work, only the doorbell
      // semantics, and the truth is on disk. The outcome kind stays
      // "retired" for wire compatibility (reflection-contract.ts).
      await markReflectionRunIdleExit({ rounds });
      dispose();
      return { kind: "retired", rounds };
    };

    try {
      let inbox: ReflectionWakePayload[] = initial ? [initial] : [];
      for (;;) {
        // R2 (§3.1): the lap's work is whatever the WORLD says — the bell
        // is only a wake-up tap. The lap's user-clock date rides the drained
        // mailbox's furthest dated wake (the field's clock, §3.3); a clock
        // lap carries nothing and the step falls back to the UTC date (the
        // agenda is day-granular, §6.2).
        const lapDate = furthestWakePointer(inbox).date;
        inbox = [];
        const docket = await loadReflectionWorld(lapDate);
        if (lapHasWork(docket)) {
          // ONE round per lap off the docket (§5.1). A failed round does
          // NOT kill the unit (§3.1 行为变更): the round step never throws,
          // the settle below records the failure honestly (the cursor holds
          // — §4.2), and the loop continues. The immediate re-check after
          // the settle is the backlog drain: the next docket sees whatever
          // is still past the cursor, lap by lap, until nothing is due.
          const round = await handleReflectionRound(docket);
          rounds += 1;
          await settleReflectionRound(round, docket);
          continue;
        }
        // No work: block — the bell vs the agenda clock vs the visit's
        // idle grace (§3.1 的 R2 三路). The agenda arm exists only when the
        // docket named a future due point; the arms are ordered bell →
        // agenda → idle (production resolves by real ms, so order is
        // semantics-free there).
        const arms: Array<Promise<ReflectionWakePayload | "done" | "agenda" | "exit">> =
          [nextBell()];
        if (docket.agendaWakeMs !== null) {
          arms.push(sleep(docket.agendaWakeMs).then((): "agenda" => "agenda"));
        }
        arms.push(sleep(REFLECTION_IDLE_EXIT_MS).then((): "exit" => "exit"));
        const woke = await Promise.race(arms);
        if (woke === "exit" || woke === "done") {
          return await exitIdle();
        }
        if (woke === "agenda") {
          continue; // clock lap — the loop top re-reads the world
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
    } finally {
      await iterator.return?.();
    }
  } finally {
    dispose();
  }
}
