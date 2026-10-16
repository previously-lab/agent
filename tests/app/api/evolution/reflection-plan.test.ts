/**
 * Tests for the reflection lap's mechanical gate
 * (src/app/api/evolution/reflection-plan.ts, v0.34 §3.3/§3.4) — the pure
 * judgment the `loadReflectionWorld` step and the run-body lap loop share.
 * The contract that matters:
 *   - scope: sealed slices with id > cursor, ascending, oldest 5 (design
 *     cap); the cursor's own slice and anything older are excluded, ACTIVE
 *     slices never qualify;
 *   - archive beat: a non-empty scope IS the offer (no separate field);
 *   - evolution beat: boundary-class close in scope / daily rollover with a
 *     non-empty scope / due agenda — checkpoint closes never trigger it
 *     alone, and reasons come from the enumerated EVOLUTION_REASONS set;
 *   - agenda parsing is tolerant by inheritance (parseAgenda): garbage
 *     content degrades to an empty agendaDue, never to a thrown lap.
 */
import { describe, it, expect } from "vitest";

import {
  EVOLUTION_REASONS,
  REFLECTION_SCOPE_MAX,
  assembleLapPlan,
  filterScope,
  judgeEvolutionBeat,
  lapHasWork,
  type LapPlanInput,
  type SliceHead,
} from "@/app/api/evolution/reflection-plan";

const CURSOR = "2026-10-14-1858";
const DATE = "2026-10-16";

function head(sliceId: string, closedBy?: SliceHead["closedBy"]): SliceHead {
  return closedBy === undefined ? { sliceId } : { sliceId, closedBy };
}

function plan(overrides: Partial<LapPlanInput> = {}) {
  return assembleLapPlan({
    nowIso: `${DATE}T08:00:00.000Z`,
    date: DATE,
    cursor: CURSOR,
    slices: [],
    lastEvolutionDate: null,
    agendaContent: null,
    ...overrides,
  });
}

describe("filterScope — the §3.3 range filter", () => {
  it("solo: one sealed slice past the cursor makes the scope", () => {
    expect(
      filterScope(CURSOR, [head("2026-10-15-0930", "idle_gap")]),
    ).toEqual([{ sliceId: "2026-10-15-0930", closedBy: "idle_gap" }]);
  });

  it("two in a row come back ascending, oldest first", () => {
    expect(
      filterScope(CURSOR, [
        head("2026-10-16-0712", "time_cap"),
        head("2026-10-15-0930", "idle_gap"),
      ]),
    ).toEqual([
      { sliceId: "2026-10-15-0930", closedBy: "idle_gap" },
      { sliceId: "2026-10-16-0712", closedBy: "time_cap" },
    ]);
  });

  it("a backlog is capped at the OLDEST 5 — the rest waits for later laps", () => {
    const ids = ["2026-10-15-0930", "2026-10-15-1200", "2026-10-15-1400", "2026-10-15-1800", "2026-10-15-2100", "2026-10-16-0712", "2026-10-16-0800"];
    // Shuffled input: ordering is the filter's job, not the enumerator's.
    const slices = [...ids].reverse().map((id) => head(id, "idle_gap"));
    const scope = filterScope(CURSOR, slices);
    expect(REFLECTION_SCOPE_MAX).toBe(5);
    expect(scope.map((s) => s.sliceId)).toEqual(ids.slice(0, 5));
  });

  it("the cursor's own slice and anything older are excluded; ACTIVE slices never qualify", () => {
    const scope = filterScope(CURSOR, [
      head("2026-10-13-2200", "idle_gap"), // older than the cursor
      head(CURSOR, "user_explicit"), // the cursor itself
      head("2026-10-15-0930"), // still active — no closed_by
      head("2026-10-15-1200", "time_cap"), // the one qualifier
    ]);
    expect(scope).toEqual([{ sliceId: "2026-10-15-1200", closedBy: "time_cap" }]);
  });

  it("a null cursor (fresh deployment) lets every sealed slice in", () => {
    expect(filterScope(null, [head("2026-10-01-0001", "idle_gap")])).toHaveLength(1);
  });

  it("never mutates its input", () => {
    const slices = [head("2026-10-16-0712", "idle_gap"), head("2026-10-15-0930", "idle_gap")];
    filterScope(CURSOR, slices);
    expect(slices.map((s) => s.sliceId)).toEqual(["2026-10-16-0712", "2026-10-15-0930"]);
  });
});

describe("judgeEvolutionBeat — the §3.4 truth table", () => {
  const scopeBoundary = [{ sliceId: "2026-10-15-0930", closedBy: "idle_gap" as const }];
  const scopeCheckpoint = [{ sliceId: "2026-10-15-0930", closedBy: "time_cap" as const }];
  const dueAgenda = [{ due: DATE, text: "复查（据片 2026-10-14-1858）" }];

  it("a boundary-class close in scope offers the beat (conversation_boundary)", () => {
    const r = judgeEvolutionBeat({ date: DATE, scope: scopeBoundary, lastEvolutionDate: DATE, agendaDue: [] });
    expect(r).toEqual({ due: true, reasons: ["conversation_boundary"] });
  });

  it("a CHECKPOINT-only scope does NOT trigger the beat by itself", () => {
    const r = judgeEvolutionBeat({ date: DATE, scope: scopeCheckpoint, lastEvolutionDate: DATE, agendaDue: [] });
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
  it("an idle world: nothing sealed, no agenda — no work, gate closed", () => {
    const p = plan();
    expect(p.scope).toEqual([]);
    expect(p.evolutionDue).toBe(false);
    expect(p.evolutionReasons).toEqual([]);
    expect(p.agendaDue).toEqual([]);
    expect(lapHasWork(p)).toBe(false);
  });

  it("a sealed boundary slice past the cursor offers archive AND evolution in one docket", () => {
    const p = plan({ slices: [head("2026-10-15-0930", "idle_gap")], lastEvolutionDate: DATE });
    expect(p.scope).toEqual([{ sliceId: "2026-10-15-0930", closedBy: "idle_gap" }]);
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
    // checkpoint-only same-day: scope non-empty → archive beat alone is work
    expect(lapHasWork(plan({ slices: [head("2026-10-15-0930", "capacity")], lastEvolutionDate: DATE }))).toBe(true);
    // agenda only
    expect(lapHasWork(plan({ agendaContent: `- [due: ${DATE}] 到期（据片 x）`, lastEvolutionDate: DATE }))).toBe(true);
    // nothing at all
    expect(lapHasWork(plan({ lastEvolutionDate: DATE }))).toBe(false);
  });
});
