/**
 * parallel-runs — isLastBurstTurn (v0.38 §3.2; v0.42 review should-fix 4):
 * a burstId with NO visible siblings must read as "last" — a solo+burstId
 * turn otherwise never persists (the no-sibling leg used to return false,
 * and the persistence gate calls this predicate directly).
 */
import { describe, it, expect } from "vitest";
import {
  isBurstSibling,
  isLastBurstTurn,
  isLiveParallelSummary,
  type ParallelRunEntry,
} from "@/lib/chat/parallel-runs";

const SLICE = "2026-10-20-1836";

function turn(
  runId: string,
  turnId: string,
  status: string,
  over: { burst?: string; phase?: string; createdAt?: string; slice?: string } = {},
): ParallelRunEntry {
  return {
    runId,
    status,
    createdAt: over.createdAt ?? null,
    attributes: {
      slice: over.slice ?? SLICE,
      turn: turnId,
      ...(over.burst !== undefined ? { burst: over.burst } : {}),
      ...(over.phase ? { phase: over.phase } : {}),
    },
  };
}

describe("isLastBurstTurn — the solo+burstId leg (v0.42 review should-fix 4)", () => {
  it("a burst id with NO visible siblings → true (a burst of one persists)", () => {
    expect(
      isLastBurstTurn([turn("run-1", "t1", "running", { burst: "b1" })], SLICE, "b1", "run-1", "t1"),
    ).toBe(true);
  });

  it("a sibling still answering → false", () => {
    expect(
      isLastBurstTurn(
        [
          turn("run-1", "t1", "running", { burst: "b1" }),
          turn("run-2", "t2", "running", { burst: "b1" }),
        ],
        SLICE,
        "b1",
        "run-2",
        "t2",
      ),
    ).toBe(false);
  });

  it("a tail-stamped sibling yields → the survivor is last", () => {
    expect(
      isLastBurstTurn(
        [
          turn("run-1", "t1", "running", { burst: "b1", phase: "tail" }),
          turn("run-2", "t2", "running", { burst: "b1" }),
        ],
        SLICE,
        "b1",
        "run-2",
        "t2",
      ),
    ).toBe(true);
  });

  it("completed burst members count as siblings (the burst really happened)", () => {
    expect(
      isLastBurstTurn(
        [
          turn("run-1", "t1", "completed", { burst: "b1" }),
          turn("run-2", "t2", "running", { burst: "b1" }),
        ],
        SLICE,
        "b1",
        "run-2",
        "t2",
      ),
    ).toBe(true);
  });

  it("the v0.42 double-summary fix: a burst's YOUNGEST run is its last survivor — an older run yields to a later-created sibling even after it completed", () => {
    const runs = [
      turn("run-1", "t1", "completed", { burst: "b1", createdAt: "2026-10-20T10:00:00.000Z" }),
      turn("run-2", "t2", "completed", { burst: "b1", createdAt: "2026-10-20T10:00:05.000Z" }),
    ];
    // both completed within one registry window — the OLDER run must yield…
    expect(isLastBurstTurn(runs, SLICE, "b1", "run-1", "t1")).toBe(false);
    // …and the youngest survives.
    expect(isLastBurstTurn(runs, SLICE, "b1", "run-2", "t2")).toBe(true);
  });

  it("a later-created sibling still RUNNING blocks the older run (and its younger sibling sees the live non-tail leg)", () => {
    const runs = [
      turn("run-1", "t1", "running", { burst: "b1", createdAt: "2026-10-20T10:00:00.000Z" }),
      turn("run-2", "t2", "running", { burst: "b1", createdAt: "2026-10-20T10:00:05.000Z" }),
    ];
    // t1's tail check: t2 is live non-tail AND later-created → not last.
    expect(isLastBurstTurn(runs, SLICE, "b1", "run-1", "t1")).toBe(false);
    // t2's tail check: t1 is live non-tail → not last yet.
    expect(isLastBurstTurn(runs, SLICE, "b1", "run-2", "t2")).toBe(false);
  });

  it("runs without createdAt never trigger the yield (宁多勿丢 — the summary dedupe absorbs the overlap)", () => {
    const runs = [
      turn("run-1", "t1", "completed", { burst: "b1" }),
      turn("run-2", "t2", "completed", { burst: "b1" }),
    ];
    expect(isLastBurstTurn(runs, SLICE, "b1", "run-1", "t1")).toBe(true);
    expect(isLastBurstTurn(runs, SLICE, "b1", "run-2", "t2")).toBe(true);
  });

  it("createdAt missing on COMPLETED runs (the local world drops it) → the wrun_<ULID> runId stands in: lexicographic order IS creation order", () => {
    // The real-machine shape: two survivors of one burst, both completed,
    // no createdAt anywhere. ULIDs sort chronologically under a shared prefix.
    const runs = [
      turn("wrun_01M5BQP4AAAAAAA", "t1", "completed", { burst: "b1" }),
      turn("wrun_01M5BQP4ZZZZZZZ", "t2", "completed", { burst: "b1" }),
    ];
    // the OLDER run yields to the lexicographically-greater (younger) id…
    expect(isLastBurstTurn(runs, SLICE, "b1", "wrun_01M5BQP4AAAAAAA", "t1")).toBe(false);
    // …and the youngest survives.
    expect(isLastBurstTurn(runs, SLICE, "b1", "wrun_01M5BQP4ZZZZZZZ", "t2")).toBe(true);
  });

  it("runIds WITHOUT the wrun_ prefix (non-ULID scheme) → no verdict, 宁多勿丢", () => {
    const runs = [
      turn("abc-1", "t1", "completed", { burst: "b1" }),
      turn("abc-2", "t2", "completed", { burst: "b1" }),
    ];
    expect(isLastBurstTurn(runs, SLICE, "b1", "abc-1", "t1")).toBe(true);
    expect(isLastBurstTurn(runs, SLICE, "b1", "abc-2", "t2")).toBe(true);
  });

  it("mixed keys never compare a timestamp against an id", () => {
    const runs = [
      turn("wrun_01M5BQP4AAAAAAA", "t1", "completed", { burst: "b1" }),
      turn("run-2", "t2", "completed", { burst: "b1", createdAt: "2026-10-20T10:00:05.000Z" }),
    ];
    // own has only an id, the sibling only a timestamp — incomparable, no yield.
    expect(isLastBurstTurn(runs, SLICE, "b1", "wrun_01M5BQP4AAAAAAA", "t1")).toBe(true);
  });

  it("ONE burst across DIFFERENT shell slices (cross-minute sends mint different entry shells) → still siblings; only the youngest survives", () => {
    // The real-machine shape: burst ead59415, shells 0837 / 0838, both
    // completed, no createdAt (the local world drops it) — the runId ULID
    // order breaks the tie. Keying on the shell would split this batch in
    // two and BOTH would think themselves the burst's only member.
    const runs = [
      turn("wrun_01M5BQP4AAAAAAA", "t1", "completed", { burst: "ead59415", slice: "2026-10-20-0837" }),
      turn("wrun_01M5BQP4ZZZZZZZ", "t2", "completed", { burst: "ead59415", slice: "2026-10-20-0838" }),
    ];
    // the younger shell's run sees the older shell's run as ITS burst sibling…
    expect(
      isBurstSibling(runs[0]!, "2026-10-20-0838", "ead59415", "wrun_01M5BQP4ZZZZZZZ"),
    ).toBe(true);
    // …the older run yields, the youngest survives.
    expect(isLastBurstTurn(runs, "2026-10-20-0838", "ead59415", "wrun_01M5BQP4AAAAAAA", "t1")).toBe(false);
    expect(isLastBurstTurn(runs, "2026-10-20-0838", "ead59415", "wrun_01M5BQP4ZZZZZZZ", "t2")).toBe(true);
  });

  it("an EMPTY burst id keeps the original same-slice shape: different slices are NOT siblings", () => {
    const runs = [
      turn("run-1", "t1", "completed", { slice: "2026-10-20-0837" }),
      turn("run-2", "t2", "completed", { slice: "2026-10-20-0838" }),
    ];
    expect(isBurstSibling(runs[0]!, "2026-10-20-0838", "", "run-2")).toBe(false);
  });

  it("an EMPTY burst id + the SAME slice (run carrying burst: '') → still siblings", () => {
    const runs = [
      turn("run-1", "t1", "completed", { burst: "" }),
      turn("run-2", "t2", "completed", { burst: "" }),
    ];
    expect(isBurstSibling(runs[0]!, SLICE, "", "run-2")).toBe(true);
  });

  it("isLiveParallelSummary: with a burst id the BATCH is the key — a live summary on ANOTHER shell still blocks; without one, the legacy slice shape", () => {
    const liveSummaryOtherShell = turn("run-s", "x", "running", {
      burst: "ead59415",
      slice: "2026-10-20-0837",
    });
    (liveSummaryOtherShell.attributes as Record<string, string>).role = "summary";
    // burst-keyed: same burst, different shell → blocks.
    expect(
      isLiveParallelSummary(liveSummaryOtherShell, "2026-10-20-0838", "run-own", "ead59415"),
    ).toBe(true);
    // a DIFFERENT burst does not block.
    expect(
      isLiveParallelSummary(liveSummaryOtherShell, "2026-10-20-0838", "run-own", "other-burst"),
    ).toBe(false);
    // empty burst: legacy slice shape — another shell does NOT block.
    expect(
      isLiveParallelSummary(liveSummaryOtherShell, "2026-10-20-0838", "run-own"),
    ).toBe(false);
    expect(
      isLiveParallelSummary(liveSummaryOtherShell, "2026-10-20-0837", "run-own"),
    ).toBe(true);
  });
});
