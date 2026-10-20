/**
 * GET /api/evolution/hq-status — the two-layer aggregate + the opt-in log
 * layer (v0.11 streams). The workflow public API (getHookByToken/getRun),
 * the runtime interface (getWorld), the single-scan log bundle and the
 * slice enumeration are mocked; the parallel-runs predicate is real.
 * Pins the event-driven contract: the DEFAULT response carries NO log layer
 * and makes ZERO log-layer calls; ?log=1 re-attaches it for legacy/debug.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  getHookByToken: vi.fn(),
  getRun: vi.fn(),
  runsList: vi.fn(),
  bundle: {
    available: true as boolean,
    reason: undefined as string | undefined,
    derivation: {
      cursor: { sliceId: null as string | null, sha: null as string | null, at: null as string | null },
      rounds: [] as unknown[],
      summaries: [] as unknown[],
    },
  },
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
  readHQLogBundle: async () => h.bundle,
}));

vi.mock("@/lib/episodic/timeline/enumerate", () => ({
  enumerateSliceIds: h.enumerate,
}));

import { HookNotFoundError } from "workflow/errors";
import { GET } from "@/app/api/evolution/hq-status/route";

const STATUS_URL = "http://localhost/api/evolution/hq-status";

beforeEach(() => {
  vi.clearAllMocks();
  h.bundle = {
    available: true,
    reason: undefined,
    derivation: { cursor: { sliceId: null, sha: null, at: null }, rounds: [], summaries: [] },
  };
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

describe("GET /api/evolution/hq-status — the event-driven split (v0.11 streams)", () => {
  it("the DEFAULT response carries NO log layer and makes ZERO log-layer calls", async () => {
    h.getHookByToken.mockRejectedValue(new HookNotFoundError("reflection:main"));

    const res = await GET(new Request(STATUS_URL));
    const body = await res.json();

    expect(body.log).toBeUndefined();
    expect(body.reflection).toEqual({ state: "none" });
    expect(body.runs.state).toBe("live");
    // The poll that used to burn 21–27 GitHub calls must not touch the log
    // plane at all — neither the commit scan nor the slice enumeration.
    expect(h.enumerate).not.toHaveBeenCalled();
  });

  it("all layers live with ?log=1: reflection via the hook channel, the run table, the log cursor + behind count", async () => {
    h.getHookByToken.mockResolvedValue({ runId: "wrun-hq" });
    h.getRun.mockReturnValue({
      status: Promise.resolve("running"),
      createdAt: Promise.resolve(new Date(Date.now() - 60_000).toISOString()),
    });
    h.bundle.derivation = {
      cursor: { sliceId: "2026-10-01-0900", sha: "abc123", at: "2026-10-02T10:00:00.000Z" },
      rounds: [
        {
          sha: "abc123",
          committedAt: "2026-10-02T10:00:00.000Z",
          parsed: {
            date: "2026-10-02",
            note: "处理了周末安排。",
            trailer: { seen: [{ sliceId: "2026-10-01-0900" }], evolved: { date: "2026-10-02" } },
          },
          files: [],
        },
      ],
      summaries: [],
    };

    const res = await GET(new Request(`${STATUS_URL}?log=1`));
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

  it("recentSummaries rides the same bundle (v0.43 §5) — parsed counts + failed entries", async () => {
    h.getHookByToken.mockRejectedValue(new HookNotFoundError("reflection:main"));
    h.bundle.derivation.summaries = [
      {
        slice: "2026-10-02-1000",
        at: "2026-10-02T10:05:00.000Z",
        userTurns: 2,
        replies: 2,
        merges: 1,
        failed: [{ turn: "a1b2c3", status: "interrupted" }],
      },
    ];

    const res = await GET(new Request(`${STATUS_URL}?log=1`));
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

  it("no live reflection run → 公开层 says NONE (无人在家 is a verdict) and the log layer still answers with ?log=1", async () => {
    h.getHookByToken.mockRejectedValue(new HookNotFoundError("reflection:main"));
    h.bundle.derivation.cursor = { sliceId: "2026-10-01-0900", sha: "s", at: null };

    const res = await GET(new Request(`${STATUS_URL}?log=1`));
    const body = await res.json();

    expect(body.reflection).toEqual({ state: "none" });
    expect(body.log.state).toBe("live");
    expect(body.log.cursor.sliceId).toBe("2026-10-01-0900");
  });

  it("the runtime layer degrades LOUDLY when runs.list is unavailable — never fabricated rows", async () => {
    h.getHookByToken.mockRejectedValue(new HookNotFoundError("reflection:main"));
    h.runsList.mockRejectedValue(new Error("runtime interface unavailable"));

    const res = await GET(new Request(STATUS_URL));
    const body = await res.json();

    expect(body.runs.state).toBe("unavailable");
    expect(typeof body.runs.reason).toBe("string");
    expect(body.reflection).toEqual({ state: "none" });
    // still zero log-layer work on the default face
    expect(body.log).toBeUndefined();
    expect(h.enumerate).not.toHaveBeenCalled();
  });

  it("the log layer degrades to an explicit line — the run rows stand", async () => {
    h.getHookByToken.mockRejectedValue(new HookNotFoundError("reflection:main"));
    h.bundle = {
      available: false,
      reason: "the memory root is not a git repository …",
      derivation: { cursor: { sliceId: null, sha: null, at: null }, rounds: [], summaries: [] },
    };

    const res = await GET(new Request(`${STATUS_URL}?log=1`));
    const body = await res.json();

    expect(body.log.state).toBe("unavailable");
    expect(body.log.reason).toContain("not a git repository");
    expect(body.runs.state).toBe("live");
  });
});
