/**
 * The mechanical bell (v0.30 §2.1) — the reflection unit's ONLY trigger.
 *
 * `workflow/api` is mocked (no real hook/start); `@/app/api/evolution/hq-run`
 * is stubbed so the workflow shell's graph stays out of this test. Pins the
 * three delivery paths (resume / start fallback / raced resume) and the
 * payload shape: a PURE POINTER ({sliceId, turnId, date}) built from the
 * finished turn — nobody briefs the unit anymore.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  getHookByToken: vi.fn(),
  resumeHook: vi.fn(),
  start: vi.fn(),
  hqRun: vi.fn(),
}));

vi.mock("workflow/api", () => ({
  getHookByToken: h.getHookByToken,
  resumeHook: h.resumeHook,
  start: h.start,
}));

vi.mock("@/app/api/evolution/hq-run", () => ({
  HQ_TOKEN: "hq:main",
  hqRun: h.hqRun,
}));

import {
  buildReflectionWakePayload,
  deliverReflectionWake,
} from "@/app/api/evolution/reflection-wake";
import type { TimeSlice } from "@/lib/episodic";
import type { TurnInput } from "@/lib/chat/turn-types";

const WAKE = { sliceId: "2026-10-04-0131", turnId: "turn-1", date: "2026-10-04" };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("deliverReflectionWake — the three delivery paths", () => {
  it("a live run (advisory hit) → resumeHook(HQ_TOKEN, payload); start never called", async () => {
    h.getHookByToken.mockResolvedValue({ runId: "hq-live" });
    h.resumeHook.mockResolvedValue({ runId: "hq-live" });

    const r = await deliverReflectionWake(WAKE);

    expect(r).toEqual({ ok: true, delivered: "resumed", runId: "hq-live" });
    expect(h.getHookByToken).toHaveBeenCalledWith("hq:main");
    expect(h.resumeHook).toHaveBeenCalledTimes(1);
    expect(h.resumeHook).toHaveBeenCalledWith("hq:main", WAKE);
    expect(h.start).not.toHaveBeenCalled();
  });

  it("no live run (advisory miss) → start(hqRun, [payload], hkg1) fallback", async () => {
    h.getHookByToken.mockRejectedValue(new Error("HookNotFoundError: no hook"));
    h.start.mockResolvedValue({ runId: "hq-fresh" });

    const r = await deliverReflectionWake(WAKE);

    expect(r).toEqual({ ok: true, delivered: "started", runId: "hq-fresh" });
    expect(h.start).toHaveBeenCalledTimes(1);
    const [workflowFn, args, opts] = h.start.mock.calls[0];
    expect(workflowFn).toBe(h.hqRun);
    expect(args).toEqual([WAKE]);
    expect(opts).toEqual({ region: "hkg1" });
    expect(h.resumeHook).not.toHaveBeenCalled();
  });

  it("a resume raced with the run's exit → fresh start fallback", async () => {
    h.getHookByToken.mockResolvedValue({ runId: "hq-dying" });
    h.resumeHook.mockRejectedValue(new Error("HookNotFoundError"));
    h.start.mockResolvedValue({ runId: "hq-fresh" });

    const r = await deliverReflectionWake(WAKE);

    expect(r).toEqual({ ok: true, delivered: "started", runId: "hq-fresh" });
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

  it("a bare wake ({}) is legal — the cancel route holds only a runId", async () => {
    h.getHookByToken.mockResolvedValue({ runId: "hq-live" });
    h.resumeHook.mockResolvedValue({ runId: "hq-live" });

    const r = await deliverReflectionWake({});

    expect(r.ok).toBe(true);
    expect(h.resumeHook).toHaveBeenCalledWith("hq:main", {});
  });
});

describe("buildReflectionWakePayload — a pure pointer off the finished turn", () => {
  const slice = { slice_id: "2026-10-04-0131" } as unknown as TimeSlice;

  it("carries sliceId + turnId + the USER-LOCAL date", () => {
    // 2026-03-02 16:30 UTC = 2026-03-03 00:30 in Asia/Shanghai.
    const input = {
      turnId: "turn-1",
      startedAtIso: "2026-03-02T16:30:00.000Z",
      clientTimezone: "Asia/Shanghai",
    } as unknown as TurnInput;

    expect(buildReflectionWakePayload(slice, input)).toEqual({
      sliceId: "2026-10-04-0131",
      turnId: "turn-1",
      date: "2026-03-03",
    });
  });

  it("omits the date when the turn carries no start timestamp", () => {
    const input = { turnId: "turn-1" } as unknown as TurnInput;

    const payload = buildReflectionWakePayload(slice, input);

    expect(payload).toEqual({ sliceId: "2026-10-04-0131", turnId: "turn-1" });
    expect("date" in payload).toBe(false);
  });
});
