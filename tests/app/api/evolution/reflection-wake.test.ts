/**
 * The mechanical bell (v0.38 §3.3) — the reflection unit's ONLY trigger,
 * now a PURE DOORBELL: no payload, no resumeHook (the mailbox retired to a
 * mutex — a live short-lived unit absorbs the ring by construction, since
 * its loop never blocks between laps).
 *
 * `workflow/api` is mocked (no real hook/start);
 * `@/app/api/evolution/reflection-run` is stubbed so the workflow shell's
 * graph stays out of this test. Pins the two delivery paths: hook PRESENT →
 * 触发即完成 (start NEVER called, resumeHook NEVER called); hook ABSENT →
 * start a fresh short-lived unit with NO payload.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  getHookByToken: vi.fn(),
  resumeHook: vi.fn(),
  start: vi.fn(),
  reflectionRun: vi.fn(),
}));

vi.mock("workflow/api", () => ({
  getHookByToken: h.getHookByToken,
  resumeHook: h.resumeHook,
  start: h.start,
}));

vi.mock("@/app/api/evolution/reflection-run", () => ({
  REFLECTION_TOKEN: "reflection:main",
  reflectionRun: h.reflectionRun,
}));

import { deliverReflectionWake } from "@/app/api/evolution/reflection-wake";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("deliverReflectionWake — the pure bell (v0.38 §3.3)", () => {
  it("a live run (advisory hit) → 触发即完成: NO start, NO resumeHook, no payload anywhere", async () => {
    h.getHookByToken.mockResolvedValue({ runId: "reflection-live" });

    const r = await deliverReflectionWake();

    expect(r).toEqual({ ok: true, delivered: "rung", runId: "reflection-live" });
    expect(h.getHookByToken).toHaveBeenCalledWith("reflection:main");
    // the mailbox is gone: nothing is pushed, nothing is started
    expect(h.resumeHook).not.toHaveBeenCalled();
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
