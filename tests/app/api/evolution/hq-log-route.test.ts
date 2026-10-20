/**
 * GET /api/evolution/hq-log — the log layer alone (v0.11 streams): the
 * panel's event-driven GitHub read (open / run-terminal / manual refresh).
 * The single-scan bundle and the slice enumeration are mocked; pins the
 * response shape ({asOf, log}) and the 降级显式 contract.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  bundle: {
    available: true as boolean,
    reason: undefined as string | undefined,
    derivation: {
      cursor: { sliceId: null as string | null, sha: null as string | null, at: null as string | null },
      rounds: [] as unknown[],
      summaries: [] as unknown[],
    },
  },
  enumerate: vi.fn(async () => [] as string[]),
}));

vi.mock("@/lib/chat/hq-log", () => ({
  readHQLogBundle: async () => h.bundle,
}));

vi.mock("@/lib/episodic/timeline/enumerate", () => ({
  enumerateSliceIds: h.enumerate,
}));

import { GET } from "@/app/api/evolution/hq-log/route";

beforeEach(() => {
  vi.clearAllMocks();
  h.bundle = {
    available: true,
    reason: undefined,
    derivation: { cursor: { sliceId: null, sha: null, at: null }, rounds: [], summaries: [] },
  };
  h.enumerate.mockResolvedValue([]);
});

describe("GET /api/evolution/hq-log — the event-driven log read", () => {
  it("returns {asOf, log} with the cursor, behind count, recentRounds and recentSummaries", async () => {
    h.bundle.derivation = {
      cursor: { sliceId: "2026-10-01-0900", sha: "abc123", at: "2026-10-02T10:00:00.000Z" },
      rounds: [
        {
          sha: "abc123",
          committedAt: "2026-10-02T10:00:00.000Z",
          parsed: {
            date: "2026-10-02",
            note: "处理了周末安排。",
            trailer: {
              seen: [{ sliceId: "2026-10-01-0900", turnIds: ["a1b2c3"] }],
              evolved: { date: "2026-10-02" },
            },
          },
          files: [],
        },
      ],
      summaries: [
        {
          slice: "2026-10-02-1000",
          at: "2026-10-02T10:05:00.000Z",
          userTurns: 2,
          replies: 2,
          merges: 1,
          failed: [],
        },
      ],
    };
    h.enumerate.mockResolvedValue(["2026/10/01/0900", "2026/10/02/1000"]);

    const res = await GET();
    const body = await res.json();

    expect(typeof body.asOf).toBe("string");
    expect(body.log.state).toBe("live");
    expect(body.log.cursor).toEqual({
      sliceId: "2026-10-01-0900",
      sha: "abc123",
      at: "2026-10-02T10:00:00.000Z",
    });
    expect(body.log.behind).toBe(1);
    expect(body.log.recentRounds[0]).toMatchObject({
      date: "2026-10-02",
      note: "处理了周末安排。",
      seen: "2026-10-01-0900",
      evolved: "2026-10-02",
      superseded: false,
    });
    expect(body.log.recentSummaries).toHaveLength(1);
    expect(body.log.summariesAvailable).toBe(true);
  });

  it("no cursor yet → behind counts the WHOLE enumeration (fresh-deployment glance)", async () => {
    h.enumerate.mockResolvedValue(["2026/10/01/0900", "2026/10/02/1000"]);

    const res = await GET();
    const body = await res.json();

    expect(body.log.state).toBe("live");
    expect(body.log.cursor).toBeNull();
    expect(body.log.behind).toBe(2);
  });

  it("the enumeration hiccup degrades ONLY the behind count — the rest stands", async () => {
    h.enumerate.mockRejectedValue(new Error("tree enumeration failed"));
    h.bundle.derivation.cursor = { sliceId: "2026-10-01-0900", sha: "s", at: null };

    const res = await GET();
    const body = await res.json();

    expect(body.log.state).toBe("live");
    expect(body.log.behind).toBeNull();
    expect(body.log.cursor.sliceId).toBe("2026-10-01-0900");
  });

  it("the bundle read failed → an explicit unavailable line, never fabricated rows", async () => {
    h.bundle = {
      available: false,
      reason: "log read failed: rate limited",
      derivation: { cursor: { sliceId: null, sha: null, at: null }, rounds: [], summaries: [] },
    };

    const res = await GET();
    const body = await res.json();

    expect(body.log.state).toBe("unavailable");
    expect(body.log.reason).toContain("rate limited");
  });
});
