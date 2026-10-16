/**
 * The reflection lap's MECHANICAL GATE (v0.34 §3.3/§3.4) — the pure judgment
 * core behind `loadReflectionWorld` (the step that reads the world) and the
 * run body's lap loop (the shell that consumes the docket).
 *
 * "谓词纯、step 薄" (the parallel-runs.ts discipline, copied): every export
 * here is a pure function — NO fs, NO next, NO network, NO clock of its own
 * (the wall clock arrives as input). The step owns the reads (slice
 * enumeration, hq.json, agenda.md); this module owns the judgment, so the
 * same code runs inside the workflow sandbox and in unit tests.
 *
 * The rules it encodes:
 *
 *   - scope (§3.3): slices with `id > cursor` AND closed (`closed_by`
 *     present), ascending by id — lexicographic IS chronological for
 *     `YYYY-MM-DD-HHMM` — oldest REFLECTION_SCOPE_MAX (5, the design cap) at
 *     most. A backlog drains lap by lap as the cursor settles (§3.1).
 *   - archive beat (§3.4): a non-empty scope IS the offer — checkpoint and
 *     boundary closes are archived alike, so there is no separate field.
 *   - evolution beat (§3.4): offered when ANY of —
 *       1. a boundary-class close sits in scope (SLICE_CLOSE_CLASS;
 *          checkpoint closes NEVER trigger evolution alone — a 30-minute
 *          autosave must not burn a card pass every half hour);
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

/** §3.3 — the scope cap: oldest 5 sealed slices per lap. */
export const REFLECTION_SCOPE_MAX = 5;

/** §3.4 — the enumerated evolution-beat reasons (boundary / daily / agenda). */
export const EVOLUTION_REASONS = [
  "conversation_boundary",
  "daily_rollover",
  "agenda_due",
] as const;
export type EvolutionReason = (typeof EVOLUTION_REASONS)[number];

/** A slice head as the step reads it: id + close cause (absent = ACTIVE). */
export interface SliceHead {
  sliceId: string;
  closedBy?: SlicingSignal;
}

/** A slice that made the lap's scope: sealed, newer than the cursor. */
export interface ScopedSlice {
  sliceId: string;
  closedBy: SlicingSignal;
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
  retireAt?: string;
}

/** Everything assembleLapPlan needs, pre-read by the caller (the step). */
export interface LapPlanInput {
  nowIso: string;
  date: string;
  cursor: string | null;
  /** Candidate slice heads, any order, active ones included. */
  slices: SliceHead[];
  /** lastEvolution.date — null when the unit has never evolved. */
  lastEvolutionDate: string | null;
  /** Raw memory/self/agenda.md content (null when absent) — parsed here. */
  agendaContent: string | null;
  retireAt?: string;
}

/**
 * §3.3 scope filter: sealed slices newer than the cursor, ascending,
 * oldest `max` (default REFLECTION_SCOPE_MAX). Never mutates the input.
 */
export function filterScope(
  cursor: string | null,
  slices: SliceHead[],
  max: number = REFLECTION_SCOPE_MAX,
): ScopedSlice[] {
  return slices
    .filter(
      (s): s is ScopedSlice =>
        s.closedBy !== undefined && (cursor === null || s.sliceId > cursor),
    )
    .sort((a, b) => (a.sliceId < b.sliceId ? -1 : a.sliceId > b.sliceId ? 1 : 0))
    .slice(0, max);
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
  if (scope.some((s) => SLICE_CLOSE_CLASS[s.closedBy] === "boundary")) {
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
    plan.scope.length > 0 || plan.evolutionDue || plan.agendaDue.length > 0
  );
}

/**
 * Assemble the lap's docket from the step's reads. The only I/O-adjacent
 * input is the agenda's raw content — parsing it here (tolerant, §6.2)
 * keeps every judgment in pure land and the step thin.
 */
export function assembleLapPlan(input: LapPlanInput): LapPlan {
  const scope = filterScope(input.cursor, input.slices);
  const agendaDue = dueAgendaItems(parseAgenda(input.agendaContent), input.date);
  const beat = judgeEvolutionBeat({
    date: input.date,
    scope,
    lastEvolutionDate: input.lastEvolutionDate,
    agendaDue,
  });
  return {
    nowIso: input.nowIso,
    date: input.date,
    cursor: input.cursor,
    scope,
    evolutionDue: beat.due,
    evolutionReasons: beat.reasons,
    agendaDue,
    ...(input.retireAt !== undefined ? { retireAt: input.retireAt } : {}),
  };
}
