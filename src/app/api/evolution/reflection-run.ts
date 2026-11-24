/** Claim the reflection hook and work through available evidence, one settled round at a time. */
import { createHook } from "workflow";
import {
  REFLECTION_TOKEN,
  REFLECTION_TAKEOVER_MAX_ATTEMPTS,
  type ReflectionRunOutcome,
  type ReflectionWakeRange,
} from "./reflection-contract";
import { lapHasWork } from "./reflection-plan";
import type { HistoryScanState } from "@/lib/chat/hq-history";
import {
  closeReflectionStream,
  handleReflectionRound,
  loadReflectionWorld,
  maintainReflectionHypothesisTtl,
  markHQRunStarted,
  markReflectionRunIdleExit,
  readRunClaim,
  settleReflectionRound,
  stampReflectionClaim,
} from "./reflection-steps";

export {
  REFLECTION_TOKEN,
  furthestWakePointer,
} from "./reflection-contract";
export type {
  ReflectionRunOutcome,
  ReflectionWakePayload,
} from "./reflection-contract";

export async function reflectionRun(
  range?: ReflectionWakeRange | null,
): Promise<ReflectionRunOutcome> {
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
      // Missing registry data is not evidence that the owner is dead.
      if (holder === null) return { kind: "dedupedTo", runId: conflict.runId };
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
      // A running holder owns its in-flight work regardless of elapsed time.
      return { kind: "dedupedTo", runId: conflict.runId };
    }

    // The age base for the next challenger + the pointer's "running" mark.
    await stampReflectionClaim();
    await markHQRunStarted();

    // On each lap the persisted cursor determines the remaining work.
    let rounds = 0;
    let lastWork: string | undefined;
    let openingRange = range ?? undefined;
    let historyScan: HistoryScanState | undefined;
    for (;;) {
      const docket = await loadReflectionWorld(undefined, openingRange, historyScan);
      if (docket.historyScan) {
        historyScan = docket.historyScan;
        continue; // another durable read step; incomplete history never calls HQ
      }
      historyScan = undefined;
      openingRange = undefined;
      const work = JSON.stringify([docket.cursor, docket.scope, docket.agendaDue, docket.skillReviewDue, docket.evolutionReasons]);
      if (!lapHasWork(docket) || work === lastWork) {
        await maintainReflectionHypothesisTtl();
        await markReflectionRunIdleExit({ rounds });
        dispose();
        return { kind: "retired", rounds };
      }
      lastWork = work;
      const round = await handleReflectionRound(docket);
      rounds += 1;
      await settleReflectionRound(round, docket, rounds);
      // A failed, superseded or deferred round has no reliable next cursor.
      // Leave it for the next wake rather than spinning on the same inputs.
      if (round.error || round.disposition === "superseded" || (round.deferredCards ?? 0) > 0) {
        await maintainReflectionHypothesisTtl(docket.scope.at(-1)?.sliceId);
        await markReflectionRunIdleExit({ rounds });
        dispose();
        return { kind: "retired", rounds };
      }
    }
  } finally {
    dispose();
    await closeReflectionStream();
  }
}
