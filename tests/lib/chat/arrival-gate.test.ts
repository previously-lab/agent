import { describe, it, expect, vi, afterEach } from "vitest";
import {
  ARRIVAL_GATE_TIMEOUT_MS,
  raceArrivalVerdict,
  ARRIVAL_RECOVERY_TIMEOUT_MS,
  readArrivalWithRecovery,
  shouldDiscardRecoveredSession,
} from "@/lib/chat/reconnect";
import type { ChatRecovery } from "@/lib/chat/actions";

afterEach(() => vi.useRealTimers());

const emptyRecovery = (): ChatRecovery => ({
  records: [], activeRunIds: [], savedRunIds: [], savedSummaryRunIds: [],
  receipts: [], unavailableRunIds: [], failures: [],
});

describe("raceArrivalVerdict", () => {
  it("resolves ok when the verdict lands in time", async () => {
    const r = await raceArrivalVerdict(Promise.resolve("v"), 50);
    expect(r).toEqual({ kind: "ok", verdict: "v" });
  });

  it("fails when the verdict hangs past the timeout", async () => {
    const r = await raceArrivalVerdict(new Promise<string>(() => {}), 10);
    expect(r).toEqual({ kind: "timeout" });
  });

  it("fails when the verdict rejects", async () => {
    const error = new Error("boom");
    const r = await raceArrivalVerdict(
      Promise.reject(error),
      50,
    );
    expect(r).toEqual({ kind: "failed", error });
  });

  it("the gate constant is 15s (well under the platform wall)", () => {
    expect(ARRIVAL_GATE_TIMEOUT_MS).toBe(15_000);
  });
});

describe("history-first arrival with optional workflow recovery", () => {
  it.each(["resume", "briefing"])("admits successful %s history despite unavailable old runs", async (mode) => {
    const recovery = { ...emptyRecovery(), unavailableRunIds: ["expired-run"] };
    const history = { mode };
    const result = await readArrivalWithRecovery(Promise.resolve(history), () => Promise.resolve(recovery));
    expect(result).toEqual({ kind: "ok", verdict: { arrival: history, recovery: { kind: "ok", verdict: recovery } } });
    expect(shouldDiscardRecoveredSession(recovery, ["expired-run"], [])).toBe(false);
  });

  it("does not even enqueue recovery until authoritative history finishes", async () => {
    let resolve!: (history: { mode: string }) => void;
    const history = new Promise<{ mode: string }>((done) => { resolve = done; });
    const recover = vi.fn(async () => emptyRecovery());
    const result = readArrivalWithRecovery(history, recover);
    await Promise.resolve();
    expect(recover).not.toHaveBeenCalled();
    resolve({ mode: "resume" });
    expect((await result).kind).toBe("ok");
    expect(recover).toHaveBeenCalledTimes(1);
  });

  it("never downgrades an IO rejection to empty memory or a timeout", async () => {
    const error = new Error("EACCES: memory record");
    const recover = vi.fn(async () => emptyRecovery());
    expect(await readArrivalWithRecovery(Promise.reject(error), recover)).toEqual({ kind: "failed", error });
    expect(recover).not.toHaveBeenCalled();
  });

  it("bounds a hanging history read without starting recovery", async () => {
    vi.useFakeTimers();
    const recover = vi.fn(async () => emptyRecovery());
    const result = readArrivalWithRecovery(new Promise(() => {}), recover);
    await vi.advanceTimersByTimeAsync(ARRIVAL_GATE_TIMEOUT_MS);
    expect(await result).toEqual({ kind: "timeout" });
    expect(recover).not.toHaveBeenCalled();
  });

  it("admits history after the shorter recovery budget, and ignores late receipts", async () => {
    vi.useFakeTimers();
    let resolve!: (value: ChatRecovery) => void;
    const late = new Promise<ChatRecovery>((done) => { resolve = done; });
    const result = readArrivalWithRecovery(Promise.resolve({ mode: "resume" }), () => late);
    await vi.advanceTimersByTimeAsync(ARRIVAL_RECOVERY_TIMEOUT_MS);
    const accepted = await result;
    expect(accepted).toEqual({ kind: "ok", verdict: { arrival: { mode: "resume" }, recovery: { kind: "timeout" } } });
    resolve({ ...emptyRecovery(), savedRunIds: ["old-run"] });
    await Promise.resolve();
    expect(accepted).toEqual(await result);
  });

  it("handles a late recovery rejection without blocking loaded history", async () => {
    vi.useFakeTimers();
    let reject!: (error: Error) => void;
    const late = new Promise<ChatRecovery>((_, fail) => { reject = fail; });
    const result = readArrivalWithRecovery(Promise.resolve({ mode: "resume" }), () => late);
    await vi.advanceTimersByTimeAsync(ARRIVAL_RECOVERY_TIMEOUT_MS);
    expect((await result).kind).toBe("ok");
    reject(new Error("network disconnected"));
    await Promise.resolve();
  });

  it("preserves active runs and pending summaries until exact acknowledgment", () => {
    const recovery = { ...emptyRecovery(), activeRunIds: ["active"], savedRunIds: ["saved"] };
    expect(shouldDiscardRecoveredSession(recovery, ["active", "saved"], ["summary"])).toBe(false);
    const acknowledged = { ...recovery, activeRunIds: [], savedRunIds: ["active", "saved"], savedSummaryRunIds: ["summary"] };
    expect(shouldDiscardRecoveredSession(acknowledged, ["active", "saved"], ["summary"])).toBe(true);
  });

  it("continues after recovery failure without treating it as permanent missing", async () => {
    const result = await readArrivalWithRecovery(Promise.resolve({ mode: "briefing" }), () => Promise.reject(new Error("workflow offline")));
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") expect(result.verdict.recovery.kind).toBe("failed");
    expect(shouldDiscardRecoveredSession(null, ["run"], [])).toBe(false);
    expect(shouldDiscardRecoveredSession({ ...emptyRecovery(), failures: [{ runId: "summary", error: "save failed" }] }, [], ["summary"])).toBe(false);
  });

  it("discards confirmed missing sessions without calling them saved", () => {
    const recovery = { ...emptyRecovery(), missingRunIds: ["gone-run"], missingSummaryRunIds: ["gone-summary"] };
    expect(shouldDiscardRecoveredSession(recovery, ["gone-run"], ["gone-summary"])).toBe(true);
    expect(recovery.savedRunIds).toEqual([]);
    expect(recovery.receipts).toEqual([]);
    expect(shouldDiscardRecoveredSession(recovery, ["gone-run", "unknown-run"], ["gone-summary"])).toBe(false);
    expect(shouldDiscardRecoveredSession({ ...recovery, activeRunIds: ["live"] }, ["gone-run", "live"], [])).toBe(false);
  });
});
