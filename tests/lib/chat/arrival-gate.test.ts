import { describe, it, expect, vi, afterEach } from "vitest";
import {
  readArrivalVerdict,
  readArrivalWithRecovery,
  shouldDiscardRecoveredSession,
} from "@/lib/chat/reconnect";
import type { ChatRecovery } from "@/lib/chat/actions";

afterEach(() => vi.useRealTimers());

const emptyRecovery = (): ChatRecovery => ({
  records: [], activeRunIds: [], savedRunIds: [], savedSummaryRunIds: [],
  receipts: [], unavailableRunIds: [], failures: [],
});

describe("readArrivalVerdict", () => {
  it("resolves ok when the verdict lands", async () => {
    const r = await readArrivalVerdict(Promise.resolve("v"));
    expect(r).toEqual({ kind: "ok", verdict: "v" });
  });

  it("fails when the verdict rejects", async () => {
    const error = new Error("boom");
    const r = await readArrivalVerdict(Promise.reject(error));
    expect(r).toEqual({ kind: "failed", error });
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

  it("accepts a slow history read once it finishes", async () => {
    vi.useFakeTimers();
    const history = Promise.withResolvers<string>();
    const recover = vi.fn(async () => emptyRecovery());
    const result = readArrivalWithRecovery(history.promise, recover);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(recover).not.toHaveBeenCalled();
    history.resolve("saved");
    expect(await result).toMatchObject({ kind: "ok", verdict: { arrival: "saved" } });
  });

  it("preserves receipts from slow workflow recovery", async () => {
    vi.useFakeTimers();
    let resolve!: (value: ChatRecovery) => void;
    const late = new Promise<ChatRecovery>((done) => { resolve = done; });
    const result = readArrivalWithRecovery(Promise.resolve({ mode: "resume" }), () => late);
    await vi.advanceTimersByTimeAsync(60_000);
    resolve({ ...emptyRecovery(), savedRunIds: ["old-run"] });
    expect(await result).toMatchObject({ kind: "ok", verdict: { arrival: { mode: "resume" },
      recovery: { kind: "ok", verdict: { savedRunIds: ["old-run"] } } } });
  });

  it("handles a late recovery rejection without blocking loaded history", async () => {
    vi.useFakeTimers();
    let reject!: (error: Error) => void;
    const late = new Promise<ChatRecovery>((_, fail) => { reject = fail; });
    const result = readArrivalWithRecovery(Promise.resolve({ mode: "resume" }), () => late);
    await vi.advanceTimersByTimeAsync(60_000);
    reject(new Error("network disconnected"));
    expect((await result).kind).toBe("ok");
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
