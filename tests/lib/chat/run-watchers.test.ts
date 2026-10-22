import { afterEach, describe, expect, it, vi } from "vitest";
import { createRunWatchers } from "@/lib/chat/run-watchers";

afterEach(() => vi.useRealTimers());

describe("run subscription lifetime", () => {
  it("backs off transport failures, then announces a terminal exactly once", async () => {
    vi.useFakeTimers();
    const watch = vi.fn().mockResolvedValueOnce({ kind: "retry" }).mockResolvedValueOnce({ kind: "retry" }).mockResolvedValue({ kind: "terminal" });
    const onTerminal = vi.fn();
    const watchers = createRunWatchers({ watch, onTerminal });
    watchers.sync(["run"], true);
    await vi.advanceTimersByTimeAsync(0);
    expect(watch).toHaveBeenCalledTimes(1);
    expect(onTerminal).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(999);
    expect(watch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(watch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2000);
    expect(watch).toHaveBeenCalledTimes(3);
    expect(onTerminal).toHaveBeenCalledExactlyOnceWith("run");
    watchers.sync(["run"], true);
    await vi.advanceTimersByTimeAsync(60000);
    expect(watch).toHaveBeenCalledTimes(3);
    watchers.dispose();
  });

  it("pauses active subscriptions and ignores a superseded reader's result", async () => {
    vi.useFakeTimers();
    let finishOld!: (result: { kind: "terminal" }) => void;
    const watch = vi.fn().mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }))
      .mockResolvedValue({ kind: "retry" });
    const onTerminal = vi.fn();
    const watchers = createRunWatchers({ watch, onTerminal });
    watchers.sync(["run"], true);
    const firstSignal = watch.mock.calls[0][0].signal as AbortSignal;
    watchers.sync(["run"], false);
    expect(firstSignal.aborted).toBe(true);
    watchers.sync(["run"], true);
    finishOld({ kind: "terminal" });
    await vi.advanceTimersByTimeAsync(0);
    expect(onTerminal).not.toHaveBeenCalled();
    expect(watch).toHaveBeenCalledTimes(2);
    watchers.dispose();
    await vi.advanceTimersByTimeAsync(60000);
    expect(watch).toHaveBeenCalledTimes(2);
  });
});
