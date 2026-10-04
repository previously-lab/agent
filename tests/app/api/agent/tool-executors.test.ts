/**
 * Tool executors — currentTime / describeRoom / webSearch / viewImage over an
 * in-memory local fs (the memory-read executors moved to docs-tools.test.ts).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const local = vi.hoisted(() => {
  const files = new Map<string, string>();
  return {
    files,
    readFileLocal: async (p: string) => {
      if (!files.has(p)) throw new Error(`File not found: "${p}"`);
      return files.get(p)!;
    },
  };
});

vi.mock("@/lib/tools/local-fs", () => ({
  readFileLocal: (p: string) => local.readFileLocal(p),
  listFilesLocal: vi.fn(async () => []),
  writeFileLocal: vi.fn(async () => ({ path: "", created: false })),
}));
vi.mock("@/lib/tools/readFile", () => ({
  readFile: vi.fn(async () => {
    throw new Error("github read should not be called in local mode");
  }),
  readFileFresh: vi.fn(async () => {
    throw new Error("github read should not be called in local mode");
  }),
  invalidateReadCache: vi.fn(),
}));
vi.mock("@/lib/demo/demo-fs", () => ({
  readFileDemo: vi.fn(async () => {
    throw new Error("demo read should not be called in local mode");
  }),
  listFilesDemo: vi.fn(async () => []),
}));
vi.mock("@/lib/config/loader", () => ({
  loadUserConfig: vi.fn(async () => ({
    slicing: { maxSliceMinutes: 30, maxTurnsPerSlice: 50, idleGapMinutes: 15 },
  })),
}));

// readStrands / playbook / sub-agent-model — mocked so the executor tests run
// without GitHub or model calls.
const deps = vi.hoisted(() => ({
  readStrands: vi.fn(async () => ({})),
  readPlaybook: vi.fn(async () => null),
  resolveSubAgentModel: vi.fn(async () => ({ id: "test-model" })),
}));
vi.mock("@/lib/episodic", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/episodic")>();
  return {
    ...actual,
    readStrands: deps.readStrands,
  };
});
vi.mock("@/lib/evolution/store", () => ({
  readPlaybook: deps.readPlaybook,
  capPlaybook: (s: string) => s,
}));
vi.mock("@/lib/episodic/rework-signal", () => ({
  checkDocRework: vi.fn(),
  recordDocRead: vi.fn(),
  logDocReworkSignal: vi.fn(),
}));
vi.mock("@/lib/agents/sub-agent-runner", () => ({
  resolveSubAgentModel: deps.resolveSubAgentModel,
}));
vi.mock("@/lib/chat/step-timeout", () => ({
  // Passthrough: run the work immediately and report success.
  withStepTimeout: vi.fn(
    async (fn: () => Promise<unknown>) => ({
      ok: true,
      timedOut: false,
      result: await fn(),
      elapsedMs: 1,
    }),
  ),
  StepTimeoutError: class StepTimeoutError extends Error {},
}));

// The workflow run writable — captured so tests can assert the data-* chunks
// the executors stream to the client (data-tool-progress).
const workflowMock = vi.hoisted(() => {
  const written: Array<{ type?: string; id?: string; data?: unknown }> = [];
  return {
    written,
    getWritable: vi.fn(() => ({
      getWriter: () => ({
        write: vi.fn(async (chunk: { type?: string; id?: string; data?: unknown }) => {
          written.push(chunk);
        }),
        releaseLock: vi.fn(),
      }),
    })),
  };
});
vi.mock("workflow", () => ({ getWritable: workflowMock.getWritable }));

// webSearchExecute dependencies — mocked so mode-threading tests drive
// searchViaFlash's call shape directly (no network / model calls).
const searchFlashDeps = vi.hoisted(() => ({
  searchViaFlash: vi.fn(),
}));
vi.mock("@/lib/search/flash-search", () => ({
  searchViaFlash: searchFlashDeps.searchViaFlash,
  SEARCH_TIMEOUT_MS: 240_000,
}));

const visionDeps = vi.hoisted(() => ({
  describeImage: vi.fn(),
}));
vi.mock("@/lib/vision/describe-image", () => ({
  describeImage: visionDeps.describeImage,
}));

import {
  currentTimeExecute,
  describeRoomExecute,
  webSearchExecute,
  viewImageExecute,
  type ToolContext,
} from "@/app/api/agent/tool-executors";

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    repo: "local",
    owner: "local",
    useGithub: false,
    useDemo: false,
    sliceId: "2026-08-11-1115",
    recentTurns: [],
    timezone: "Asia/Shanghai",
    ...overrides,
  };
}

/** The executor's second argument — ExecuteOpts<ToolContext> needs toolCallId. */
function opts(overrides: Partial<ToolContext> = {}): {
  context: ToolContext;
  toolCallId: string;
} {
  return { context: makeCtx(overrides), toolCallId: "tc1" };
}


describe("currentTimeExecute", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // 2026-08-22 is a Saturday; 08:35 in Asia/Shanghai (UTC+8).
    vi.setSystemTime(new Date("2026-08-22T00:35:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports local time + UTC and slice progress against the cap", async () => {
    const out = await currentTimeExecute(
      {},
      opts({ sliceId: "2026-08-22-0015", locale: "en" }),
    );
    expect(out).toContain("Now: 22 Aug 2026, 08:35");
    expect(out).toContain("Asia/Shanghai");
    expect(out).toContain("UTC+08:00");
    expect(out).toContain("UTC: 2026-08-22T00:35:00.000Z");
    expect(out).toContain("This slice (2026-08-22-0015)");
    expect(out).toContain("Started: 22 Aug 2026, 08:15");
    expect(out).toContain("Running for 20 min — 10 min left of the 30-minute cap");
  });

  it("includes a fresh date-anchor table with weekdays", async () => {
    const out = await currentTimeExecute(
      {},
      opts({ sliceId: "2026-08-22-0015", locale: "en" }),
    );
    expect(out).toContain("Date anchors:");
    expect(out).toContain("Today: 2026-08-22 (Sat)");
    expect(out).toContain("Tomorrow: 2026-08-23 (Sun)");
  });

  it("flags a slice that is past its time cap", async () => {
    vi.setSystemTime(new Date("2026-08-22T01:00:00.000Z"));
    const out = await currentTimeExecute(
      {},
      opts({ sliceId: "2026-08-22-0015", locale: "en" }),
    );
    expect(out).toContain("Running for 45 min — past the 30-minute cap");
  });

  it("still reports the clock when the slice id is unparseable", async () => {
    const out = await currentTimeExecute({}, opts({ sliceId: "bogus" }));
    expect(out).toContain("Now:");
    expect(out).not.toContain("This slice");
  });
});

describe("describeRoomExecute", () => {
  it("describes the current slice's room when sliceId is omitted", async () => {
    const out = await describeRoomExecute(
      {},
      opts({ sliceId: "2026-09-14-2207", locale: "en" }),
    );
    expect(out).toContain("Room outline · slice 2026-09-14-2207");
    expect(out).toContain("World:");
    expect(out).toContain("Palette:");
    expect(out).toContain("Doors:");
  });

  it("describes an explicit slice, localized by the turn locale", async () => {
    const out = await describeRoomExecute(
      { sliceId: "2026-09-12-0941" },
      opts({ locale: "zh" }),
    );
    expect(out).toContain("房间大纲 · slice 2026-09-12-0941");
    expect(out).toContain("入口在南墙");
  });

  it("is deterministic — the same slice yields the same outline", async () => {
    const a = await describeRoomExecute(
      { sliceId: "2026-09-13-1530" },
      opts({ locale: "en" }),
    );
    const b = await describeRoomExecute(
      { sliceId: "2026-09-13-1530" },
      opts({ locale: "en" }),
    );
    expect(b).toBe(a);
  });

  it("places strand doors when the runtime inputs are provided", async () => {
    const out = await describeRoomExecute(
      { sliceId: "2026-09-14-2207", strandDoors: 3, corridorSide: "north" },
      opts({ locale: "en" }),
    );
    expect(out).toContain("Placed strand doors (3)");
  });

  it("returns a domain error (never throws) for an invalid slice id", async () => {
    const out = await describeRoomExecute(
      { sliceId: "bogus" },
      opts({ locale: "en" }),
    );
    expect(out).toMatch(/^ERROR: Invalid slice ID/);
  });
});

describe("webSearchExecute mode threading", () => {
  beforeEach(() => {
    searchFlashDeps.searchViaFlash.mockReset();
    searchFlashDeps.searchViaFlash.mockResolvedValue({
      answer: "answer",
      sources: [],
      recommendation: "",
      suggestedReads: [],
    });
    vi.stubEnv("DEEPSEEK_API_KEY", "test-key");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("passes { scout: true } to searchViaFlash when mode is 'scout'", async () => {
    await webSearchExecute(
      { query: "best Rust web frameworks", mode: "scout" },
      { context: makeCtx(), toolCallId: "tc-web" },
    );
    expect(searchFlashDeps.searchViaFlash).toHaveBeenCalledTimes(1);
    const [, , , opts] = searchFlashDeps.searchViaFlash.mock.calls[0]!;
    expect(opts).toEqual({ scout: true });
  });

  it("passes { scout: false } to searchViaFlash when mode is 'standard'", async () => {
    await webSearchExecute(
      { query: "best Rust web frameworks", mode: "standard" },
      { context: makeCtx(), toolCallId: "tc-web" },
    );
    const [, , , opts] = searchFlashDeps.searchViaFlash.mock.calls[0]!;
    expect(opts).toEqual({ scout: false });
  });

  it("passes { scout: false } to searchViaFlash when mode is omitted", async () => {
    await webSearchExecute(
      { query: "best Rust web frameworks" },
      { context: makeCtx(), toolCallId: "tc-web" },
    );
    const [, , , opts] = searchFlashDeps.searchViaFlash.mock.calls[0]!;
    expect(opts).toEqual({ scout: false });
  });
});

describe("viewImageExecute", () => {
  beforeEach(() => {
    visionDeps.describeImage.mockReset();
  });

  const visionOk = {
    ok: true as const,
    description: "A red circle.",
    metadata: { format: "png" as const, width: 10, height: 10, bytes: 100 },
    degraded: false,
  };

  it("resolves attachment:N and returns the description with metadata", async () => {
    visionDeps.describeImage.mockResolvedValue(visionOk);

    const out = await viewImageExecute(
      { source: "attachment:0", question: "What color?" },
      opts({ imageAttachments: ["data:image/png;base64,xx"], locale: "en" }),
    );

    expect(out).toBe("A red circle.\n\n[image: 10×10 PNG, 100 B]");
    expect(visionDeps.describeImage).toHaveBeenCalledWith({
      image: { data: "data:image/png;base64,xx", mediaType: "image/png" },
      question: "What color?",
      locale: "en",
    });
  });

  it("resolves a URL source and returns the description", async () => {
    visionDeps.describeImage.mockResolvedValue({
      ...visionOk,
      description: "A cat.",
      metadata: { format: "jpeg", width: 640, height: 480, bytes: 2048 },
    });

    const out = await viewImageExecute(
      { source: "https://example.com/cat.png" },
      opts(),
    );

    expect(out).toBe("A cat.\n\n[image: 640×480 JPEG, 2.0 KB]");
    expect(visionDeps.describeImage).toHaveBeenCalledWith({
      image: { url: "https://example.com/cat.png" },
      question: undefined,
      locale: undefined,
    });
  });

  it("passes degraded results through transparently without appending metadata", async () => {
    visionDeps.describeImage.mockResolvedValue({
      ok: true,
      description:
        "[DEGRADED RESULT] The vision model is unavailable (DEEPSEEK_API_KEY is not set).\n" +
        "Image metadata: 10×10 PNG, 100 B.",
      metadata: { format: "png", width: 10, height: 10, bytes: 100 },
      degraded: true,
      reason: "DEEPSEEK_API_KEY is not set",
    });

    const out = await viewImageExecute(
      { source: "attachment:0" },
      opts({ imageAttachments: ["data:image/png;base64,xx"] }),
    );

    expect(out).toContain("DEGRADED");
    expect(out).toContain("10×10 PNG");
    // Not duplicated: the executor must not append a second metadata line.
    expect(out).not.toContain("[image:");
  });

  it("returns an error string for an out-of-range attachment index", async () => {
    const out = await viewImageExecute(
      { source: "attachment:2" },
      opts({ imageAttachments: ["data:image/png;base64,a"] }),
    );
    expect(out).toContain("Invalid attachment index");
    expect(visionDeps.describeImage).not.toHaveBeenCalled();
  });

  it("returns an error string when describeImage fails", async () => {
    visionDeps.describeImage.mockResolvedValue({
      ok: false,
      error: "ERROR: Could not fetch image: network down",
    });

    const out = await viewImageExecute(
      { source: "https://example.com/x.png" },
      opts(),
    );

    expect(out).toContain("network down");
  });
});
