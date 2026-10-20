/**
 * The mechanical bell (v0.38 §3.3; v0.42 §4) — the reflection unit's ONLY
 * trigger, a doorbell with ONE hint: the range a summary stream just
 * persisted ({sliceId, turnIds}). The unit's range is everything past its
 * on-disk evidence — the bell tells it WHERE to look first; content is never
 * delivered by the bell.
 *
 * Delivery is a three-way call (observed 2026-10-16: a 38-minute "running"
 * ZOMBIE held the token across restarts, and the old two-way bell read every
 * ring as delivered — the unit starved behind a holder nobody could
 * challenge, because the takeover claim in reflection-run.ts needs a
 * challenger run, and only a bell can start one):
 *
 *   getHookByToken REJECTS → no live unit → `start` a fresh short-lived one
 *     (`started`; a lost bell is made up by the next writer's bell — the
 *     work sits on disk past the cursor).
 *   RESOLVES, holder age ≤ REFLECTION_TAKEOVER_MS → the unit IS UP and the
 *     ring is DONE (触发即完成 — the loop re-checks the world every lap, so
 *     a ring at any point is absorbed; NEVER resumeHook, the mailbox no
 *     longer exists as a queue).
 *   RESOLVES, holder OUTLIVED the threshold → the bell challenges the
 *     zombie itself: cancel the stale holder (best-effort — a failed cancel
 *     only warns, the start still happens), `start` a fresh unit
 *     (`tookOver`). Age unknown (registry unreadable / run not listed) →
 *     conservatively `rung` — never a blind cancel.
 *
 * A failure rides the result, never an exception.
 *
 * Plain Node module, no "use step": the chat tail (steps.ts ringReflection)
 * and the writer wrap it. Importing reflectionRun statically is safe from
 * here: reflection-run → reflection-steps never reaches back (the steps'
 * impure edges are all DYNAMIC imports, precisely so this graph stays
 * acyclic).
 */
import { getHookByToken, getRun, start } from "workflow/api";
import { getWorld } from "workflow/runtime";
import { REFLECTION_TOKEN, reflectionRun } from "@/app/api/evolution/reflection-run";
import { REFLECTION_TAKEOVER_MS } from "@/app/api/evolution/reflection-contract";
import type { ReflectionWakeRange } from "@/app/api/evolution/reflection-contract";

export type { ReflectionWakeRange };

export type ReflectionWakeResult =
  | { ok: true; delivered: "rung" | "started" | "tookOver"; runId: string }
  | { ok: false; reason: string };

/**
 * Start a fresh short-lived reflection unit (a dead/absent token is free).
 * `range` is the summary stream's hint (v0.42 §4) — absent on a zombie
 * takeover's fresh run, which then derives its scope from the commit log
 * (§3.5).
 */
async function startReflectionRun(
  range?: ReflectionWakeRange,
): Promise<ReflectionWakeResult> {
  try {
    // Same start config as the question sub-flow — background runs live in
    // one region, not two. The range rides the args (the run's input), not
    // the attributes (observability may read it from the run record either
    // way — the args are what the body consumes).
    const run = await start(reflectionRun, [range ?? null], { region: "hkg1" });
    return { ok: true, delivered: "started", runId: run.runId };
  } catch (e) {
    return {
      ok: false,
      reason: `the reflection unit could not be reached: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/**
 * The token holder's age in ms — the zombie verdict's input. Primary read:
 * the Run handle's own `createdAt`; fallback: the world's bounded run list
 * (the same call hq-status/route.ts uses). null is the CONSERVATIVE
 * direction (unreadable registry, run not in the list): an unknown-age
 * holder is treated as alive, never cancelled blind.
 */
async function readHolderAgeMs(runId: string): Promise<number | null> {
  try {
    const createdAt = await getRun(runId).createdAt;
    if (createdAt instanceof Date && !Number.isNaN(createdAt.getTime())) {
      return Math.max(0, Date.now() - createdAt.getTime());
    }
  } catch {
    // fall through to the world-list leg
  }
  try {
    const world = await getWorld();
    const page = await world.runs.list({
      pagination: { limit: 100 },
      resolveData: "none",
    } as Parameters<typeof world.runs.list>[0]);
    const holder = page.data.find((r) => r.runId === runId);
    if (!holder) return null;
    const created = (holder as { createdAt?: unknown }).createdAt;
    const createdMs =
      typeof created === "string"
        ? Date.parse(created)
        : created instanceof Date
          ? created.getTime()
          : NaN;
    return Number.isNaN(createdMs) ? null : Math.max(0, Date.now() - createdMs);
  } catch {
    return null;
  }
}

/**
 * Deliver the bell. `getHookByToken` rejects → no live unit → start one. It
 * resolves → the unit is alive and, unless it has outlived
 * REFLECTION_TAKEOVER_MS, the ring is complete (NO resumeHook — a live
 * short-lived loop wakes only from its own world re-checks… and from
 * nothing else, which is exactly why a ring means "keep looping": the loop
 * never blocks between laps, so any bell landing while it lives is
 * redundant by construction). A holder that has outlived the threshold
 * while STILL holding the token is a zombie — the ring that finds it IS
 * the challenger (cancel → start, `tookOver`). `range` (v0.42 §4) is the
 * summary stream's hint of what it just persisted (the slice + the turn
 * ids) — a hint, not the only truth (a rangeless unit re-reads the commit
 * log itself, §3.5). Never throws.
 */
export async function deliverReflectionWake(
  range?: ReflectionWakeRange,
): Promise<ReflectionWakeResult> {
  let hook: Awaited<ReturnType<typeof getHookByToken>>;
  try {
    hook = await getHookByToken(REFLECTION_TOKEN);
  } catch {
    return startReflectionRun(range);
  }
  const runId = (hook as { runId?: string } | null)?.runId ?? "";
  // A resolved hook IS a live holder by construction (the platform disposes
  // the token at run terminal state) — age is the only remaining question.
  const ageMs = runId ? await readHolderAgeMs(runId) : null;
  if (ageMs === null || ageMs <= REFLECTION_TAKEOVER_MS) {
    // The healthy holder was started WITH its own range when it claimed the
    // token — this redundant ring carries nothing new (触发即完成).
    return { ok: true, delivered: "rung", runId };
  }
  // Zombie takeover: the bell cancels the stale holder (best-effort — a
  // failed cancel only warns, the fresh start still happens) and starts a
  // new unit WITHOUT the range (it was the dead holder's hint; the fresh
  // unit derives the scope from the commit log — §3.5).
  try {
    await getRun(runId).cancel();
  } catch (err) {
    console.warn(
      `[reflection] takeover cancel of ${runId} failed (starting anyway):`,
      err instanceof Error ? err.message : err,
    );
  }
  const started = await startReflectionRun();
  if (started.ok) {
    console.log(
      `[reflection] took over a stale unit (age ${Math.round(ageMs / 60000)}m) — cancelled ${runId} and started a new one`,
    );
    return { ok: true, delivered: "tookOver", runId: started.runId };
  }
  return started;
}
