/**
 * Tests for the reflection lap's mechanical gate
 * (src/app/api/evolution/reflection-plan.ts, v0.34 §3.3/§3.4; v0.42 §4 —
 * the scope is TURNS). The contract that matters:
 *   - scope: TURNS, not sealed slices — the summary stream's range when the
 *     bell carries one, else the summary log's turns past the water level
 *     (scopeFromSummaries): `sliceId > cursor` (everything on a fresh
 *     deployment), grouped per slice with turn ids deduped, ascending,
 *     oldest 5 slices (design cap); a slice may still be OPEN — `closedBy`
 *     is context, never a scope gate;
 *   - archive beat: a non-empty scope IS the offer (no separate field);
 *   - evolution beat: boundary-class close in scope / daily rollover with a
 *     non-empty scope / due agenda — checkpoint closes never trigger it
 *     alone, an UNSEALED slice never fires the boundary reason, and reasons
 *     come from the enumerated EVOLUTION_REASONS set;
 *   - agenda parsing is tolerant by inheritance (parseAgenda): garbage
 *     content degrades to an empty agendaDue, never to a thrown lap.
 */
import { describe, it, expect } from "vitest";

import {
  EVOLUTION_REASONS,
  REFLECTION_SCOPE_MAX,
  assembleLapPlan,
  judgeEvolutionBeat,
  lapHasWork,
  scopeFromSummaries,
  type LapPlanInput,
  type ScopeCoverage,
  type ScopedSlice,
  type SummaryHead,
} from "@/app/api/evolution/reflection-plan";

const CURSOR = "2026-10-14-1858";
const DATE = "2026-10-16";

function scoped(
  sliceId: string,
  turnIds: string[],
  closedBy?: ScopedSlice["closedBy"],
): ScopedSlice {
  return closedBy === undefined
    ? { sliceId, turnIds }
    : { sliceId, turnIds, closedBy };
}

function summary(sliceId: string, turnIds: string[]): SummaryHead {
  return { sliceId, turnIds };
}

function plan(overrides: Partial<LapPlanInput> = {}) {
  return assembleLapPlan({
    nowIso: `${DATE}T08:00:00.000Z`,
    date: DATE,
    cursor: CURSOR,
    scope: [],
    lastEvolutionDate: null,
    agendaContent: null,
    ...overrides,
  });
}

describe("scopeFromSummaries — §3.5/§4's scope assembly (range ∪ log, coverage-filtered)", () => {
  const NO_COVERAGE: ScopeCoverage | null = null;
  const NOTHING_COVERED: ScopeCoverage = { covered: new Map(), wholeUpTo: null };
  function coverage(
    entries: Array<[string, "all" | string[]]>,
    wholeUpTo: string | null = null,
  ): ScopeCoverage {
    return { covered: new Map(entries), wholeUpTo };
  }

  it("solo: one candidate past everything makes the scope, turns as given", () => {
    expect(
      scopeFromSummaries(NOTHING_COVERED, [summary("2026-10-15-0930", ["t1", "t2"])]),
    ).toEqual([{ sliceId: "2026-10-15-0930", turnIds: ["t1", "t2"] }]);
  });

  it("two slices come back ascending, oldest first (input order does not matter)", () => {
    expect(
      scopeFromSummaries(NOTHING_COVERED, [
        summary("2026-10-16-0712", ["t3"]),
        summary("2026-10-15-0930", ["t1", "t2"]),
      ]),
    ).toEqual([
      { sliceId: "2026-10-15-0930", turnIds: ["t1", "t2"] },
      { sliceId: "2026-10-16-0712", turnIds: ["t3"] },
    ]);
  });

  it("several candidates of ONE slice merge with their turn ids deduped, in arrival order (the range ∪ log union lands here)", () => {
    expect(
      scopeFromSummaries(NOTHING_COVERED, [
        summary("2026-10-15-0930", ["t3"]), // the range leg
        summary("2026-10-15-0930", ["t1", "t2"]), // the log leg
        summary("2026-10-15-0930", ["t2", "t3"]), // overlap — deduped
      ]),
    ).toEqual([{ sliceId: "2026-10-15-0930", turnIds: ["t3", "t1", "t2"] }]);
  });

  it("a backlog is capped at the OLDEST 5 slices — the rest waits for later laps", () => {
    const ids = ["2026-10-15-0930", "2026-10-15-1200", "2026-10-15-1400", "2026-10-15-1800", "2026-10-15-2100", "2026-10-16-0712", "2026-10-16-0800"];
    const scope = scopeFromSummaries(NOTHING_COVERED, ids.map((id) => summary(id, ["t"])));
    expect(REFLECTION_SCOPE_MAX).toBe(5);
    expect(scope.map((s) => s.sliceId)).toEqual(ids.slice(0, 5));
  });

  it("the water level subtracts: a covered slice drops out; a PARTIALLY covered slice keeps only its unprocessed turns (同片第二轮)", () => {
    const cov = coverage([["2026-10-19-1800", ["t1"]]]);
    const scope = scopeFromSummaries(cov, [
      summary("2026-10-19-1800", ["t1", "t2"]), // t1 covered → only t2 owed
      summary("2026-10-20-0900", ["t3"]), // untouched slice — fully owed
    ]);
    expect(scope).toEqual([
      { sliceId: "2026-10-19-1800", turnIds: ["t2"] },
      { sliceId: "2026-10-20-0900", turnIds: ["t3"] },
    ]);
  });

  it("OLD-format backward compatibility: a bare `seen: <sliceId>` covers the WHOLE slice, and lifts the level for unmarked slices at or below it", () => {
    const cov = coverage([], "2026-10-19-1800"); // old water level
    const scope = scopeFromSummaries(cov, [
      summary("2026-10-18-1200", ["old"]), // below the level, no mark → whole-covered
      summary("2026-10-19-1800", ["tc"]), // the level slice itself → whole-covered
      summary("2026-10-20-0900", ["t3"]), // past the level → owed
    ]);
    expect(scope).toEqual([{ sliceId: "2026-10-20-0900", turnIds: ["t3"] }]);
  });

  it("an explicit mark WINS over the old level for its slice (newest round subsumes)", () => {
    const cov = coverage([["2026-10-19-1800", ["t1"]]], "2026-10-19-1800");
    const scope = scopeFromSummaries(cov, [summary("2026-10-19-1800", ["t1", "t2"])]);
    expect(scope).toEqual([{ sliceId: "2026-10-19-1800", turnIds: ["t2"] }]);
  });

  it("UNKNOWN coverage (null — unparseable level, unreadable log): NOTHING counts as covered, never 'all done'", () => {
    expect(
      scopeFromSummaries(NO_COVERAGE, [summary("2026-10-01-0001", ["t1"])]),
    ).toEqual([{ sliceId: "2026-10-01-0001", turnIds: ["t1"] }]);
  });

  it("never mutates its input", () => {
    const summaries = [summary("2026-10-16-0712", ["t2"]), summary("2026-10-15-0930", ["t1"])];
    scopeFromSummaries(NOTHING_COVERED, summaries);
    expect(summaries.map((s) => s.sliceId)).toEqual(["2026-10-16-0712", "2026-10-15-0930"]);
  });
});

describe("judgeEvolutionBeat — the §3.4 truth table (v0.42: closedBy optional)", () => {
  const scopeBoundary = [scoped("2026-10-15-0930", ["t1"], "idle_gap")];
  const scopeCheckpoint = [scoped("2026-10-15-0930", ["t1"], "time_cap")];
  const scopeOpen = [scoped("2026-10-15-0930", ["t1"])]; // no closedBy — an OPEN slice
  const dueAgenda = [{ due: DATE, text: "复查（据片 2026-10-14-1858）" }];

  it("a boundary-class close in scope offers the beat (conversation_boundary)", () => {
    const r = judgeEvolutionBeat({ date: DATE, scope: scopeBoundary, lastEvolutionDate: DATE, agendaDue: [] });
    expect(r).toEqual({ due: true, reasons: ["conversation_boundary"] });
  });

  it("a CHECKPOINT-only scope does NOT trigger the beat by itself", () => {
    const r = judgeEvolutionBeat({ date: DATE, scope: scopeCheckpoint, lastEvolutionDate: DATE, agendaDue: [] });
    expect(r).toEqual({ due: false, reasons: [] });
  });

  it("an OPEN slice (no closedBy) never fires the boundary reason — the criterion is unchanged, it simply needs a seal", () => {
    const r = judgeEvolutionBeat({ date: DATE, scope: scopeOpen, lastEvolutionDate: DATE, agendaDue: [] });
    expect(r).toEqual({ due: false, reasons: [] });
  });

  it("daily rollover: date past lastEvolution with a non-empty scope (daily_rollover)", () => {
    const r = judgeEvolutionBeat({ date: DATE, scope: scopeCheckpoint, lastEvolutionDate: "2026-10-15", agendaDue: [] });
    expect(r).toEqual({ due: true, reasons: ["daily_rollover"] });
  });

  it("same-day does not re-offer the daily; an EMPTY scope never does either", () => {
    expect(
      judgeEvolutionBeat({ date: DATE, scope: scopeCheckpoint, lastEvolutionDate: DATE, agendaDue: [] }).due,
    ).toBe(false);
    expect(
      judgeEvolutionBeat({ date: DATE, scope: [], lastEvolutionDate: "2020-01-01", agendaDue: [] }).due,
    ).toBe(false);
  });

  it("never-evolved (null lastEvolution) counts as overdue when there is material", () => {
    expect(
      judgeEvolutionBeat({ date: DATE, scope: scopeCheckpoint, lastEvolutionDate: null, agendaDue: [] }),
    ).toEqual({ due: true, reasons: ["daily_rollover"] });
  });

  it("a due agenda offers the beat even with an EMPTY scope (agenda_due)", () => {
    const r = judgeEvolutionBeat({ date: DATE, scope: [], lastEvolutionDate: DATE, agendaDue: dueAgenda });
    expect(r).toEqual({ due: true, reasons: ["agenda_due"] });
  });

  it("reasons accumulate in the design's order — boundary, daily, agenda", () => {
    const r = judgeEvolutionBeat({ date: DATE, scope: scopeBoundary, lastEvolutionDate: "2026-10-15", agendaDue: dueAgenda });
    expect(r).toEqual({
      due: true,
      reasons: ["conversation_boundary", "daily_rollover", "agenda_due"],
    });
    // …and every reason is a member of the enumerated set, never a free string.
    for (const reason of r.reasons) {
      expect(EVOLUTION_REASONS).toContain(reason);
    }
  });
});

describe("assembleLapPlan — the §3.3 docket", () => {
  it("an idle world: nothing owed, no agenda — no work, gate closed", () => {
    const p = plan();
    expect(p.scope).toEqual([]);
    expect(p.evolutionDue).toBe(false);
    expect(p.evolutionReasons).toEqual([]);
    expect(p.agendaDue).toEqual([]);
    expect(lapHasWork(p)).toBe(false);
  });

  it("an owed slice past the cursor offers archive AND evolution in one docket", () => {
    const p = plan({ scope: [scoped("2026-10-15-0930", ["t1"], "idle_gap")], lastEvolutionDate: DATE });
    expect(p.scope).toEqual([{ sliceId: "2026-10-15-0930", turnIds: ["t1"], closedBy: "idle_gap" }]);
    expect(p.evolutionReasons).toEqual(["conversation_boundary"]);
    expect(lapHasWork(p)).toBe(true);
    // caller-owned fields ride through untouched
    expect(p.nowIso).toBe(`${DATE}T08:00:00.000Z`);
    expect(p.date).toBe(DATE);
    expect(p.cursor).toBe(CURSOR);
    expect(p.retireAt).toBeUndefined();
  });

  it("the agenda's raw content is parsed INSIDE the plan — due lines land, future and malformed ones do not", () => {
    const p = plan({
      agendaContent: [
        "- [due: 2026-10-15] 昨日到期（据片 2026-10-14-1858）",
        `- [due: ${DATE}] 当日到期也算到期（据片 2026-10-14-1858）`,
        "- [due: 2026-10-21] 还没到（据片 2026-10-14-1858）",
        "this line is broken and must be skipped",
      ].join("\n"),
    });
    expect(p.agendaDue).toEqual([
      { due: "2026-10-15", text: "昨日到期（据片 2026-10-14-1858）" },
      { due: DATE, text: "当日到期也算到期（据片 2026-10-14-1858）" },
    ]);
    expect(p.evolutionReasons).toEqual(["agenda_due"]);
    expect(lapHasWork(p)).toBe(true);
  });

  it("garbage agenda content degrades to an empty agendaDue — it never takes a lap down", () => {
    const p = plan({ agendaContent: "\u0000\u0001 not an agenda at all" });
    expect(p.agendaDue).toEqual([]);
    expect(lapHasWork(p)).toBe(false);
  });

  it("retireAt is a pure passthrough for the blocking race", () => {
    const p = plan({ retireAt: "2026-10-23T08:00:00.000Z" });
    expect(p.retireAt).toBe("2026-10-23T08:00:00.000Z");
  });

  it("lapHasWork: scope ∨ evolution ∨ agenda — the §3.1 idle lap blocks without any of them", () => {
    // an owed open slice: scope non-empty → archive beat alone is work
    expect(lapHasWork(plan({ scope: [scoped("2026-10-15-0930", ["t1"], "capacity")], lastEvolutionDate: DATE }))).toBe(true);
    // agenda only
    expect(lapHasWork(plan({ agendaContent: `- [due: ${DATE}] 到期（据片 x）`, lastEvolutionDate: DATE }))).toBe(true);
    // nothing at all
    expect(lapHasWork(plan({ lastEvolutionDate: DATE }))).toBe(false);
  });
});
