import { describe, it, expect, beforeEach, vi } from "vitest";
import type { TimeSlice } from "@/lib/episodic";
import type { TurnInput } from "@/lib/chat/turn-types";

// ── Mock the step dependencies so housekeeping/flashRecall run their real
// control flow against fakes. The "use step" directive is a build-time
// transform vitest doesn't apply, so here they're just async functions we can
// call directly and assert the by-value slice contract on. ──────────────────

const episodic = vi.hoisted(() => ({
  tryLoadTodaySlice: vi.fn(),
  createSlice: vi.fn(),
  closeSlice: vi.fn(),
  appendTurn: vi.fn((slice: TimeSlice, turn: unknown) => {
    slice.turns.push(turn as TimeSlice["turns"][number]);
  }),
  saveSliceSnapshot: vi.fn(async () => {}),
  ensureIndexEntries: vi.fn(async () => {}),
}));

const maintenance = vi.hoisted(() => ({
  runUnifiedFlash: vi.fn(),
  readRecentSummaries: vi.fn(async () => []),
  applyMetadataUpdates: vi.fn((meta: Record<string, unknown>, updates: Record<string, unknown>) => {
    Object.assign(meta, updates);
  }),
}));

let timeSilent = false;

vi.mock("@/lib/episodic", () => episodic);
vi.mock("@/lib/episodic/slicer", () => ({
  checkTimeSilence: () => timeSilent,
}));
vi.mock("@/lib/episodic/maintenance", () => maintenance);

// The run's writable: housekeeping writes the start/start-step lifecycle
// chunks and flashRecall writes the data-flash recall card, so the mock
// collects everything written for assertions.
const workflowMock = vi.hoisted(() => {
  const written: Array<Record<string, unknown>> = [];
  return {
    written,
    getWritable: vi.fn(() => ({
      getWriter: () => ({
        write: async (chunk: unknown) => {
          written.push(chunk as Record<string, unknown>);
        },
        releaseLock: () => {},
      }),
    })),
  };
});

vi.mock("workflow", () => ({ getWritable: workflowMock.getWritable }));
vi.mock("@/lib/router", () => ({ classifyIntentKeywords: () => ({ intent: "chat", source: "keyword" }) }));
vi.mock("@/lib/memory/manager", () => ({ listNodes: () => [] }));
vi.mock("@/lib/memory/scorer", () => ({ rankNodes: () => [] }));
vi.mock("@/lib/context/assembler", () => ({ assembleContext: () => ({ prompt: "" }) }));
vi.mock("@/lib/identity", () => ({
  buildAgentIdentityPrompt: () => "",
  loadUserProfile: async () => ({}),
}));

import { housekeeping, flashRecall } from "@/app/api/chat/steps";

function makeSlice(overrides: Partial<TimeSlice> = {}): TimeSlice {
  return {
    slice_id: "2026-07-14-0900",
    focus: "",
    status: "active",
    start: "2026-07-14T09:00:00.000Z",
    timezone: "UTC",
    summary: "",
    open_loops: [],
    decisions: [],
    tags: [],
    related_slices: [],
    loops: [],
    turns: [],
    estimatedTokens: 0,
    ...overrides,
  };
}

function makeInput(lastUserMessage: string): TurnInput {
  return {
    modelMessages: [],
    recentTurns: [],
    lastUserMessage,
    model: "deepseek-v4-flash",
    thinking: true,
    clientTimezone: "UTC",
    config: {
      slicing: { maxTurnsPerSlice: 40, timeSilenceMinutes: 30 },
      context: { recentTurnsLimit: 20, tokenBudget: 12000 },
      model: { provider: "deepseek-v4-flash", thinking: true },
    },
    owner: "local",
    repo: "local",
    startedAtIso: "2026-07-14T10:00:00.000Z",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  workflowMock.written.length = 0;
  timeSilent = false;
});

describe("housekeeping step", () => {
  it("creates a fresh slice when none is on disk and returns it by value", async () => {
    episodic.tryLoadTodaySlice.mockResolvedValue(null);
    episodic.createSlice.mockImplementation((msg: string) =>
      makeSlice({ turns: [{ timestamp: "t", role: "user", content: msg }] })
    );

    const { slice } = await housekeeping(makeInput("hello world"));

    expect(episodic.createSlice).toHaveBeenCalledWith("hello world", "UTC");
    expect(slice.turns).toHaveLength(1);
    expect(slice.turns[0].content).toBe("hello world");
    // Durably snapshotted before returning (was fire-and-forget in the old route).
    expect(episodic.saveSliceSnapshot).toHaveBeenCalledWith(slice);
    expect(episodic.ensureIndexEntries).toHaveBeenCalledWith(slice);
    expect(episodic.appendTurn).not.toHaveBeenCalled();
    // Opens the UI stream: lifecycle chunks live in the durable run stream so
    // the POST and reconnect paths replay identical chunk sequences.
    expect(workflowMock.written.map((c) => c.type)).toEqual(["start", "start-step"]);
  });

  it("restores an active slice and appends the new user turn", async () => {
    const disk = makeSlice({
      turns: [
        { timestamp: "t0", role: "user", content: "earlier" },
        { timestamp: "t1", role: "agent", content: "reply" },
      ],
    });
    episodic.tryLoadTodaySlice.mockResolvedValue(disk);

    const { slice } = await housekeeping(makeInput("follow up"));

    expect(episodic.createSlice).not.toHaveBeenCalled();
    expect(episodic.closeSlice).not.toHaveBeenCalled();
    expect(slice.slice_id).toBe(disk.slice_id);
    expect(slice.turns).toHaveLength(3);
    expect(slice.turns[2].content).toBe("follow up");
    expect(episodic.saveSliceSnapshot).toHaveBeenCalledWith(slice);
  });

  it("closes a stale slice on time silence and starts a new one", async () => {
    timeSilent = true;
    const disk = makeSlice({ turns: [{ timestamp: "t0", role: "user", content: "old" }] });
    episodic.tryLoadTodaySlice.mockResolvedValue(disk);
    episodic.createSlice.mockImplementation((msg: string) =>
      makeSlice({ slice_id: "2026-07-14-1000", turns: [{ timestamp: "t", role: "user", content: msg }] })
    );

    const { slice } = await housekeeping(makeInput("new topic"));

    expect(episodic.closeSlice).toHaveBeenCalledWith(disk, "time_silence");
    expect(slice.slice_id).toBe("2026-07-14-1000");
  });

  it("force-closes on turn cap and starts a new one", async () => {
    const disk = makeSlice({
      turns: Array.from({ length: 40 }, (_, i) => ({ timestamp: `t${i}`, role: "user" as const, content: `m${i}` })),
    });
    episodic.tryLoadTodaySlice.mockResolvedValue(disk);
    episodic.createSlice.mockImplementation((msg: string) =>
      makeSlice({ slice_id: "2026-07-14-1100", turns: [{ timestamp: "t", role: "user", content: msg }] })
    );

    const { slice } = await housekeeping(makeInput("keep going"));

    expect(episodic.closeSlice).toHaveBeenCalledWith(disk, "capacity");
    expect(slice.slice_id).toBe("2026-07-14-1100");
  });
});

describe("flashRecall step", () => {
  it("applies Flash metadata updates onto the slice and returns it by value", async () => {
    const slice = makeSlice();
    maintenance.runUnifiedFlash.mockResolvedValue({
      intent: "coding",
      confidence: 0.8,
      suggested_topics: ["rust"],
      recall_hits: [{ slice_id: "2026-07-01-1200", relevance: 0.9, reason: "prior rust talk" }],
      needs_metadata_update: true,
      metadata_updates: { focus: "rust borrow checker", tags: ["rust"] },
      reasoning: "matched",
    });

    const result = await flashRecall(makeInput("rust question"), slice);

    expect(result.slice.focus).toBe("rust borrow checker");
    expect(result.slice.tags).toContain("rust");
    expect(result.flashOutput?.intent).toBe("coding");
    expect(typeof result.flashMs).toBe("number");
    // The recall card is written into the run stream ahead of the agent.
    const flashChunk = workflowMock.written.find((c) => c.type === "data-flash");
    expect(flashChunk).toBeDefined();
    expect((flashChunk?.data as { recall_hits: unknown[] }).recall_hits).toHaveLength(1);
  });

  it("degrades gracefully when Flash throws — null output, slice untouched", async () => {
    const slice = makeSlice({ focus: "unchanged" });
    maintenance.runUnifiedFlash.mockRejectedValue(new Error("flash down"));

    const result = await flashRecall(makeInput("anything"), slice);

    expect(result.flashOutput).toBeNull();
    expect(result.slice.focus).toBe("unchanged");
    expect(typeof result.flashMs).toBe("number");
    // No Flash output → no recall card chunk.
    expect(workflowMock.written.find((c) => c.type === "data-flash")).toBeUndefined();
  });
});
