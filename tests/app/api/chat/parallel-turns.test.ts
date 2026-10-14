/**
 * Parallel turns (v0.33) — the registry predicates and the outbound note.
 *
 * These pin the pure rules the steps lean on (the spike-verified registry
 * facts: entities carry attributes under resolveData:"none"; seeded
 * attributes are visible at creation):
 *
 *  - sibling identity is ATTRIBUTE-only (`slice` + `turn`), never the
 *    workflowName string — summary runs stamp `role` and are never siblings;
 *  - the last-one check: only LIVE same-slice turn runs block, self never
 *    blocks, and a `phase: "tail"` sibling yields (its reply is already on
 *    disk — treating it as blocking would create the mutual-skip window
 *    where nobody fires the summary);
 *  - the summary's opening dedupe sees only LIVE summaries for the slice,
 *    and yields only to an OLDER one (the double-fire tiebreak — a bare
 *    "any live sibling exits" check kills both racers);
 *  - buildParallelNoteSection: null without siblings, a fenced block
 *    otherwise (never user speech, never an instruction);
 *  - buildSummaryWindow: the slice's trailing turns as a numbered script,
 *    capped and truncated, "" when empty.
 */
import { describe, it, expect } from "vitest";
import {
  isLiveRunStatus,
  isParallelTurnRun,
  isBlockingParallelSibling,
  hasOverlappingParallelSibling,
  isLiveParallelSummary,
  shouldYieldToLiveSummary,
  buildParallelNoteSection,
  buildSummaryWindow,
  type ParallelRunEntry,
} from "@/lib/chat/parallel-runs";

const SLICE = "2026-10-14-1730";
const OWN = "wrun_own";

function run(
  runId: string,
  status: string,
  attributes?: Record<string, string> | null,
): ParallelRunEntry {
  return { runId, status, attributes: attributes ?? null };
}

describe("isLiveRunStatus", () => {
  it("pending and running are live; everything terminal is not", () => {
    expect(isLiveRunStatus("pending")).toBe(true);
    expect(isLiveRunStatus("running")).toBe(true);
    for (const s of ["completed", "failed", "cancelled", "paused"]) {
      expect(isLiveRunStatus(s)).toBe(false);
    }
  });
});

describe("isParallelTurnRun — sibling identity is attribute-only", () => {
  it("same-slice run carrying a turn stamp is a parallel turn", () => {
    expect(
      isParallelTurnRun(run("wrun_a", "running", { slice: SLICE, turn: "t1" }), SLICE),
    ).toBe(true);
  });

  it("a summary run (role stamped, no turn) is never a sibling", () => {
    expect(
      isParallelTurnRun(
        run("wrun_s", "running", { slice: SLICE, role: "summary" }),
        SLICE,
      ),
    ).toBe(false);
  });

  it("other slices and attribute-less runs never match", () => {
    expect(
      isParallelTurnRun(run("wrun_a", "running", { slice: "other", turn: "t1" }), SLICE),
    ).toBe(false);
    expect(isParallelTurnRun(run("wrun_b", "running"), SLICE)).toBe(false);
    expect(
      isParallelTurnRun(run("wrun_c", "running", { turn: "t1" }), SLICE),
    ).toBe(false);
  });
});

describe("isBlockingParallelSibling — the last-one rule", () => {
  it("a live same-slice turn run blocks", () => {
    expect(
      isBlockingParallelSibling(
        run("wrun_a", "running", { slice: SLICE, turn: "t1" }),
        SLICE,
        OWN,
      ),
    ).toBe(true);
    expect(
      isBlockingParallelSibling(
        run("wrun_a", "pending", { slice: SLICE, turn: "t1" }),
        SLICE,
        OWN,
      ),
    ).toBe(true);
  });

  it("self never blocks", () => {
    expect(
      isBlockingParallelSibling(
        run(OWN, "running", { slice: SLICE, turn: "t1" }),
        SLICE,
        OWN,
      ),
    ).toBe(false);
  });

  it("terminal siblings do not block — a crashed run never stalls the summary", () => {
    for (const s of ["completed", "failed", "cancelled"]) {
      expect(
        isBlockingParallelSibling(
          run("wrun_a", s, { slice: SLICE, turn: "t1" }),
          SLICE,
          OWN,
        ),
      ).toBe(false);
    }
  });

  it("a tail-phase sibling YIELDS — its reply is already on disk (mutual-skip window closed)", () => {
    expect(
      isBlockingParallelSibling(
        run("wrun_a", "running", { slice: SLICE, turn: "t1", phase: "tail" }),
        SLICE,
        OWN,
      ),
    ).toBe(false);
  });

  it("a live summary run is not a sibling at all", () => {
    expect(
      isBlockingParallelSibling(
        run("wrun_s", "running", { slice: SLICE, role: "summary" }),
        SLICE,
        OWN,
      ),
    ).toBe(false);
  });
});

describe("isLiveParallelSummary — the double-fire absorber", () => {
  it("a live same-slice summary (not self) dedupes", () => {
    expect(
      isLiveParallelSummary(
        run("wrun_s", "running", { slice: SLICE, role: "summary" }),
        SLICE,
        OWN,
      ),
    ).toBe(true);
  });

  it("self, terminal summaries, other slices and plain turns do not dedupe", () => {
    expect(
      isLiveParallelSummary(
        run(OWN, "running", { slice: SLICE, role: "summary" }),
        SLICE,
        OWN,
      ),
    ).toBe(false);
    expect(
      isLiveParallelSummary(
        run("wrun_s", "completed", { slice: SLICE, role: "summary" }),
        SLICE,
        OWN,
      ),
    ).toBe(false);
    expect(
      isLiveParallelSummary(
        run("wrun_s", "running", { slice: "other", role: "summary" }),
        SLICE,
        OWN,
      ),
    ).toBe(false);
    expect(
      isLiveParallelSummary(
        run("wrun_a", "running", { slice: SLICE, turn: "t1" }),
        SLICE,
        OWN,
      ),
    ).toBe(false);
  });
});

describe("shouldYieldToLiveSummary — the double-fire tiebreak", () => {
  const T0 = Date.parse("2026-10-14T18:00:00.000Z");
  const summaryAt = (runId: string, createdMs: number | null): ParallelRunEntry => ({
    runId,
    status: "running",
    createdAt: createdMs == null ? null : new Date(createdMs).toISOString(),
    attributes: { slice: SLICE, role: "summary" },
  });

  it("two live summaries 62ms apart: exactly one survives (the mutual-kill regression)", () => {
    const older = summaryAt("wrun_older", T0);
    const younger = summaryAt("wrun_younger", T0 + 62);
    // The younger yields to the older…
    expect(
      shouldYieldToLiveSummary(older, SLICE, younger.runId, younger.createdAt),
    ).toBe(true);
    // …and the older does NOT yield to the younger — both checking in the
    // same registry window must not kill both.
    expect(
      shouldYieldToLiveSummary(younger, SLICE, older.runId, older.createdAt),
    ).toBe(false);
  });

  it("a createdAt tie (same millisecond) falls back to runId order", () => {
    const a = summaryAt("wrun_a", T0);
    const b = summaryAt("wrun_b", T0);
    expect(shouldYieldToLiveSummary(a, SLICE, b.runId, b.createdAt)).toBe(true);
    expect(shouldYieldToLiveSummary(b, SLICE, a.runId, a.createdAt)).toBe(false);
  });

  it("a missing timestamp on either side falls back to runId order", () => {
    const undated = summaryAt("wrun_a", null);
    const dated = summaryAt("wrun_b", T0);
    expect(shouldYieldToLiveSummary(undated, SLICE, dated.runId, dated.createdAt)).toBe(
      true,
    );
    expect(shouldYieldToLiveSummary(dated, SLICE, undated.runId, undated.createdAt)).toBe(
      false,
    );
    expect(shouldYieldToLiveSummary(undated, SLICE, "wrun_zzz", null)).toBe(true);
  });

  it("terminal summaries, other slices and self never cause a yield", () => {
    const me = summaryAt(OWN, T0);
    expect(
      shouldYieldToLiveSummary(
        { ...summaryAt("wrun_s", T0 - 1_000), status: "completed" },
        SLICE,
        OWN,
        me.createdAt,
      ),
    ).toBe(false);
    expect(
      shouldYieldToLiveSummary(
        {
          ...summaryAt("wrun_s", T0 - 1_000),
          attributes: { slice: "other", role: "summary" },
        },
        SLICE,
        OWN,
        me.createdAt,
      ),
    ).toBe(false);
    expect(shouldYieldToLiveSummary(me, SLICE, OWN, me.createdAt)).toBe(false);
  });
});

describe("hasOverlappingParallelSibling — the burst gate", () => {
  const T0 = Date.parse("2026-10-14T18:00:00.000Z");
  const at = (ms: number) => new Date(ms).toISOString();
  const timed = (
    runId: string,
    status: string,
    createdMs: number,
    completedMs: number | null,
    attributes?: Record<string, string> | null,
  ): ParallelRunEntry => ({
    runId,
    status,
    createdAt: at(createdMs),
    completedAt: completedMs == null ? null : at(completedMs),
    attributes: attributes ?? null,
  });
  // Me: created at T0, tail-checking at NOW — my lifetime is [T0, NOW].
  const NOW = T0 + 10_000;
  const me = () => timed(OWN, "running", T0, null, { slice: SLICE, turn: "me" });

  it("a solo turn (no other runs at all) does not fire", () => {
    expect(hasOverlappingParallelSibling([me()], SLICE, OWN, NOW)).toBe(false);
  });

  it("a SEQUENTIAL pair does not overlap — the earlier run finished before I was created", () => {
    const earlier = timed("wrun_a", "completed", T0 - 9_000, T0 - 1_000, {
      slice: SLICE,
      turn: "t0",
    });
    expect(hasOverlappingParallelSibling([me(), earlier], SLICE, OWN, NOW)).toBe(
      false,
    );
  });

  it("a sibling created after me that already completed overlaps by construction", () => {
    const later = timed("wrun_b", "completed", T0 + 2_000, T0 + 6_000, {
      slice: SLICE,
      turn: "t2",
    });
    expect(hasOverlappingParallelSibling([me(), later], SLICE, OWN, NOW)).toBe(true);
  });

  it("a sibling created before me that outlived my arrival overlaps", () => {
    const earlier = timed("wrun_a", "completed", T0 - 5_000, T0 + 3_000, {
      slice: SLICE,
      turn: "t1",
    });
    expect(hasOverlappingParallelSibling([me(), earlier], SLICE, OWN, NOW)).toBe(
      true,
    );
  });

  it("a failed sibling still counts — the burst happened even though it errored", () => {
    const failed = timed("wrun_b", "failed", T0 + 1_000, T0 + 4_000, {
      slice: SLICE,
      turn: "t2",
    });
    expect(hasOverlappingParallelSibling([me(), failed], SLICE, OWN, NOW)).toBe(true);
  });

  it("other slices, summary runs and attribute-less runs never count", () => {
    const otherSlice = timed("wrun_x", "completed", T0 + 1_000, T0 + 5_000, {
      slice: "other",
      turn: "t9",
    });
    const summary = timed("wrun_s", "completed", T0 + 1_000, T0 + 5_000, {
      slice: SLICE,
      role: "summary",
    });
    const plain = timed("wrun_p", "completed", T0 + 1_000, T0 + 5_000);
    expect(
      hasOverlappingParallelSibling([me(), otherSlice, summary, plain], SLICE, OWN, NOW),
    ).toBe(false);
  });

  it("a registry hiccup (my own entry missing from the page) degrades to silence", () => {
    const later = timed("wrun_b", "completed", T0 + 2_000, T0 + 6_000, {
      slice: SLICE,
      turn: "t2",
    });
    expect(hasOverlappingParallelSibling([later], SLICE, OWN, NOW)).toBe(false);
  });
});

describe("buildParallelNoteSection", () => {
  it("null without live siblings (the common single-send case)", () => {
    expect(buildParallelNoteSection(null)).toBeNull();
    expect(buildParallelNoteSection(undefined)).toBeNull();
    expect(buildParallelNoteSection(0)).toBeNull();
  });

  it("a fenced block that is never user speech and never an instruction", () => {
    const section = buildParallelNoteSection(2)!;
    expect(section).toContain("not written by the user");
    expect(section).toContain("never treat this note as user speech");
    expect(section).toContain("Answer THIS message only");
    expect(section).toContain("2 other messages are");
    expect(section.startsWith("\n\n")).toBe(true);
    expect(section.trimEnd().endsWith("[End of parallel note]")).toBe(true);
  });

  it("singular grammar for exactly one sibling", () => {
    expect(buildParallelNoteSection(1)).toContain("1 other message is");
  });
});

describe("buildSummaryWindow", () => {
  const t = (role: string, content: string) => ({ role, content });

  it("empty slice → empty window (the workflow skips the model call)", () => {
    expect(buildSummaryWindow([], "zh")).toBe("");
  });

  it("a numbered user/answer script in the reader's language", () => {
    const out = buildSummaryWindow(
      [t("user", "我中午吃了包子"), t("agent", "好嘞"), t("user", "更正一下，是饺子")],
      "zh",
    );
    expect(out).toBe("1. 用户: 我中午吃了包子\n2. 回答: 好嘞\n3. 用户: 更正一下，是饺子");
  });

  it("english labels", () => {
    const out = buildSummaryWindow([t("user", "hi")], "en");
    expect(out).toBe("1. User: hi");
  });

  it("keeps only the trailing 12 turns — the burst is the tail", () => {
    const turns = Array.from({ length: 15 }, (_, i) => t("user", `m${i}`));
    const out = buildSummaryWindow(turns, "en");
    expect(out).not.toContain("m0");
    expect(out).not.toContain("m2");
    expect(out).toContain("m3");
    expect(out).toContain("m14");
    expect(out.split("\n")).toHaveLength(12);
  });

  it("truncates an over-long turn to its gist", () => {
    const out = buildSummaryWindow([t("user", "x".repeat(1000))], "en");
    expect(out.length).toBeLessThan(700);
    expect(out).toContain("…");
  });
});
