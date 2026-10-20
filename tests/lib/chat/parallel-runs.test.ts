/**
 * parallel-runs — isLastBurstTurn (v0.38 §3.2; v0.42 review should-fix 4):
 * a burstId with NO visible siblings must read as "last" — a solo+burstId
 * turn otherwise never persists (the no-sibling leg used to return false,
 * and the persistence gate calls this predicate directly).
 */
import { describe, it, expect } from "vitest";
import {
  isLastBurstTurn,
  type ParallelRunEntry,
} from "@/lib/chat/parallel-runs";

const SLICE = "2026-10-20-1836";

function turn(
  runId: string,
  turnId: string,
  status: string,
  over: { burst?: string; phase?: string } = {},
): ParallelRunEntry {
  return {
    runId,
    status,
    attributes: {
      slice: SLICE,
      turn: turnId,
      ...(over.burst ? { burst: over.burst } : {}),
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
});
