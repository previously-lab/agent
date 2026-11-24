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
 * a blind cancel; hook ABSENT → start a fresh short-lived unit — the bell's
 * range (v0.42 §4) rides the start args, `[null]` when there is none (the
 * fresh unit then derives its scope from the commit log, §3.5).
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

  it("keeps a slow live holder without challenging it by age", async () => {
    h.getHookByToken.mockResolvedValue({ runId: "slow" });
    expect(await deliverReflectionWake()).toEqual({ ok: true, delivered: "rung", runId: "slow" });
    expect(h.start).not.toHaveBeenCalled();
  });

  it("no live run (advisory miss) → start(reflectionRun, [null], hkg1) — a rangeless fresh unit reads the log (§3.5)", async () => {
    h.getHookByToken.mockRejectedValue(new Error("HookNotFoundError: no hook"));
    h.start.mockResolvedValue({ runId: "reflection-fresh" });

    const r = await deliverReflectionWake();

    expect(r).toEqual({ ok: true, delivered: "started", runId: "reflection-fresh" });
    expect(h.start).toHaveBeenCalledTimes(1);
    const [workflowFn, args, opts] = h.start.mock.calls[0];
    expect(workflowFn).toBe(h.reflectionRun);
    expect(args).toEqual([null]); // no range on a bare ring — the log scopes it
    expect(opts).toEqual({ region: "hkg1" });
    expect(h.resumeHook).not.toHaveBeenCalled();
  });

  it("the bell's range rides the start args (v0.42 §4 — 触发携带范围)", async () => {
    h.getHookByToken.mockRejectedValue(new Error("HookNotFoundError: no hook"));
    h.start.mockResolvedValue({ runId: "reflection-fresh" });
    const range = { sliceId: "2026-10-20-1836", turnIds: ["a1b2c3"] };

    const r = await deliverReflectionWake(range);

    expect(r).toEqual({ ok: true, delivered: "started", runId: "reflection-fresh" });
    expect(h.start).toHaveBeenCalledTimes(1);
    const [workflowFn, args, opts] = h.start.mock.calls[0];
    expect(workflowFn).toBe(h.reflectionRun);
    expect(args).toEqual([range]);
    expect(opts).toEqual({ region: "hkg1" });
  });

  it("start itself failing → { ok: false }, never a throw — a lost bell only warns", async () => {
    h.getHookByToken.mockRejectedValue(new Error("HookNotFoundError"));
    h.start.mockRejectedValue(new Error("world unreachable"));

    const r = await deliverReflectionWake();

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("could not be reached");
  });
});
