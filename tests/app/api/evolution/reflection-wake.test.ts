/**
 * The mechanical bell (v0.38 §3.3) — the reflection unit's ONLY trigger,
 * now a PURE DOORBELL: no payload, no resumeHook (the mailbox retired to a
 * mutex — a live short-lived unit absorbs the ring by construction, since
 * its loop never blocks between laps).
 *
 * `workflow/api` is mocked (no real hook/start/run handles);
 * `@/app/api/evolution/reflection-run` is stubbed so the workflow shell's
 * graph stays out of this test. Pins the delivery paths: hook PRESENT and
 * young → 触发即完成 (start NEVER called, resumeHook NEVER called); hook
 * PRESENT and STALE (older than REFLECTION_TAKEOVER_MS) → the bell
 * challenges the zombie itself (cancel → start, `tookOver` — observed
 * 2026-10-16: a 38-minute "running" run held the token across restarts and
 * starved the unit, because the takeover claim needs a challenger run and
 * only a bell can start one); age UNREADABLE → conservative `rung`, never
 * a blind cancel; hook ABSENT → start a fresh short-lived unit with NO
 * payload.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  getHookByToken: vi.fn(),
  resumeHook: vi.fn(),
  start: vi.fn(),
  getRun: vi.fn(),
  runsList: vi.fn(),
  reflectionRun: vi.fn(),
}));

vi.mock("workflow/api", () => ({
  getHookByToken: h.getHookByToken,
  resumeHook: h.resumeHook,
  start: h.start,
  getRun: h.getRun,
}));

vi.mock("workflow/runtime", () => ({
  getWorld: vi.fn(async () => ({ runs: { list: h.runsList } })),
}));

vi.mock("@/app/api/evolution/reflection-run", () => ({
  REFLECTION_TOKEN: "reflection:main",
  reflectionRun: h.reflectionRun,
}));

import { deliverReflectionWake } from "@/app/api/evolution/reflection-wake";

const MIN = 60 * 1000;

/** A Run-handle stub: createdAt/cancel configurable per test. */
function runHandle(createdAt: Date, cancel?: () => Promise<void>) {
  return {
    createdAt: Promise.resolve(createdAt),
    cancel: vi.fn(cancel ?? (async () => {})),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("deliverReflectionWake — the pure bell (v0.38 §3.3)", () => {
  it("a live YOUNG run (age 2m) → 触发即完成: NO start, NO resumeHook, no payload anywhere", async () => {
    h.getHookByToken.mockResolvedValue({ runId: "reflection-live" });
    h.getRun.mockReturnValue(runHandle(new Date(Date.now() - 2 * MIN)));

    const r = await deliverReflectionWake();

    expect(r).toEqual({ ok: true, delivered: "rung", runId: "reflection-live" });
    expect(h.getHookByToken).toHaveBeenCalledWith("reflection:main");
    // the mailbox is gone: nothing is pushed, nothing is started
    expect(h.resumeHook).not.toHaveBeenCalled();
    expect(h.start).not.toHaveBeenCalled();
  });

  it("a live STALE run (age 38m, still holding the token) → the bell challenges it: cancel + start, `tookOver`", async () => {
    const cancel = vi.fn(async () => {});
    h.getHookByToken.mockResolvedValue({ runId: "reflection-zombie" });
    h.getRun.mockReturnValue(runHandle(new Date(Date.now() - 38 * MIN), cancel));
    h.start.mockResolvedValue({ runId: "reflection-fresh" });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const r = await deliverReflectionWake();

      expect(r).toEqual({ ok: true, delivered: "tookOver", runId: "reflection-fresh" });
      expect(cancel).toHaveBeenCalledTimes(1); // the zombie itself
      expect(h.start).toHaveBeenCalledTimes(1);
      const [workflowFn, args, opts] = h.start.mock.calls[0];
      expect(workflowFn).toBe(h.reflectionRun);
      expect(args).toEqual([]); // the bell carries NO work (§3.3)
      expect(opts).toEqual({ region: "hkg1" });
      expect(h.resumeHook).not.toHaveBeenCalled();
      // the takeover leaves one observable line (age rounded to minutes)
      const line = log.mock.calls
        .map((c) => String(c[0]))
        .find((m) => m.includes("took over a stale unit"));
      expect(line).toBeDefined();
      expect(line).toContain("(age 38m)");
      expect(line).toContain("reflection-zombie");
    } finally {
      log.mockRestore();
    }
  });

  it("a stale run whose CANCEL throws → still starts, still `tookOver` (the cancel is best-effort)", async () => {
    const cancel = vi.fn(async () => {
      throw new Error("cancel raced the platform");
    });
    h.getHookByToken.mockResolvedValue({ runId: "reflection-zombie" });
    h.getRun.mockReturnValue(runHandle(new Date(Date.now() - 40 * MIN), cancel));
    h.start.mockResolvedValue({ runId: "reflection-fresh" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const r = await deliverReflectionWake();

      expect(r).toEqual({ ok: true, delivered: "tookOver", runId: "reflection-fresh" });
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(h.start).toHaveBeenCalledTimes(1);
      expect(
        warn.mock.calls.some((c) =>
          String(c[0]).includes("takeover cancel of reflection-zombie failed"),
        ),
      ).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it("the holder's age is UNREADABLE (run handle throws, not in the world list) → conservative `rung`: no cancel, no start", async () => {
    h.getHookByToken.mockResolvedValue({ runId: "reflection-unknown" });
    h.getRun.mockImplementation(() => {
      throw new Error("run handle unavailable");
    });
    h.runsList.mockResolvedValue({ data: [] }); // not listed either

    const r = await deliverReflectionWake();

    expect(r).toEqual({ ok: true, delivered: "rung", runId: "reflection-unknown" });
    expect(h.start).not.toHaveBeenCalled();
    expect(h.runsList).toHaveBeenCalledTimes(1);
  });

  it("the run handle has no createdAt but the WORLD LIST knows the run (age 2m) → `rung` via the fallback", async () => {
    h.getHookByToken.mockResolvedValue({ runId: "reflection-listed" });
    h.getRun.mockReturnValue({
      get createdAt(): Promise<Date> {
        return Promise.reject(new Error("no createdAt on this handle"));
      },
    });
    h.runsList.mockResolvedValue({
      data: [
        {
          runId: "reflection-listed",
          status: "running",
          createdAt: new Date(Date.now() - 2 * MIN).toISOString(),
        },
      ],
    });

    const r = await deliverReflectionWake();

    expect(r).toEqual({ ok: true, delivered: "rung", runId: "reflection-listed" });
    expect(h.start).not.toHaveBeenCalled();
  });

  it("no live run (advisory miss) → start(reflectionRun, [], hkg1) — no payload", async () => {
    h.getHookByToken.mockRejectedValue(new Error("HookNotFoundError: no hook"));
    h.start.mockResolvedValue({ runId: "reflection-fresh" });

    const r = await deliverReflectionWake();

    expect(r).toEqual({ ok: true, delivered: "started", runId: "reflection-fresh" });
    expect(h.start).toHaveBeenCalledTimes(1);
    const [workflowFn, args, opts] = h.start.mock.calls[0];
    expect(workflowFn).toBe(h.reflectionRun);
    expect(args).toEqual([]); // the bell carries NO work (§3.3)
    expect(opts).toEqual({ region: "hkg1" });
    expect(h.resumeHook).not.toHaveBeenCalled();
  });

  it("start itself failing → { ok: false }, never a throw — a lost bell only warns", async () => {
    h.getHookByToken.mockRejectedValue(new Error("HookNotFoundError"));
    h.start.mockRejectedValue(new Error("world unreachable"));

    const r = await deliverReflectionWake();

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("could not be reached");
  });
});
