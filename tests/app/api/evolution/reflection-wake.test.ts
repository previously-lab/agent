/**
 * The mechanical bell (v0.34 R1) — the reflection unit's ONLY trigger, and
 * it rings ONLY on a real seal (the per-turn tail bell and the cancel-route
 * bare bell retired).
 *
 * `workflow/api` is mocked (no real hook/start);
 * `@/app/api/evolution/reflection-run` is stubbed so the workflow shell's
 * graph stays out of this test. Pins the three delivery paths (resume /
 * start fallback / raced resume) and the payload shape: a PURE POINTER
 * ({sliceId, date}) built off the SEALED slice — nobody briefs the unit
 * anymore (and the pointer no longer carries a turnId).
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

import {
  buildReflectionWakePayload,
  deliverReflectionWake,
} from "@/app/api/evolution/reflection-wake";
import type { TurnInput } from "@/lib/chat/turn-types";

const WAKE = { sliceId: "2026-10-04-0131", date: "2026-10-04" };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("deliverReflectionWake — the three delivery paths", () => {
  it("a live run (advisory hit) → resumeHook(REFLECTION_TOKEN, payload); start never called", async () => {
    h.getHookByToken.mockResolvedValue({ runId: "reflection-live" });
    h.resumeHook.mockResolvedValue({ runId: "reflection-live" });

    const r = await deliverReflectionWake(WAKE);

    expect(r).toEqual({ ok: true, delivered: "resumed", runId: "reflection-live" });
    expect(h.getHookByToken).toHaveBeenCalledWith("reflection:main");
    expect(h.resumeHook).toHaveBeenCalledTimes(1);
    expect(h.resumeHook).toHaveBeenCalledWith("reflection:main", WAKE);
    expect(h.start).not.toHaveBeenCalled();
  });

  it("no live run (advisory miss) → start(reflectionRun, [payload], hkg1) — the resident unit's resurrection path", async () => {
    h.getHookByToken.mockRejectedValue(new Error("HookNotFoundError: no hook"));
    h.start.mockResolvedValue({ runId: "reflection-fresh" });

    const r = await deliverReflectionWake(WAKE);

    expect(r).toEqual({ ok: true, delivered: "started", runId: "reflection-fresh" });
    expect(h.start).toHaveBeenCalledTimes(1);
    const [workflowFn, args, opts] = h.start.mock.calls[0];
    expect(workflowFn).toBe(h.reflectionRun);
    expect(args).toEqual([WAKE]);
    expect(opts).toEqual({ region: "hkg1" });
    expect(h.resumeHook).not.toHaveBeenCalled();
  });

  it("a resume raced with the run's exit → fresh start fallback", async () => {
    h.getHookByToken.mockResolvedValue({ runId: "reflection-dying" });
    h.resumeHook.mockRejectedValue(new Error("HookNotFoundError"));
    h.start.mockResolvedValue({ runId: "reflection-fresh" });

    const r = await deliverReflectionWake(WAKE);

    expect(r).toEqual({ ok: true, delivered: "started", runId: "reflection-fresh" });
    expect(h.resumeHook).toHaveBeenCalledTimes(1);
    expect(h.start).toHaveBeenCalledTimes(1);
  });

  it("start itself failing → { ok: false }, never a throw — a lost bell only warns", async () => {
    h.getHookByToken.mockRejectedValue(new Error("HookNotFoundError"));
    h.start.mockRejectedValue(new Error("world unreachable"));

    const r = await deliverReflectionWake(WAKE);

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("could not be reached");
  });

  it("the engine never inspects the payload — an empty one delivers the same way", async () => {
    h.getHookByToken.mockResolvedValue({ runId: "reflection-live" });
    h.resumeHook.mockResolvedValue({ runId: "reflection-live" });

    const r = await deliverReflectionWake({});

    expect(r.ok).toBe(true);
    expect(h.resumeHook).toHaveBeenCalledWith("reflection:main", {});
  });
});

describe("buildReflectionWakePayload — a pure pointer off the SEALED slice", () => {
  it("carries the sealed slice's id + the USER-LOCAL date (no turnId — v0.34 R1 narrowed the pointer)", () => {
    // 2026-03-02 16:30 UTC = 2026-03-03 00:30 in Asia/Shanghai.
    const input = {
      turnId: "turn-1",
      startedAtIso: "2026-03-02T16:30:00.000Z",
      clientTimezone: "Asia/Shanghai",
    } as unknown as TurnInput;

    expect(buildReflectionWakePayload("2026-10-04-0131", input)).toEqual({
      sliceId: "2026-10-04-0131",
      date: "2026-03-03",
    });
  });

  it("omits the date when the turn carries no start timestamp", () => {
    const input = { turnId: "turn-1" } as unknown as TurnInput;

    const payload = buildReflectionWakePayload("2026-10-04-0131", input);

    expect(payload).toEqual({ sliceId: "2026-10-04-0131" });
    expect("date" in payload).toBe(false);
  });
});
