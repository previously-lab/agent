/**
 * The field↔reflection channel's Node-side steps (v0.21 §4/§5; v0.30 §2
 * 机械铃; v0.34 常驻形态 R1).
 *
 * `reflection-run.ts` (the workflow file) imports this module, and the SDK
 * splits "use step" bodies out of the workflow bundle — so the impure work
 * below stays on the Node side. The `./hq-agent` import is dynamic on
 * purpose: the workflow plugin still traces a *static* edge out of a
 * workflow-reachable module, and the HQ agent statically pulls the episodic
 * / sub-agent / card-evolution machinery, which reaches `fs` / `next` —
 * that is exactly what broke the dev server with node-js-module-in-workflow
 * errors in P2. A static edge would also close a module cycle
 * (tool-executors → reflection-run → reflection-steps → hq-agent →
 * sub-agent-runner → models/provider → … → turn-workflow → tools →
 * tool-executors).
 * (docs/errors/node-js-module-in-workflow)
 *
 * The static imports stay sandbox-safe: `workflow` / `workflow/api`
 * primitives, the PURE frame contract (`@/lib/chat/hq-stream` — no fs,
 * no next), and the PURE lap-plan module (`./reflection-plan` — judgment
 * only; its own imports are `@/lib/episodic/slicer`'s pure close-class
 * table, the pure agenda module, and a type-only import). Each beat of the
 * run emits ONE `data-hq-activity` frame into the run's durable stream
 * (getWritable in a step — the tool-executors pattern), so the companion
 * pod can watch the reflection unit live and re-attach after a reload;
 * the frames are third-person activity, never speech (the unit has no
 * mouth, §9).
 */
import { getWritable, getWorkflowMetadata } from "workflow";
import { getRun } from "workflow/api";
import { getWorld } from "workflow/runtime";
import type { UIMessageChunk } from "ai";
import {
  assembleLapPlan,
  REFLECTION_SCOPE_MAX,
  type LapPlan,
  type SliceHead,
} from "./reflection-plan";
import type { SlicingSignal } from "@/lib/episodic/types";
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
 * round's await, where runSubAgent's own tool-progress writer takes the
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
 * One lap's round summary, returned to the run shell so IT can settle the
 * pointer (settleReflectionRound). Type export only — the step-module rule
 * (step files export step functions + types).
 */
export interface ReflectionRound {
  /** What the unit landed this round (paths / case refs; empty = idle). */
  actions: string[];
  /** Set when the round failed (the unit never throws — a failure rides here). */
  error?: string;
  /**
   * The unit's own one-line account of the round (its hqReport note), when
   * non-empty. The settle step decides whether it is staged as `lastNote`
   * (R1: only a round that WROTE something stages — 空转不留痕).
   */
  note?: string;
  /** 修订 C (§5.4): "superseded" = the round closed out early — the world
   *  moved and voided its premise. The cursor holds like a failed round. */
  disposition?: "completed" | "superseded";
  /** True when an evolution pass truly ran this round (§4.2) — the settle
   *  stamps `lastEvolution` with the docket's date. */
  evolved?: boolean;
}

/**
 * The lap docket (§3.3) — the pure LapPlan plus the agenda clock arm for
 * the blocking race (§3.1). `agendaWakeMs` is the ms from NOW until the
 * earliest FUTURE agenda due date (null = none due later), computed HERE:
 * the workflow body has no clock of its own.
 */
export interface ReflectionDocket extends LapPlan {
  /** The blocking race's agenda arm; null arms nothing. */
  agendaWakeMs: number | null;
}

/**
 * Read the CLAIM conflict's holder's liveness (v0.38 §5 — "use step"; the
 * workflow body has no registry access). Returns the holder's registry
 * status and its age (from the `startedAt` attribute the holder stamped at
 * claim time), or null when the holder is unreadable (treated as unowned —
 * the challenger re-claims; a lost holder read never kills the challenger).
 */
export async function readRunClaim(runId: string): Promise<{
  status: string;
  ageMs: number | null;
} | null> {
  "use step";
  try {
    const world = await getWorld();
    const page = await world.runs.list({
      pagination: { limit: 100 },
      resolveData: "none",
    } as Parameters<typeof world.runs.list>[0]);
    const holder = page.data.find((r) => r.runId === runId);
    if (!holder) return null;
    const startedAt = (holder as { attributes?: Record<string, string> | null })
      .attributes?.startedAt;
    const startedMs = startedAt ? Date.parse(startedAt) : NaN;
    return {
      status: holder.status,
      ageMs:
        Number.isNaN(startedMs) || startedMs <= 0
          ? null
          : Math.max(0, Date.now() - startedMs),
    };
  } catch {
    return null;
  }
}

/**
 * Cancel a zombie holder (v0.38 §5 接管 — the same action as the
 * observability UI's Cancel button: `run_cancelled`, hooks disposed, token
 * freed by the platform). The challenger then RE-CLAIMS in a bounded retry
 * loop (the Supersede paradigm's cleanup-propagation window). Never throws:
 * a failed cancel is treated as "holder unmanageable" and the challenger
 * exits — the next bell retries.
 */
export async function cancelReflectionHolder(runId: string): Promise<boolean> {
  "use step";
  try {
    await getRun(runId).cancel();
    return true;
  } catch (err) {
    console.warn(
      `[Reflection] takeover cancel of ${runId} failed:`,
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}

/**
 * Stamp THIS run's claim (v0.38 §5 — the age base): `startedAt` on the run's
 * own attributes, read back by any challenger through the registry. One
 * line of liveness, best-effort (a missing stamp reads as age null = never
 * taken over — the conservative direction).
 */
export async function stampReflectionClaim(): Promise<void> {
  "use step";
  try {
    const { setAttributes } = await import("workflow");
    await setAttributes({ startedAt: new Date().toISOString() });
  } catch {
    /* best-effort liveness stamp */
  }
}

/**
 * Takeover 留痕 (v0.38 §5 — 不许静默): one server-log line plus the
 * `tookOver` attribute on THIS run naming the cancelled holder. What rides
 * the hq pointer is Part 4's shape decision.
 */
export async function stampReflectionTakeover(holderRunId: string): Promise<void> {
  "use step";
  console.warn(`[Reflection] zombie takeover — cancelling stuck holder ${holderRunId}`);
  try {
    const { setAttributes } = await import("workflow");
    await setAttributes({ tookOver: holderRunId });
  } catch {
    /* the log line above is the minimum留痕 */
  }
}

/**
 * Read the world for ONE lap ("use step", §3.3) — every read, no writes —
 * and return the lap's docket. The reads:
 *
 *   - the pointer (hq.json, fresh): `lastSeen.sliceId` is the cursor, the
 *     scope's exclusive lower bound; `lastEvolution.date` feeds the daily
 *     beat (§3.4-2);
 *   - the slice enumeration (`enumerateSliceIds` — the server-side live
 *     enumeration the timeline readers already use): slices with
 *     `id > cursor`, ascending, of which at most REFLECTION_SCOPE_MAX heads
 *     are point-read for `closed_by` (门上界 ≤5, bounded) — a sealed slice
 *     (`closed_by` present) makes the scope, an active one does not;
 *   - the agenda (`memory/self/agenda.md`): parsed and due-judged by the
 *     pure module.
 *
 * All judgment is `assembleLapPlan`'s (谓词纯、step 薄). The lap's
 * user-clock `date` rides the caller (the drained mailbox's furthest dated
 * wake, §3.3); absent (a clock lap) the UTC date is the fallback — the
 * agenda is day-granular and a day of drift is the design's own tolerance
 * (§6.2). Everything is BEST-EFFORT: each read leg degrades independently,
 * and any failure bottoms out as an EMPTY docket — a lap with no work that
 * blocks without touching the model, the pointer, or the stream (§3.1).
 * This step NEVER throws.
 */
export async function loadReflectionWorld(date?: string): Promise<ReflectionDocket> {
  "use step";
  const now = new Date();
  const nowIso = now.toISOString();
  const lapDate = date ?? nowIso.slice(0, 10);
  const emptyDocket = (): ReflectionDocket => ({
    nowIso,
    date: lapDate,
    cursor: null,
    scope: [],
    evolutionDue: false,
    evolutionReasons: [],
    agendaDue: [],
    agendaWakeMs: null,
  });
  try {
    const [{ readHQStatus }, { enumerateSliceIds }, { sliceEntryFromDisk }, { fsReadFile }, { AGENDA_PATH, parseAgenda }] =
      await Promise.all([
        import("./hq-status-store"),
        import("@/lib/episodic/timeline/enumerate"),
        import("@/lib/episodic/timeline/store"),
        import("@/lib/episodic/io-helpers"),
        import("@/lib/evolution/agenda"),
      ]);

    // The cursor + the last evolution stamp — a corrupt pointer reads as
    // "fresh deployment" (cursor null = everything qualifies, §3.3).
    let cursor: string | null = null;
    let lastEvolutionDate: string | null = null;
    try {
      const status = await readHQStatus();
      cursor = status.lastSeen?.sliceId ?? null;
      lastEvolutionDate = status.lastEvolution?.date ?? null;
    } catch {
      /* pointer unreadable — fresh-deployment semantics, never a throw */
    }

    // Scope: the first REFLECTION_SCOPE_MAX slice ids past the cursor, each
    // head point-read once for closed_by (the door cap, §3.3).
    let heads: SliceHead[] = [];
    try {
      const rels = (await enumerateSliceIds()).sort();
      const candidates = rels
        .map((rel) => ({ rel, id: rel.replaceAll("/", "-") }))
        .filter((c) => cursor === null || c.id > cursor)
        .slice(0, REFLECTION_SCOPE_MAX);
      for (const c of candidates) {
        const entry = await sliceEntryFromDisk(c.rel).catch(() => null);
        if (!entry) continue;
        heads.push({
          sliceId: c.id,
          ...(entry.closed_by
            ? { closedBy: entry.closed_by as SlicingSignal }
            : {}),
        });
      }
    } catch {
      heads = [];
    }

    // The agenda — absent file is the empty pad, not an error.
    let agendaContent: string | null = null;
    try {
      agendaContent = await fsReadFile(AGENDA_PATH);
    } catch {
      agendaContent = null;
    }

    const plan = assembleLapPlan({
      nowIso,
      date: lapDate,
      cursor,
      slices: heads,
      lastEvolutionDate,
      agendaContent,
    });

    // The agenda clock arm (§3.1/§6.2): the earliest FUTURE due date, in ms
    // from now. Day granularity — the design accepts a day of drift.
    let agendaWakeMs: number | null = null;
    try {
      const future = parseAgenda(agendaContent)
        .map((i) => i.due)
        .filter((due) => due > lapDate)
        .sort();
      if (future[0]) {
        agendaWakeMs = Math.max(
          1,
          new Date(`${future[0]}T00:00:00Z`).getTime() - now.getTime(),
        );
      }
    } catch {
      agendaWakeMs = null;
    }

    return { ...plan, agendaWakeMs };
  } catch (e) {
    // A world-read failure is an empty-docket lap (空转), never a dead run.
    console.warn(
      "[reflection] world read failed — an empty-docket lap:",
      e instanceof Error ? e.message : e,
    );
    return emptyDocket();
  }
}

/**
 * Handle ONE lap's round ("use step"): hand the lap's DOCKET to the
 * reflection unit (hq-agent.ts) — this round's material (the sealed slices
 * newer than the cursor), what the mechanical gate noticed (the two beats),
 * and the agenda items due by this round's date. The unit re-reads the raw
 * records itself before touching anything (§5 独立审查 — a docket is a
 * plan, not a fact), and failure never throws out of here: handleBrief
 * returns { error } and logs it, and a failed round simply lands nothing
 * (§5 — the unit's products are writes).
 *
 * The round latch (§4.1) closes at the round's first beat — the pod's
 * breathing source; the settle step clears it. The cursor settlement is
 * NOT here — it is the shell's next step (settleReflectionRound), which
 * owns every pointer write (v0.34 R1: per-round immediate settlement).
 */
export async function handleReflectionRound(docket: ReflectionDocket): Promise<ReflectionRound> {
  "use step";
  // The round latch (§4.1) — set before the (possibly minutes-long) agent
  // work below so the panel breathes for the WHOLE round.
  try {
    const { recordReflectionRoundBegan } = await import("./hq-status-store");
    await recordReflectionRoundBegan();
  } catch {
    /* the latch is best-effort like every pointer write */
  }
  // 开始核对 — the pod sees the round begin before the agent work below;
  // the reading frame carries this round's scope (§4.3-4).
  await emitHQActivity({
    kind: "reading",
    at: new Date().toISOString(),
    slices: docket.scope.map((s) => s.sliceId),
    ...(docket.scope.length === 1 ? { sliceId: docket.scope[0].sliceId } : {}),
  });
  const { handleBrief } = await import("./hq-agent");
  const outcome = await handleBrief(docket);
  // The round's beat: landed writes ("wrote research/X"), a deliberate
  // no-write ("idle — nothing to write" — a veto that produced no write is
  // mechanically an empty round, its short reason riding the note), or the
  // failure line. The unit's own one-paragraph account (outcome.note) rides
  // the wrote/idle frames so the panel can show WHY, not only WHAT; a
  // superseded round's note opens with "superseded: …" by the unit's own
  // discipline (§5.4 — the frame vocabulary does not change).
  if (outcome.error) {
    await emitHQActivity({
      kind: "failed",
      at: new Date().toISOString(),
      error: outcome.error,
      // A failed round may still have LANDED writes (the flush survives the
      // sub-agent's failure — e.g. an interruption cuts the report, not the
      // writes that preceded it) — carry them so the feed says so.
      ...(outcome.actions.length > 0 ? { paths: outcome.actions } : {}),
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
    ...(outcome.note ? { note: outcome.note } : {}),
    ...(outcome.disposition ? { disposition: outcome.disposition } : {}),
    ...(outcome.evolved ? { evolved: true } : {}),
  };
}

/**
 * Per-round settlement ("use step") — v0.34 R1: the pointer settles EVERY
 * round, immediately. The store owns the rules (§4.2); this step only
 * derives the cursor target from the DOCKET: the round's scope's furthest
 * sealed slice (§4.2 — the cursor advances to what the round actually
 * answered for; a scope-less agenda round carries no `seen` at all). The
 * round's verdict (failure / disposition / evolution flag) rides the round
 * result; whether any of that moves the cursor is the store's call.
 *
 * `docket` is the lap's world-read the round ran off — the settle pairs
 * the round with the world it answered for.
 */
export async function settleReflectionRound(
  round: ReflectionRound,
  docket: ReflectionDocket,
): Promise<void> {
  "use step";
  const { recordReflectionRoundSettled } = await import("./hq-status-store");
  const furthestScopeSlice =
    docket.scope.length > 0
      ? docket.scope[docket.scope.length - 1].sliceId
      : undefined;
  await recordReflectionRoundSettled({
    actions: round.actions,
    ...(round.error ? { error: round.error } : {}),
    ...(round.note ? { note: round.note } : {}),
    ...(furthestScopeSlice ? { seen: { sliceId: furthestScopeSlice } } : {}),
    ...(round.disposition ? { disposition: round.disposition } : {}),
    ...(round.evolved ? { evolved: true } : {}),
    date: docket.date,
  });
}

/**
 * Run-start mark ("use step"): a reflection run claimed the mailbox — the
 * pointer's runStatus goes "running" (the in-visit常态) until the idle-exit
 * mark settles it, and the generation's round count resets. The run's OWN
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
 * Idle-exit mark ("use step"): the visit's terminal beat — the mailbox has
 * been quiet for the whole visit grace (60 minutes) at a lap boundary,
 * never mid-round. The pointer settles `runStatus: "idle"` and the
 * "finished" frame closes the activity feed with the same verdict — pointer
 * first, frame second, so a lost frame never costs the settlement. NO
 * successor follows (用户裁决：寿命 = 一次访问): the pointer honestly reads
 * "idle" until the next visit's first bell starts a fresh generation via
 * the delivery fallback and its started mark overwrites — the on-disk
 * cursor (lastSeen) carries the continuity, so the seam is invisible.
 */
export async function markReflectionRunIdleExit(result: {
  /** Rounds this generation settled (the definitive count). */
  rounds: number;
}): Promise<void> {
  "use step";
  const { recordReflectionRunIdleExit } = await import("./hq-status-store");
  await recordReflectionRunIdleExit(result);
  await emitHQActivity({
    kind: "finished",
    at: new Date().toISOString(),
    status: "idle",
    handled: Math.max(0, Math.floor(result.rounds)),
  });
}

