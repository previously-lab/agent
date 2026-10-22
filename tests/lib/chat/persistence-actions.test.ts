import { beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ runs: new Map<string, { status: string; returnValue?: unknown; attributes?: Record<string, string> }>() }));
vi.mock("workflow/api", () => ({ getRun: (id: string) => {
  const run = h.runs.get(id);
  if (!run) throw new Error("not found");
  return { status: Promise.resolve(run.status), returnValue: Promise.resolve(run.returnValue) };
} }));
vi.mock("workflow/runtime", () => ({ getWorld: async () => ({ runs: {
  get: async (id: string) => h.runs.get(id),
  list: async () => ({ data: [...h.runs].map(([runId, row]) => ({ ...row, runId })) }),
} }) }));
import { getChatRecovery, getPersistenceState } from "@/lib/chat/actions";
const receipt = { version: 1, commitSha: "sha", records: [{ sliceId: "slice", turnIds: ["turn"] }] };
const record = { turnId: "turn", sliceId: "slice", at: "2026-10-22T00:00:00Z", userText: "question", replyText: "answer", cognition: "", summaryRunId: "summary" };
beforeEach(() => h.runs.clear());

describe("persistence recovery reads durable outcomes", () => {
  it("does not confuse a completed workflow whose outcome failed with a commit", async () => {
    h.runs.set("summary", { status: "completed", returnValue: { kind: "failed", error: "write failed" } });
    expect(await getPersistenceState("summary")).toEqual({ state: "failed", error: "write failed" });
    h.runs.set("summary", { status: "completed", returnValue: { kind: "deduped" } });
    expect(await getPersistenceState("summary")).toEqual({ state: "unknown" });
  });

  it("recovers a completed answer while its summary is pending, then acknowledges actual coverage", async () => {
    h.runs.set("turn-run", { status: "completed", returnValue: record });
    h.runs.set("summary", { status: "running" });
    expect((await getChatRecovery(["turn-run"])).records).toEqual([{ runId: "turn-run", record }]);
    h.runs.set("summary", { status: "completed", returnValue: { kind: "committed", receipt } });
    const recovered = await getChatRecovery(["turn-run"]);
    expect(recovered.records).toEqual([]);
    expect(recovered.receipts).toEqual([receipt]);
    expect(recovered.savedRunIds).toEqual(["turn-run"]);
  });

  it("does not discard an answer when a different turn received the receipt", async () => {
    h.runs.set("turn-run", { status: "completed", returnValue: record });
    h.runs.set("summary", { status: "completed", returnValue: { kind: "committed", receipt: { ...receipt, records: [{ sliceId: "slice", turnIds: ["other"] }] } } });
    expect((await getChatRecovery(["turn-run"])).records).toHaveLength(1);
  });

  it("recovers a summary accepted before its start response was lost, even when the answer run failed", async () => {
    h.runs.set("turn-run", { status: "failed", attributes: { turn: "turn" } });
    h.runs.set("summary", { status: "running", attributes: { role: "summary", turn: "turn" } });
    const waiting = await getChatRecovery(["turn-run"]);
    expect(waiting.failures).toEqual([]);
    expect(waiting.unavailableRunIds).toEqual(["turn-run"]);
    h.runs.set("summary", { status: "completed", attributes: { role: "summary", turn: "turn" }, returnValue: { kind: "committed", receipt } });
    const recovered = await getChatRecovery(["turn-run"]);
    expect(recovered.savedRunIds).toEqual(["turn-run"]);
    expect(recovered.unavailableRunIds).toEqual([]);
    expect(recovered.receipts).toEqual([receipt]);
  });

  it("merges coverage returned by different summaries at the same HEAD", async () => {
    h.runs.set("turn-run", { status: "completed", returnValue: record });
    h.runs.set("summary", { status: "completed", returnValue: { kind: "committed", receipt: { ...receipt, records: [{ sliceId: "slice", turnIds: ["other"] }] } } });
    h.runs.set("summary-2", { status: "completed", returnValue: { kind: "deduped", receipt } });
    const recovered = await getChatRecovery(["turn-run"], ["summary", "summary-2"]);
    expect(recovered.savedRunIds).toEqual(["turn-run"]);
    expect(recovered.receipts.flatMap((item) => item.records.flatMap((entry) => entry.turnIds))).toContain("turn");
  });

  it("does not silently skip pending runs beyond the first 32", async () => {
    const ids = Array.from({ length: 40 }, (_, index) => `run-${index}`);
    for (const id of ids) h.runs.set(id, { status: "running" });
    expect((await getChatRecovery(ids)).activeRunIds).toEqual(ids);
  });
});
