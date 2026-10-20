/**
 * Reflection contract — what the wake channel's two sides share
 * (v0.30 §2; v0.34 常驻形态 R1; v0.38 §5 — the short-lived unit).
 *
 * Pure by construction: one token constant, the takeover threshold, the
 * outcome type, and the retired-payload type. `reflection-run.ts` is a
 * WORKFLOW file, and the Workflow SDK bundles a workflow file's static
 * import graph into the sandbox — which has no Node modules
 * (docs/errors/node-js-module-in-workflow). So this module must stay free of
 * imports; anything impure belongs in `reflection-steps.ts` behind
 * "use step".
 */

/**
 * The one global reflection mutex token (v0.30 §4 裁决 9: globally unique,
 * need not be hard-guaranteed — a re-start simply claims it again). The hook
 * is now ONLY a mutex + liveness marker (v0.38 §5): the run never iterates
 * it — the mailbox, the handoff chain and the drains retired with the
 * resident shell.
 */
export const REFLECTION_TOKEN = "reflection:main";

/**
 * The zombie-takeover threshold (v0.38 §5, 待裁决 6 — 采纳): a reflection
 * run older than this, STILL alive, is treated as stuck and taken over by
 * the challenger (cancel → re-claim → 留痕). 3× a round's sane upper bound
 * (a round measures ~184s in tests, ~300s in production) ≈ 15 minutes. A
 * LIVE slow round below this age is never touched (撞车即退 holds for
 * healthy holders); a terminal/dead holder is never cancelled (the platform
 * disposes the token at run terminal state — treated as unowned instead).
 * Configurable constant.
 */
export const REFLECTION_TAKEOVER_MS = 15 * 60 * 1000;

/**
 * The bounded re-claim attempts after a takeover cancel (the Supersede
 * paradigm's cleanup-propagation window). Beyond this the challenger exits;
 * the next bell retries the whole claim.
 */
export const REFLECTION_TAKEOVER_MAX_ATTEMPTS = 3;

/**
 * RETIRED with the resident shell (v0.38 §5) — the bell is now PURE and
 * carries no payload (reflection-wake.ts); the lap date falls back to the
 * UTC date inside the world read. The type stays exported so existing
 * wire/debug references keep compiling; nothing constructs it anymore.
 *
 * @deprecated v0.38 §3.3 — the doorbell carries no work.
 */
export interface ReflectionWakePayload {
  /** @deprecated */ sliceId?: string;
  /** @deprecated */ date?: string;
}

/**
 * The range a summary stream hands the reflection unit (v0.42 §4 — 触发携带
 * 范围): the slice + the turn ids the summary just persisted. A HINT, not
 * the only truth — a unit woken WITHOUT one (a lost bell, a zombie
 * takeover's fresh run) derives its scope from the commit log itself
 * (§3.5). Pure type — lives here so both reflection-wake.ts and
 * reflection-run.ts can import it without a module cycle.
 */
export interface ReflectionWakeRange {
  sliceId: string;
  turnIds: string[];
}

/**
 * How a reflection run ended (its return value). A claiming run ends by
 * DEDUPING to a healthy holder, or by RETIRING when the world holds no work
 * (v0.38 §5: 无活即退 — no idle clock, the exit IS the world read coming back
 * empty at a lap boundary). Death by cancel/crash/platform produces no
 * outcome at all: the token frees and the next bell's delivery fallback
 * starts a fresh unit off the on-disk cursor.
 */
export type ReflectionRunOutcome =
  | { kind: "dedupedTo"; runId: string }
  | { kind: "retired"; rounds: number };

/**
 * RETIRED with the mailbox (v0.38 §5 — N bells ≠ N rounds was the resident
 * shell's merge-window concern; the short-lived loop decides each lap off
 * the world read, so there is nothing to collapse).
 *
 * @deprecated v0.38 §5 — no mailbox, no drain, no pointer.
 */
export function furthestWakePointer(
  wakes: ReadonlyArray<ReflectionWakePayload>,
): ReflectionWakePayload {
  let furthest: ReflectionWakePayload | undefined;
  let lastDated: ReflectionWakePayload | undefined;
  for (const wake of wakes) {
    if (wake.date) lastDated = wake;
    if (
      wake.sliceId &&
      (!furthest?.sliceId || wake.sliceId > furthest.sliceId)
    ) {
      furthest = wake;
    }
  }
  const date = furthest?.date ?? lastDated?.date;
  return {
    ...(furthest?.sliceId ? { sliceId: furthest.sliceId } : {}),
    ...(date ? { date } : {}),
  };
}
