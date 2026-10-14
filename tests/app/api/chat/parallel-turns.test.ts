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
 *  - the summary's opening dedupe sees only LIVE summaries for the slice;
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
  isLiveParallelSummary,
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
