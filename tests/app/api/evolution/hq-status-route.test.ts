/**
 * GET /api/evolution/hq-status — the three-layer aggregate (v0.39 §4.1).
 * The workflow public API (getHookByToken/getRun), the runtime interface
 * (getWorld) and the log reader are mocked; the parallel-runs predicate is
 * real. Pins the layer contract: the reflection row answers through the
 * PUBLIC hook channel; the run table degrades LOUDLY (never fabricated);
 * the log layer degrades to an explicit line; 「看不到」never renders as 「没有」.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  getHookByToken: vi.fn(),
  getRun: vi.fn(),
  runsList: vi.fn(),
  cursor: { sliceId: null as string | null, sha: null as string | null, at: null as string | null, degraded: false },
  log: { available: true as boolean, reason: undefined as string | undefined, entries: [] as unknown[] },
  summaries: { available: true as boolean, reason: undefined as string | undefined, entries: [] as unknown[] },
  enumerate: vi.fn(async () => ["2026/10/01/0900", "2026/10/02/1000"]),
}));

vi.mock("workflow/api", () => ({
  getHookByToken: h.getHookByToken,
  getRun: h.getRun,
}));

vi.mock("workflow/runtime", () => ({
  getWorld: async () => ({ runs: { list: h.runsList } }),
}));

vi.mock("@/lib/chat/hq-log", () => ({
  readReflectionCursor: async () => h.cursor,
  readReflectionLog: async () => h.log,
  readRecentSummaries: async () => h.summaries,
}));

vi.mock("@/lib/episodic/timeline/enumerate", () => ({
  enumerateSliceIds: h.enumerate,
}));

import { HookNotFoundError } from "workflow/errors";
import { GET } from "@/app/api/evolution/hq-status/route";

beforeEach(() => {
  vi.clearAllMocks();
  h.cursor = { sliceId: null, sha: null, at: null, degraded: false };
  h.log = { available: true, reason: undefined, entries: [] };
  h.summaries = { available: true, reason: undefined, entries: [] };
  h.runsList.mockResolvedValue({
    data: [
      {
        runId: "wrun-summary",
        status: "running",
        createdAt: new Date(Date.now() - 30_000).toISOString(),
        attributes: { role: "summary", slice: "2026-10-02-1000", burst: "burst-1" },
      },
      {
        runId: "wrun-turn",
        status: "running",
        createdAt: new Date(Date.now() - 12_000).toISOString(),
        attributes: { role: "turn", slice: "2026-10-02-1000", turn: "d4e5f6" },
      },
    ],
  });
});

describe("GET /api/evolution/hq-status — the three layers (v0.39 §4.1)", () => {
  it("all layers live: reflection via the hook channel, the run table with attributes, the log cursor + behind count", async () => {
    h.getHookByToken.mockResolvedValue({ runId: "wrun-hq" });
    h.getRun.mockReturnValue({
      status: Promise.resolve("running"),
      createdAt: Promise.resolve(new Date(Date.now() - 60_000).toISOString()),
    });
    h.cursor = { sliceId: "2026-10-01-0900", sha: "abc123", at: "2026-10-02T10:00:00.000Z", degraded: false };
    h.log.entries = [
      {
        sha: "abc123",
        committedAt: "2026-10-02T10:00:00.000Z",
        parsed: {
          date: "2026-10-02",
          note: "处理了周末安排。",
          trailer: { seen: [{ sliceId: "2026-10-01-0900" }], evolved: { date: "2026-10-02" } },
        },
        files: ["tasks/周末安排/index.md"],
      },
    ];

    const res = await GET();
    const body = await res.json();

    expect(body.reflection.state).toBe("live");
    expect(body.reflection.runId).toBe("wrun-hq");
    expect(body.runs.state).toBe("live");
    expect(body.runs.live).toHaveLength(2);
    const summary = body.runs.live.find((r: { runId: string }) => r.runId === "wrun-summary");
    expect(summary).toMatchObject({
      role: "summary",
      slice: "2026-10-02-1000",
      burst: "burst-1",
    });
    expect(typeof summary.ageMs).toBe("number");
    expect(body.log.state).toBe("live");
    expect(body.log.cursor).toEqual({ sliceId: "2026-10-01-0900", sha: "abc123", at: "2026-10-02T10:00:00.000Z" });
    // behind: only ids STRICTLY past the cursor count (the cursor slice itself
    // is read ground) → 1 of the 2 enumerated
    expect(body.log.behind).toBe(1);
    expect(body.log.recentRounds[0]).toMatchObject({
      date: "2026-10-02",
      note: "处理了周末安排。",
      seen: "2026-10-01-0900",
      evolved: "2026-10-02",
    });
    expect(typeof body.asOf).toBe("string");
  });

  it("recentSummaries rides the log layer (v0.43 §5) — parsed counts + failed entries, degraded on its own flag", async () => {
    h.getHookByToken.mockRejectedValue(new HookNotFoundError("reflection:main"));
    h.summaries.entries = [
      {
        slice: "2026-10-02-1000",
        at: "2026-10-02T10:05:00.000Z",
        userTurns: 2,
        replies: 2,
        merges: 1,
        failed: [{ turn: "a1b2c3", status: "interrupted" }],
      },
    ];

    const res = await GET();
    const body = await res.json();

    expect(body.log.state).toBe("live");
    expect(body.log.summariesAvailable).toBe(true);
    expect(body.log.recentSummaries[0]).toEqual({
      slice: "2026-10-02-1000",
      at: "2026-10-02T10:05:00.000Z",
      userTurns: 2,
      replies: 2,
      merges: 1,
      failed: [{ turn: "a1b2c3", status: "interrupted" }],
    });
  });

  it("the summaries read degrades on its OWN flag — the log layer still answers (recentSummaries empty, never fabricated)", async () => {
    h.getHookByToken.mockRejectedValue(new HookNotFoundError("reflection:main"));
    h.summaries = { available: false, reason: "summary log read failed: boom", entries: [] };

    const res = await GET();
    const body = await res.json();

    expect(body.log.state).toBe("live");
    expect(body.log.summariesAvailable).toBe(false);
    expect(body.log.summariesReason).toContain("boom");
    expect(body.log.recentSummaries).toEqual([]);
  });

  it("no live reflection run → 公开层 says NONE (无人在家 is a verdict) and the log layer still answers", async () => {
    h.getHookByToken.mockRejectedValue(new HookNotFoundError("reflection:main"));
    h.cursor = { sliceId: "2026-10-01-0900", sha: "s", at: null, degraded: false };

    const res = await GET();
    const body = await res.json();

    expect(body.reflection).toEqual({ state: "none" });
    expect(body.log.state).toBe("live");
    expect(body.log.cursor.sliceId).toBe("2026-10-01-0900");
  });

  it("the runtime layer degrades LOUDLY when runs.list is unavailable — never fabricated rows", async () => {
    h.getHookByToken.mockRejectedValue(new HookNotFoundError("reflection:main"));
    h.runsList.mockRejectedValue(new Error("runtime interface unavailable"));

    const res = await GET();
    const body = await res.json();

    expect(body.runs.state).toBe("unavailable");
    expect(typeof body.runs.reason).toBe("string");
    expect(body.reflection).toEqual({ state: "none" });
  });

  it("the log layer degrades to an explicit line — the run rows stand", async () => {
    h.getHookByToken.mockRejectedValue(new HookNotFoundError("reflection:main"));
    h.log = { available: false, reason: "the memory root is not a git repository …", entries: [] };

    const res = await GET();
    const body = await res.json();

    expect(body.log.state).toBe("unavailable");
    expect(body.log.reason).toContain("not a git repository");
    expect(body.runs.state).toBe("live");
  });
});
