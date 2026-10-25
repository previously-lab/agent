/**
 * The reflection lap's MECHANICAL GATE (v0.34 §3.3/§3.4; v0.42 §4 — the unit
 * works TURNS, told by the summary stream's range) — the pure judgment core
 * behind `loadReflectionWorld` (the step that reads the world) and the run
 * body's lap loop (the shell that consumes the docket).
 *
 * "谓词纯、step 薄" (the parallel-runs.ts discipline, copied): every export
 * here is a pure function — NO fs, NO next, NO network, NO clock of its own
 * (the wall clock arrives as input). The step owns the reads (the commit
 * log, the agenda.md); this module owns the judgment, so the same code runs
 * inside the workflow sandbox and in unit tests.
 *
 * The rules it encodes:
 *
 *   - scope (v0.42 §4): TURNS, not sealed slices — the summary stream's
 *     range when the bell carries one (`{sliceId, turnIds}`, taken AS GIVEN
 *     [10535]); otherwise derived from the commit log (§3.5): the turns of
 *     `Summary — {sliceId}` commits past the water level (the newest clean
 *     round's `seen:` trailer), oldest `REFLECTION_SCOPE_MAX` (5) slices at
 *     most, ascending by id. A slice in scope MAY still be open (v0.42 —
 *     slices stay open while turns accumulate), so `closedBy` is optional.
 *   - a rangeless unit + an unreadable log is a STATE, not "no work": the
 *     docket carries `logDegraded` and the step logs it (§3.5-2), never a
 *     silent skip.
 *   - archive beat (§3.4): a non-empty scope IS the offer.
 *   - evolution beat (§3.4): offered when ANY of —
 *       1. a boundary-class close sits in scope (SLICE_CLOSE_CLASS; the
 *          slice may be unsealed under v0.42 — then this reason simply does
 *          not fire; checkpoint closes NEVER trigger evolution alone);
 *       2. `date > lastEvolution.date` with a non-empty scope (daily);
 *       3. the agenda has due items (opportunistic, §6.2).
 *     Reasons come from an ENUMERATED set (EVOLUTION_REASONS), never free
 *     strings.
 *   - the gate only decides OFFER — the unit keeps the veto: an idle round
 *     is legal, and writer-is-reader makes a false positive cheap.
 */
import type { SlicingSignal } from "@/lib/episodic/types";
import { SLICE_CLOSE_CLASS } from "@/lib/episodic/slicer";
import {
  dueAgendaItems,
  parseAgenda,
  type AgendaItem,
} from "@/lib/evolution/agenda";
import {
  listDueSkillReviews,
  type SkillEntry,
  type SkillLedger,
} from "@/lib/evolution/skill-policy";

/** §3.3 — the scope cap: oldest 5 slices per lap. */
export const REFLECTION_SCOPE_MAX = 5;

/** §3.4 — the enumerated evolution-beat reasons (boundary / daily / agenda). */
export const EVOLUTION_REASONS = [
  "conversation_boundary",
  "daily_rollover",
  "agenda_due",
] as const;
export type EvolutionReason = (typeof EVOLUTION_REASONS)[number];

/**
 * The lap's work unit (v0.42 §4): a slice + the turn ids this lap owes it.
 * `closedBy` is OPTIONAL — under v0.42 slices stay open while turns
 * accumulate; the seal (when it happened) is context for the docket and the
 * boundary evolution reason, never a scope gate.
 */
export interface ScopedSlice {
  sliceId: string;
  /** The turn ids the summary stream persisted (the owed record). */
  turnIds: string[];
  /** The slice's close cause, when sealed (absent = still open). */
  closedBy?: SlicingSignal;
}

/**
 * A summary commit as the scope judgment reads it: the slice + the member
 * turn ids its body names (`- user turn X` / `- reply X` lines).
 */
export interface SummaryHead {
  sliceId: string;
  turnIds: string[];
}

/**
 * The lap docket (§3.3's field table). `nowIso`/`date`/`cursor`/`retireAt`
 * are caller-owned (clock + persisted state); everything else is derived
 * here. `retireAt` is a pure passthrough for the blocking race.
 */
export interface LapPlan {
  nowIso: string;
  /** User-clock YYYY-MM-DD — every judgment below is made on this date. */
  date: string;
  /** lastSeen.sliceId — null on a fresh deployment (everything qualifies). */
  cursor: string | null;
  scope: ScopedSlice[];
  evolutionDue: boolean;
  evolutionReasons: EvolutionReason[];
  agendaDue: AgendaItem[];
  skillReviewDue: SkillEntry[];
  skillReviewError?: string;
  retireAt?: string;
}

/** Everything assembleLapPlan needs, pre-read by the caller (the step). */
export interface LapPlanInput {
  nowIso: string;
  date: string;
  cursor: string | null;
  /** The lap's scope, pre-assembled by the step (range or commit log —
   *  v0.42 §4 — the pure module only JUDGES the beats over it). */
  scope: ScopedSlice[];
  /** lastEvolution.date — null when the unit has never evolved. */
  lastEvolutionDate: string | null;
  /** Raw memory/self/agenda.md content (null when absent) — parsed here. */
  agendaContent: string | null;
  skillLedger?: SkillLedger | null;
  skillReviewError?: string;
  retireAt?: string;
}

export function skillReviewOfferId(
  entry: Pick<SkillEntry, "id" | "revision" | "reviewDue">,
): string {
  return `hq:skill-review-offered:${entry.id}:${entry.revision}:${entry.reviewDue}`;
}

/**
 * The turn-level water level (v0.42 §4/§3.5), as the scope judgment consumes
 * it: per slice, which turns are ALREADY processed — "all" (a whole-slice
 * mark, old format) or an explicit id list. `wholeUpTo` carries the
 * old-format slice-level level: unmarked slices at or below it read as
 * whole-covered (mixed-format histories). `null` coverage = the level is
 * UNKNOWN — nothing counts as covered (never "all done").
 */
export interface ScopeCoverage {
  covered: ReadonlyMap<string, "all" | readonly string[]>;
  wholeUpTo: string | null;
}

/**
 * §3.5/§4's scope assembly, ONE path for both trigger shapes: `summaries`
 * carries every candidate turn set — the bell's range AND the summary log's
 * entries — and each is filtered through the coverage (already-processed
 * turns drop out, so a range repeating covered turns eats nothing twice and
 * a lost bell's turns ride the union in). Grouped per slice with turn ids
 * deduped, slices ascending, oldest `max` (default REFLECTION_SCOPE_MAX).
 * Never mutates the input.
 */
export function scopeFromSummaries(
  coverage: ScopeCoverage | null,
  summaries: SummaryHead[],
  max: number = REFLECTION_SCOPE_MAX,
): ScopedSlice[] {
  const owedCount = (sliceId: string, turnIds: string[]): string[] => {
    const cov = coverage?.covered.get(sliceId);
    const effective =
      cov ?? (coverage?.wholeUpTo && sliceId <= coverage.wholeUpTo ? ("all" as const) : undefined);
    if (effective === "all") return [];
    if (effective) return turnIds.filter((t) => !effective.includes(t));
    return turnIds;
  };
  const bySlice = new Map<string, string[]>();
  for (const s of summaries) {
    const owed = owedCount(s.sliceId, s.turnIds);
    if (owed.length === 0) continue;
    const list = bySlice.get(s.sliceId);
    if (list) {
      for (const t of owed) if (!list.includes(t)) list.push(t);
    } else {
      bySlice.set(s.sliceId, [...owed]);
    }
  }
  return [...bySlice.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, max)
    .map(([sliceId, turnIds]) => ({ sliceId, turnIds }));
}

/**
 * §3.4 evolution beat: offer + enumerated reasons, checked in the design's
 * own order (boundary, daily, agenda). Pure — agendaDue arrives pre-judged.
 */
export function judgeEvolutionBeat(input: {
  date: string;
  scope: ScopedSlice[];
  lastEvolutionDate: string | null;
  agendaDue: AgendaItem[];
}): { due: boolean; reasons: EvolutionReason[] } {
  const { date, scope, lastEvolutionDate, agendaDue } = input;
  const reasons: EvolutionReason[] = [];
  // 1. A conversation boundary in scope (checkpoint closes never qualify).
  //    Under v0.42 the slice may still be OPEN — an unsealed slice simply
  //    does not fire this reason (the criterion itself is unchanged).
  if (
    scope.some(
      (s) => s.closedBy !== undefined && SLICE_CLOSE_CLASS[s.closedBy] === "boundary",
    )
  ) {
    reasons.push("conversation_boundary");
  }
  // 2. Daily rollover: the user clock moved past the last evolution AND
  //    there is fresh material. Never-evolved counts as overdue.
  if (
    scope.length > 0 &&
    (lastEvolutionDate === null || date > lastEvolutionDate)
  ) {
    reasons.push("daily_rollover");
  }
  // 3. Opportunistic agenda: any activity re-checks due items (§6.2).
  if (agendaDue.length > 0) {
    reasons.push("agenda_due");
  }
  return { due: reasons.length > 0, reasons };
}

/**
 * The lap loop's "有活" check (§3.1): a non-empty scope (archive beat), an
 * offered evolution beat, or a due agenda — otherwise the lap blocks WITHOUT
 * calling the model, writing the pointer, or emitting a frame.
 */
export function lapHasWork(plan: LapPlan): boolean {
  return (
    plan.scope.length > 0 || plan.evolutionDue || plan.agendaDue.length > 0 ||
    plan.skillReviewDue.length > 0
  );
}

/**
 * Assemble the lap's docket from the step's reads. The only I/O-adjacent
 * input is the agenda's raw content — parsing it here (tolerant, §6.2)
 * keeps every judgment in pure land and the step thin.
 */
export function assembleLapPlan(input: LapPlanInput): LapPlan {
  const agendaDue = dueAgendaItems(parseAgenda(input.agendaContent), input.date);
  const beat = judgeEvolutionBeat({
    date: input.date,
    scope: input.scope,
    lastEvolutionDate: input.lastEvolutionDate,
    agendaDue,
  });
  const offered = new Set(
    (input.skillLedger?.operations ?? []).map((operation) => operation.operationId),
  );
  const skillReviewDue = (input.skillLedger
    ? listDueSkillReviews(input.skillLedger, input.date)
    : []
  ).filter((entry) =>
    input.scope.length > 0 || !offered.has(skillReviewOfferId(entry))
  );
  return {
    nowIso: input.nowIso,
    date: input.date,
    cursor: input.cursor,
    scope: input.scope,
    evolutionDue: beat.due,
    evolutionReasons: beat.reasons,
    agendaDue,
    skillReviewDue,
    ...(input.skillReviewError ? { skillReviewError: input.skillReviewError } : {}),
    ...(input.retireAt !== undefined ? { retireAt: input.retireAt } : {}),
  };
}
