/**
 * GET /api/evolution/hq-status — the stale-"running" self-heal (2026-10-14:
 * a run cancelled at 1h24m left the pointer reading "running" forever — run
 * cancellation stops the workflow at its next suspension point, so the finish
 * mark never executes). The store and `workflow/api`'s getRun are mocked; the
 * v0.33 liveness predicate (parallel-runs) is real. Pins: a registry-terminal
 * run settles the pointer (and the ANSWER carries the settled state); a live
 * run, a registry error, and a non-running pointer never touch it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  getRun: vi.fn(),
  readHQStatus: vi.fn(),
  settleHQRunIfStale: vi.fn(),
}));

vi.mock("workflow/api", () => ({
  getRun: h.getRun,
}));

vi.mock("@/app/api/evolution/hq-status-store", () => ({
  readHQStatus: h.readHQStatus,
  settleHQRunIfStale: h.settleHQRunIfStale,
}));

import { GET } from "@/app/api/evolution/hq-status/route";
import { HQ_STATUS_EMPTY } from "@/lib/chat/hq-status";

const RUNNING = {
  ...HQ_STATUS_EMPTY,
  runStatus: "running" as const,
  runId: "run-1",
  runStartedAt: "2026-10-14T18:58:30.703Z",
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/evolution/hq-status", () => {
  it("a running pointer whose run is TERMINAL in the registry gets settled, and the answer carries the settled state", async () => {
    h.readHQStatus.mockResolvedValue(RUNNING);
    h.getRun.mockReturnValue({ status: Promise.resolve("cancelled") });
    const settled = { ...RUNNING, runStatus: "failed" as const, lastError: "…" };
    h.settleHQRunIfStale.mockResolvedValue(settled);

    const res = await GET();
    const body = await res.json();

    expect(h.settleHQRunIfStale).toHaveBeenCalledWith("run-1", "cancelled");
    expect(body.status.runStatus).toBe("failed");
    expect(typeof body.asOf).toBe("string");
  });

  it.each(["completed", "failed"])(
    "settles on every non-live registry status (here: %s)",
    async (registryStatus) => {
      h.readHQStatus.mockResolvedValue(RUNNING);
      h.getRun.mockReturnValue({ status: Promise.resolve(registryStatus) });
      h.settleHQRunIfStale.mockResolvedValue({ ...RUNNING, runStatus: "failed" as const });

      await GET();

      expect(h.settleHQRunIfStale).toHaveBeenCalledWith("run-1", registryStatus);
    },
  );

  it("a genuinely LIVE run leaves the pointer untouched", async () => {
    h.readHQStatus.mockResolvedValue(RUNNING);
    h.getRun.mockReturnValue({ status: Promise.resolve("running") });

    const res = await GET();
    const body = await res.json();

    expect(h.settleHQRunIfStale).not.toHaveBeenCalled();
    expect(body.status.runStatus).toBe("running");
  });

  it("never heals on doubt — a registry error returns the pointer as read", async () => {
    h.readHQStatus.mockResolvedValue(RUNNING);
    h.getRun.mockImplementation(() => {
      throw new Error("world unreachable");
    });

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(h.settleHQRunIfStale).not.toHaveBeenCalled();
    expect(body.status.runStatus).toBe("running");
  });

  it("a non-running pointer (or one without a runId) never consults the registry", async () => {
    h.readHQStatus.mockResolvedValue({ ...HQ_STATUS_EMPTY, runStatus: "idle" });
    await GET();
    h.readHQStatus.mockResolvedValue(HQ_STATUS_EMPTY);
    await GET();

    expect(h.getRun).not.toHaveBeenCalled();
    expect(h.settleHQRunIfStale).not.toHaveBeenCalled();
  });
});
