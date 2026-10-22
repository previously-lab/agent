import { describe, expect, it } from "vitest";
import { buildReflectionRoundMessage, parseReflectionRoundMessage, type ReflectionHistoryCheckpoint } from "@/lib/chat/commit-contract";
import { projectReflectionHistory, settleHistoryCheckpoint, summaryMaterial, type HistoryCommit } from "@/lib/chat/reflection-history";

const sha = (n: number) => n.toString(16).padStart(40, "0");
const slice = "2026-10-22-0900";
const material = (n: number, turn = "turn1", parents: number[] = []): HistoryCommit => ({
  sha: sha(n), parents: parents.map(sha), committedAt: "2026-10-22T00:00:00Z",
  message: `Summary — ${slice}\n\n- reply ${turn}`,
});
const round = (n: number, parent: number, trailer: Parameters<typeof buildReflectionRoundMessage>[0]["trailer"]): HistoryCommit => ({
  sha: sha(n), parents: [sha(parent)], committedAt: "2026-10-22T00:00:00Z",
  message: buildReflectionRoundMessage({ date: "2026-10-22", trailer }),
});

describe("reflection material versions and complete-prefix checkpoints", () => {
  it("the ninth round remains covered; display limits never govern progress", () => {
    const commits = Array.from({ length: 9 }, (_, i) => material(i * 2 + 1, `turn${i}`, i ? [i * 2] : []));
    const rounds = commits.map((m, i) => round(i * 2 + 2, i * 2 + 1, { seen: [{ sliceId: slice, turnIds: [`turn${i}`] }] }));
    const all = commits.flatMap((m, i) => [m, rounds[i]]).reverse();
    expect(projectReflectionHistory(all, sha(18)).pending).toEqual([]);
  });

  it("an older seen turn does not swallow a later answer or cognition for that turn", () => {
    const original = material(1);
    const seen = round(2, 1, { seen: [{ sliceId: slice, turnIds: ["turn1"] }] });
    const late = { ...material(3, "turn1", [2]), message: `Summary — ${slice}\n\n- cognition turn1` };
    expect(projectReflectionHistory([late, seen, original], sha(3)).pending).toEqual([{ sha: sha(3), sliceId: slice, turnIds: ["turn1"] }]);
  });

  it("legacy coverage respects merge ancestry rather than committer timestamps", () => {
    const original = material(1);
    const seen = round(2, 1, { seen: [{ sliceId: slice, turnIds: ["turn1"] }] });
    const side = material(3); // old side branch not visible to round 2
    const merge: HistoryCommit = { sha: sha(4), parents: [sha(2), sha(3)], committedAt: null, message: "merge" };
    expect(projectReflectionHistory([merge, seen, original, side], sha(4)).pending).toEqual([{ sha: sha(3), sliceId: slice, turnIds: ["turn1"] }]);
  });

  it("records only locate changed material; replay locators create no work", () => {
    const commit = material(1);
    commit.message += `\n- record replay in 2026-10-21-0800\n- record turn1 in 2026-10-21-0800\n- message client-id in ${slice}`;
    expect(summaryMaterial(commit)).toEqual([{ sha: sha(1), sliceId: "2026-10-21-0800", turnIds: ["turn1"] }]);
    expect(summaryMaterial({ ...commit, message: `Summary — ${slice}\n\n- record replay in ${slice}` })).toEqual([]);
  });

  it("checkpoint settlement preserves pending exceptions and the original basis on ref conflicts", () => {
    const history = projectReflectionHistory([material(2, "turn2", [1]), material(1)], sha(2));
    const settled = settleHistoryCheckpoint(history, [{ sliceId: slice, turnIds: ["turn1"] }]);
    expect(settled.basis).toBe(sha(2));
    expect(settled.pending).toEqual([{ sha: sha(2), sliceId: slice, turnIds: ["turn2"] }]);
    const concurrent = material(3, "turn1", [2]);
    const commit = round(4, 3, { seen: [{ sliceId: slice, turnIds: ["turn1"] }], observed: [{ sha: sha(1), sliceId: slice, turnIds: ["turn1"] }], history: settled });
    expect(projectReflectionHistory([commit, concurrent], sha(4), settled).pending).toEqual([
      { sha: sha(2), sliceId: slice, turnIds: ["turn2"] },
      { sha: sha(3), sliceId: slice, turnIds: ["turn1"] },
    ]);
    expect(history.pending).toHaveLength(2);
  });

  it("failed and superseded rounds leave the material owed", () => {
    const original = material(1);
    const failed = round(2, 1, undefined);
    const superseded = round(3, 2, { seen: [{ sliceId: slice }], superseded: true });
    expect(projectReflectionHistory([superseded, failed, original], sha(3)).pending).toEqual([{ sha: sha(1), sliceId: slice, turnIds: ["turn1"] }]);
  });

  it("a legacy round after a checkpoint can still acknowledge pending prefix material", () => {
    const history: ReflectionHistoryCheckpoint = { version: 1, basis: sha(2), cursor: null, evolved: null,
      pending: [{ sha: sha(1), sliceId: slice, turnIds: ["turn1"] }] };
    const legacy = round(3, 2, { seen: [{ sliceId: slice, turnIds: ["turn1"] }] });
    expect(projectReflectionHistory([legacy], sha(3), history).pending).toEqual([]);
  });

  it("carries the latest substantive note so an idle checkpoint needs no old-history scan", () => {
    const entry = { ...round(2, 1, undefined), message: buildReflectionRoundMessage({ date: "2026-10-22", note: "a useful note" }) };
    const first = projectReflectionHistory([entry, material(1)], sha(2));
    const next = projectReflectionHistory([round(3, 2, { observed: [] })], sha(3), first);
    expect(next.latestNote).toEqual({ note: "a useful note", at: entry.committedAt });
  });

  it("checkpoint and exact receipts survive serialization; unknown versions rebuild", () => {
    const history: ReflectionHistoryCheckpoint = { version: 1, basis: sha(1), cursor: slice, evolved: "2026-10-22", pending: [] };
    const trailer = { history, observed: [] };
    expect(parseReflectionRoundMessage(buildReflectionRoundMessage({ date: "2026-10-22", trailer }))?.trailer).toEqual(trailer);
    for (const bad of [{ ...history, version: 2 }, { ...history, basis: "main" }, { ...history, pending: [{ sha: sha(1), sliceId: slice, turnIds: [] }] }]) {
      expect(parseReflectionRoundMessage(`Reflection round — 2026-10-22\n\n—\nhistory: ${JSON.stringify(bad)}`)?.trailer?.history).toBeUndefined();
    }
  });
});
