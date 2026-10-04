import { describe, it, expect, beforeEach, vi } from "vitest";
import type { TimeSlice } from "@/lib/episodic";
import type { TurnInput, TurnOutcome } from "@/lib/chat/turn-types";

// ── Mock the step dependencies ──────────────────────────────────────────

/**
 * The fake disk: slice cores/mailboxes, the tasks shelf, and the slice-dir
 * registry. The disk scans in steps.ts (v0.19 A1 — no projections) read
 * through the mocked fs/episode seams below, so a test steers "what is on
 * disk" purely by seeding these maps. Slice core content is the JSON of the
 * TimeSlice object (the parseSlice mock is JSON.parse).
 */
const fakeDisk = vi.hoisted(() => {
  const files = new Map<string, string>();
  const sliceIds = new Set<string>(); // dashed ids with a dir on disk
  const taskDirs = new Set<string>(); // task case names under memory/tasks

  const persistSlice = (slice: TimeSlice) => {
    sliceIds.add(slice.slice_id);
    files.set(`${slice.slice_id}:core`, JSON.stringify(slice));
  };
  /** The default tryLoadTodaySlice: newest ACTIVE slice on the fake disk. */
  const loadToday = async (): Promise<TimeSlice | null> => {
    const actives = [...sliceIds]
      .map((id) => {
        const raw = files.get(`${id}:core`);
        return raw ? (JSON.parse(raw) as TimeSlice) : null;
      })
      .filter((s): s is TimeSlice => !!s && s.status === "active")
      .sort((a, b) => b.slice_id.localeCompare(a.slice_id));
    return actives[0] ?? null;
  };
  return { files, sliceIds, taskDirs, persistSlice, loadToday };
});

const episodic = vi.hoisted(() => ({
  RECORDS_ROOT: "memory/records",
  LEGACY_SLICES_ROOT: "memory/episodic/slices",
  createBatch: vi.fn(() => ({ entries: new Map<string, string>() })),
  flushBatch: vi.fn(async (_batch: unknown, _msg: string) => {}),
  sliceIdToFilePath: vi.fn(
    (sliceId: string) => `memory/records/${sliceId.replace(/-/g, "/")}/core.md`,
  ),
  sliceIdToAgentPath: vi.fn((sliceId: string) => `${sliceId}:agent`),
  slicePartPathCandidates: vi.fn(
    (sliceId: string, part: string) =>
      [`memory/records/${sliceId}/${part}.md`, `legacy/${sliceId}/${part}.md`] as [string, string],
  ),
  tryLoadTodaySlice: vi.fn(),
  createSlice: vi.fn((msg: string, tz: string, turnId?: string, continuesFrom?: string) =>
    makeSlice({
      turns: [{ timestamp: "t", role: "user", content: msg, turnId }],
      ...(continuesFrom ? { continuesFrom } : {}),
    })
  ),
  closeSlice: vi.fn(async (slice: TimeSlice, signal: string) => {
    // Mirror the real close: mutate + persist (saveSliceSnapshot-style), so a
    // redelivered run re-reads the closed state from the fake disk.
    slice.status = "closed";
    (slice as { closedBy?: string }).closedBy = signal;
    slice.end = slice.turns.at(-1)?.timestamp;
    fakeDisk.persistSlice(slice);
    return slice;
  }),
  loadSlice: vi.fn(async (): Promise<TimeSlice | null> => null),
  appendTurn: vi.fn((slice: TimeSlice, turn: unknown) => {
    slice.turns.push(turn as TimeSlice["turns"][number]);
  }),
  saveSliceSnapshot: vi.fn(async (slice: TimeSlice) => {
    fakeDisk.persistSlice(slice);
  }),
  writeAgentTimeline: vi.fn(async (sliceId: string, content: string) => {
    const key = `${sliceId}:agent`;
    const existing = fakeDisk.files.get(key);
    fakeDisk.files.set(key, existing ? `${existing.trimEnd()}\n\n${content}` : content);
    return { path: key, created: !existing };
  }),
  ensurePreviously: vi.fn(async (sliceId: string) => `# Previously On\n\n_Active slice: ${sliceId} | Updated: ..._\n`),
  readStrands: vi.fn(async () => ({})),
  readCurrentPreviously: vi.fn(async () => ""),
  // v0.19 R4 snapshot semantics: the slice's previously.md freezes the FULL
  // folded user model. Reads hit the fake disk; fresh-deploy seeding misses.
  readPreviously: vi.fn(async (sliceId: string) => {
    const v = fakeDisk.files.get(`${sliceId}:previously`);
    return v ?? "";
  }),
  writePreviously: vi.fn(async (sliceId: string, content: string) => {
    fakeDisk.files.set(`${sliceId}:previously`, content);
  }),
  findMostRecentPreviously: vi.fn(async (): Promise<string | null> => null),
  deterministicSliceMark: vi.fn(() => ({ focus: "fallback focus", summary: "fallback summary" })),
  analyzeTurn: vi.fn(),
  // Dual-root disk reads against the fake disk.
  readSlicePart: vi.fn(async (sliceId: string, part: string) => {
    const v = fakeDisk.files.get(`${sliceId}:${part}`);
    if (v === undefined) throw new Error(`missing ${sliceId}:${part}`);
    return v;
  }),
  readSlicePartResolved: vi.fn(async (sliceId: string, part: string) => {
    const v = fakeDisk.files.get(`${sliceId}:${part}`);
    return v === undefined ? null : { path: `${sliceId}:${part}`, content: v };
  }),
  parseSlice: vi.fn((raw: string) => JSON.parse(raw) as TimeSlice),
  // ── Retired-projection tripwires (v0.19 A1): nothing in the turn path may
  // call these anymore. The mocks exist purely so tests can assert silence.
  weaveTimeline: vi.fn(async () => ({ skipped: true })),
  readTimelineIndex: vi.fn(async () => null),
  buildTimelineBrief: vi.fn(() => ""),
  upsertTimelineEntry: vi.fn(async () => {}),
  generateGlobalTimeline: vi.fn(async () => ""),
}));

vi.mock("@/lib/episodic", () => episodic);

// dayDirForDate is pure in production; here it pins every "today/yesterday"
// day-dir scan to the fixed fake-disk day so the dir names line up with the
// seeded slice ids.
vi.mock("@/lib/episodic/paths", () => ({
  dayDirForDate: (root: string, _d: Date) => `${root}/2026/07/14`,
  // attachments.ts resolves the records case dir through this.
  sliceDir: (sliceId: string) =>
    `memory/records/${sliceId.replace(/-/g, "/")}`,
}));

const enumerate = vi.hoisted(() => ({
  enumerateSliceIds: vi.fn(async (): Promise<string[]> => []),
}));
vi.mock("@/lib/episodic/timeline/enumerate", () => enumerate);

const ioHelpers = vi.hoisted(() => ({
  fsListFiles: vi.fn(async (path: string) => {
    if (path === "memory/tasks") {
      return [...fakeDisk.taskDirs].map((n) => ({
        name: n,
        type: "dir" as const,
        path: `memory/tasks/${n}`,
      }));
    }
    if (/\d{4}\/\d{2}\/\d{2}$/.test(path)) {
      // A day dir: one dir entry per registered slice id (name = HHMM).
      return [...fakeDisk.sliceIds].map((id) => ({
        name: id.slice(-4),
        type: "dir" as const,
        path: `${path}/${id.slice(-4)}`,
      }));
    }
    return [];
  }),
  fsReadFile: vi.fn(async (path: string) => {
    const v = fakeDisk.files.get(path);
    if (v === undefined) throw new Error(`missing ${path}`);
    return v;
  }),
  fsWriteFile: vi.fn(async (path: string, content: string) => {
    fakeDisk.files.set(path, content);
    return { path, created: true };
  }),
  fsWriteBinaryFile: vi.fn(async (path: string, data: Buffer) => {
    fakeDisk.files.set(path, `bin:${data.toString("base64")}`);
    return { path, created: true };
  }),
  fsReadBinaryFile: vi.fn(async (path: string) => {
    const v = fakeDisk.files.get(path);
    if (v === undefined) throw new Error(`missing ${path}`);
    return Buffer.from(v);
  }),
}));
vi.mock("@/lib/episodic/io-helpers", () => ioHelpers);

// v0.21 §A.2.2: the turn path no longer starts boundary/question runs, posts
// [boundary-event] lines, or runs marker-consuming scribe passes — steps.ts
// imports none of those modules anymore, so no mocks are needed for them
// here. The disk-level proof is the retired-chain test below ("a closed
// predecessor's mailbox is never touched"); the code-level proof is the
// import list itself.

// The inline card evolution is mocked at its module boundary so the explicit
// channel can be asserted directly.
const evolution = vi.hoisted(() => ({
  runCardEvolution: vi.fn(
    async (_input: {
      sliceId?: string;
      signal?: string;
      focus?: string;
      triggeredBuckets?: string[];
      allowedSopWrites?: string[];
      onProgress?: (step: "reading" | "reviewing" | "applied") => void;
      onEvolutionLine?: (line: string, stage: "thinking" | "writing") => void;
    }): Promise<{
      ran: boolean;
      changed: boolean;
      droppedRecent: number;
      note: string;
      summary?: string;
      partial?: boolean;
      error?: string;
    }> => ({ ran: true, changed: false, droppedRecent: 0, note: "reviewed" }),
  ),
}));
vi.mock("@/app/api/evolution/run-card-evolution", () => evolution);

// Phase-level bridge outsourcing — runHousekeepingBridge /
// applyBridgeCardEvolution are replaced with fakes (the report under test is
// injected verbatim); the report adapter stays REAL.
const bridgePhases = vi.hoisted(() => ({
  runHousekeepingBridge: vi.fn(),
  applyBridgeCardEvolution: vi.fn(
    async (_input: {
      card: string;
      sliceId: string;
      today: string;
      reason: string;
      mutations: unknown[];
    }): Promise<{
      ran: boolean;
      changed: boolean;
      droppedRecent: number;
      note: string;
      summary?: string;
    }> => ({ ran: true, changed: true, droppedRecent: 0, note: "applied", summary: "card moved" }),
  ),
}));
vi.mock("@/lib/bridge-phases", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/bridge-phases")>();
  return {
    ...actual,
    runHousekeepingBridge: bridgePhases.runHousekeepingBridge,
    applyBridgeCardEvolution: bridgePhases.applyBridgeCardEvolution,
  };
});

const slicer = vi.hoisted(() => ({
  checkSliceAge: vi.fn((_startIso: string, _maxMs: number) => false),
  checkIdleGap: vi.fn((_lastTurnIso: string, _maxMs: number) => false),
}));
vi.mock("@/lib/episodic/slicer", () => slicer);

// The evolution store reads are mocked (the real ones hit the fs): the folded
// user model (card + direction halves) and the user's profile. The default is
// "fresh deployment" — no model, no profile.
const evolutionStore = vi.hoisted(() => ({
  readDirection: vi.fn(async (): Promise<string | null> => null),
  readUserModel: vi.fn(
    async (): Promise<{ card: string; direction: string | null; full: string } | null> =>
      null,
  ),
  readUserProfile: vi.fn(async (): Promise<string | null> => null),
}));
vi.mock("@/lib/evolution/store", () => evolutionStore);
// Partial mock: bridge-phases (importOriginal'd) needs the module's schemas —
// only the system-prompt layer builder is replaced.
vi.mock("@/lib/evolution/direction-agent", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/evolution/direction-agent")>();
  return {
    ...actual,
    buildDirectionBlock: (direction: string | null): string =>
      direction
        ? `## Direction — who the user is (evolved portrait)\n\n${direction}`
        : "",
  };
});

// Mock AI SDK for any sub-agent going through the unified runner.
vi.mock("ai", async () => {
  const actual = await vi.importActual("ai");
  return {
    ...actual,
    generateText: vi.fn(async () => ({ toolCalls: [] })),
    streamText: vi.fn(async () => ({
      text: Promise.resolve(""),
      toolCalls: Promise.resolve([]),
      reasoningText: Promise.resolve(undefined),
      sources: Promise.resolve([]),
      warnings: Promise.resolve([]),
    })),
  };
});

vi.mock("@ai-sdk/openai-compatible", () => ({
  createOpenAICompatible: vi.fn(
    () => (id: string) => ({ modelId: id }),
  ),
}));

// The run's writable: collects everything written for assertions.
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
      close: async () => {},
    })),
  };
});

vi.mock("workflow", () => ({ getWritable: workflowMock.getWritable }));

import {
  housekeeping,
  persistAgentTurn,
  explicitEvolutionSegment,
  closeTurnStream,
} from "@/app/api/chat/steps";

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
    emotional_tone: "neutral",
    ...overrides,
  };
}

function makeInput(lastUserMessage: string, overrides: Partial<TurnInput> = {}): TurnInput {
  return {
    modelMessages: [],
    recentTurns: [],
    lastUserMessage,
    model: "deepseek-v4-flash",
    modelConfig: {
      id: "deepseek-v4-flash",
      name: "DeepSeek V4 Flash",
      provider: "deepseek",
      providerName: "DeepSeek",
      sdk: "deepseek",
      envKey: "DEEPSEEK_API_KEY",
      capabilities: { thinking: true, vision: false, maxTokens: 393216 },
      defaultThinking: false,
      defaultEffort: "low",
    },
    thinking: true,
    reasoningEffort: "medium" as const,
    clientTimezone: "UTC",
    locale: "en",
    config: {
      slicing: { maxSliceMinutes: 30, maxTurnsPerSlice: 40, idleGapMinutes: 15 },
      model: { provider: "deepseek-v4-flash", thinking: true, reasoningEffort: "medium" as const },
    },
    owner: "local",
    repo: "local",
    useGithub: false,
    useDemo: false,
    startedAtIso: "2026-07-14T10:00:00.000Z",
    turnId: "test-id",
    imageAttachments: [],
    ...overrides,
  };
}

/** Base analyzer verdict (no explicit update, no closed marking). */
function baseAnalysis() {
  return {
    semanticHint: { strands: [], reason: "" },
    memoryWorthy: true,
    emotionalSignal: { intensity: "none", register: "neutral", note: "" },
  };
}

/** Seed an aged ACTIVE slice on the fake disk and return it. */
function seedAgedActiveSlice(overrides: Partial<TimeSlice> = {}) {
  const disk = makeSlice(overrides);
  fakeDisk.persistSlice(disk);
  slicer.checkSliceAge.mockImplementation(
    (startIso: string) => startIso === disk.start,
  );
  return disk;
}

/** createSlice impl that honors the production 4th arg (continuesFrom).
 *  Start time is derived from the slice id's HHMM segment so a re-created
 *  slice (kill-replay path) is never judged stale by its own start. */
function mockCreateSlice(newSliceId: string) {
  const hhmm = newSliceId.split("-")[3] ?? "1000";
  const start = `2026-07-14T${hhmm.slice(0, 2)}:${hhmm.slice(2)}:00.000Z`;
  episodic.createSlice.mockImplementation(
    (msg: string, _tz: string, turnId?: string, continuesFrom?: string) =>
      makeSlice({
        slice_id: newSliceId,
        start,
        turns: [{ timestamp: "t", role: "user", content: msg, turnId }],
        ...(continuesFrom ? { continuesFrom } : {}),
      }),
  );
}

/** Run the post-reply explicit-instruction channel (序 6) the way the workflow
 *  does — the housekeeping result threads through BY VALUE (EntryReckoning). */
async function runExplicitEvolution(
  input: TurnInput,
  hk: Awaited<ReturnType<typeof housekeeping>>,
) {
  await explicitEvolutionSegment(input, hk);
}

beforeEach(() => {
  vi.clearAllMocks();
  workflowMock.written.length = 0;
  fakeDisk.files.clear();
  fakeDisk.sliceIds.clear();
  fakeDisk.taskDirs.clear();
  episodic.tryLoadTodaySlice.mockImplementation(fakeDisk.loadToday);
  episodic.createSlice.mockImplementation(
    (msg: string, _tz: string, turnId?: string, continuesFrom?: string) =>
      makeSlice({
        turns: [{ timestamp: "t", role: "user", content: msg, turnId }],
        ...(continuesFrom ? { continuesFrom } : {}),
      }),
  );
  slicer.checkSliceAge.mockReturnValue(false);
  slicer.checkIdleGap.mockReturnValue(false);
  episodic.analyzeTurn.mockResolvedValue(baseAnalysis());
  enumerate.enumerateSliceIds.mockResolvedValue([]);
  evolutionStore.readDirection.mockResolvedValue(null);
});

describe("housekeeping step (进场那一拍 — the entry beat)", () => {
  it("persists the turn's evidence attachments into the records case and records the names on the user turn (v0.19 §C.1)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const pngDataUrl = `data:image/png;base64,${Buffer.from("png-bytes").toString("base64")}`;
    try {
      const hk = await housekeeping(
        makeInput("look at this", {
          modelMessages: [
            {
              role: "user",
              content: [
                { type: "text", text: "look at this" },
                { type: "file", data: pngDataUrl, mediaType: "image/png", filename: "shot.png" },
              ],
            },
          ] as unknown as TurnInput["modelMessages"],
        }),
      );

      // The bytes landed under the slice's attachments dir, turnId-prefixed.
      const saved = [...fakeDisk.files.keys()].filter((k) => k.includes("/attachments/"));
      expect(saved).toEqual(["memory/records/2026/07/14/0900/attachments/test-id-shot.png"]);
      // core.md's turn points at its own evidence.
      const userTurn = hk.slice.turns.find((t) => t.role === "user");
      expect(userTurn?.content).toContain("[attachments: test-id-shot.png]");
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("a redelivery does NOT re-persist attachments (userTurnRecorded skips the whole block)", async () => {
    const pngDataUrl = `data:image/png;base64,${Buffer.from("png-bytes").toString("base64")}`;
    const input = makeInput("look at this", {
      modelMessages: [
        {
          role: "user",
          content: [
            { type: "file", data: pngDataUrl, mediaType: "image/png", filename: "shot.png" },
          ],
        },
      ] as unknown as TurnInput["modelMessages"],
    });
    await housekeeping(input);
    const savedOnce = [...fakeDisk.files.keys()].filter((k) => k.includes("/attachments/"));
    expect(savedOnce).toHaveLength(1);

    // Second delivery of the SAME turn: the user turn is already recorded.
    const hk2 = await housekeeping(input);
    expect([...fakeDisk.files.keys()].filter((k) => k.includes("/attachments/"))).toEqual(savedOnce);
    const userTurn = hk2.slice.turns.find((t) => t.role === "user");
    expect(userTurn?.content.match(/\[attachments:/g)).toHaveLength(1);
  });

  it("an over-fuse attachment is skipped with a visible reason, never thrown", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const big = Buffer.alloc(5 * 1024 * 1024 + 1, 1);
    const bigDataUrl = `data:application/pdf;base64,${big.toString("base64")}`;
    try {
      await housekeeping(
        makeInput("big file", {
          modelMessages: [
            {
              role: "user",
              content: [
                { type: "file", data: bigDataUrl, mediaType: "application/pdf", filename: "big.pdf" },
              ],
            },
          ] as unknown as TurnInput["modelMessages"],
        }),
      );
      expect([...fakeDisk.files.keys()].some((k) => k.includes("/attachments/"))).toBe(false);
      expect(
        warnSpy.mock.calls.some(
          (c) => typeof c[0] === "string" && c[0].includes("[Attachments] skipped big.pdf"),
        ),
      ).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("§A.3.3: a tasks/ tail line dated today becomes the dueTasksBlock; yesterday's does not", async () => {
    const { createCase, closeDoc, serializeCaseDoc } = await import("@/lib/docs");
    const closedToday = closeDoc(
      createCase({
        category: "tasks",
        caseName: "后台回复",
        opened: "2026-07-14",
        body: "后台流的完成通知册。",
      }),
      { date: "2026-07-14", note: "查了：手机话题 —— 结果已写入 research/手机话题演变/index.md。" },
    );
    fakeDisk.taskDirs.add("后台回复");
    fakeDisk.files.set("memory/tasks/后台回复/index.md", serializeCaseDoc(closedToday));
    const closedYesterday = closeDoc(
      createCase({
        category: "tasks",
        caseName: "旧账",
        opened: "2026-07-10",
        body: "旧任务。",
      }),
      { date: "2026-07-13", note: "昨天的结案行不该再陈述。" },
    );
    fakeDisk.taskDirs.add("旧账");
    fakeDisk.files.set("memory/tasks/旧账/index.md", serializeCaseDoc(closedYesterday));

    const hk = await housekeeping(makeInput("hi"));

    expect(hk.dueTasksBlock).toBeDefined();
    expect(hk.dueTasksBlock).toContain("tasks/后台回复");
    expect(hk.dueTasksBlock).toContain("查了：手机话题");
    expect(hk.dueTasksBlock).toContain("state it, don't promise");
    expect(hk.dueTasksBlock).not.toContain("旧账");
  });

  it("creates a fresh slice when none is on disk and returns it by value", async () => {
    const { slice } = await housekeeping(makeInput("hello world"));

    expect(episodic.createSlice).toHaveBeenCalledWith("hello world", "UTC", "test-id");
    expect(slice.turns).toHaveLength(1);
    expect(slice.turns[0].content).toBe("hello world");
    expect(episodic.saveSliceSnapshot).toHaveBeenCalledWith(slice, expect.anything());
    expect(episodic.appendTurn).not.toHaveBeenCalled();

    // Compact housekeeping phases (slice / analyze / context × running+done)
    // then the stream lifecycle chunks. The analyze phase runs in the entry
    // beat now (v0.21 §3): ONE derivation per non-demo turn — with nothing to
    // close here it carries no closing slice (zero 归纳, its memoryUpdate
    // reading still feeds 序 6). No slice-closed row: nothing ended.
    expect(workflowMock.written.map((c) => c.type)).toEqual([
      ...Array(6).fill("data-phase"),
      "start",
      "start-step",
    ]);
    const phases = workflowMock.written
      .filter((c) => c.type === "data-phase")
      .map((c) => (c.data as { phase: string; running: boolean; compact?: boolean }));
    expect(phases.map((p) => `${p.phase}:${p.running}`)).toEqual([
      "slice:true",
      "analyze:true",
      "analyze:false",
      "slice:false",
      "context:true",
      "context:false",
    ]);
    expect(phases.every((p) => p.compact === true)).toBe(true);
  });

  it("the entry beat's ONE derivation reads the ended page and closes it in the same beat — zero projection writes (v0.21 §3, v0.19 A1)", async () => {
    seedAgedActiveSlice({
      turns: [{ timestamp: "t0", role: "user", content: "old" }],
    });
    mockCreateSlice("2026-07-14-1000");

    await housekeeping(makeInput("new topic"));

    // The turn's ONE semantic derivation: the ended page's turns are its input
    // (never this turn's message as the summarization object).
    expect(episodic.analyzeTurn).toHaveBeenCalledOnce();
    const analyzeArgs = episodic.analyzeTurn.mock.calls[0][0] as {
      userMessage: string;
      closingSlice?: { turns: unknown[] };
    };
    expect(analyzeArgs.userMessage).toBe("new topic");
    expect(analyzeArgs.closingSlice?.turns).toHaveLength(1);
    // The close is DECIDED and EXECUTED in the same beat (atomic with the
    // beat's one commit) — no post-reply segment owns it anymore.
    expect(episodic.closeSlice).toHaveBeenCalledOnce();
    expect(episodic.closeSlice.mock.calls[0][1]).toBe("time_cap");
    expect(
      episodic.analyzeTurn.mock.invocationCallOrder[0],
    ).toBeLessThan(episodic.closeSlice.mock.invocationCallOrder[0]);
    // No evolution here — that is the post-reply explicit channel (序 6), and
    // this message carries no explicit instruction anyway.
    expect(bridgePhases.runHousekeepingBridge).not.toHaveBeenCalled();
    expect(evolution.runCardEvolution).not.toHaveBeenCalled();
    // No projection writes / catalog reads on the turn path.
    expect(episodic.weaveTimeline).not.toHaveBeenCalled();
    expect(episodic.upsertTimelineEntry).not.toHaveBeenCalled();
    expect(episodic.generateGlobalTimeline).not.toHaveBeenCalled();
    expect(episodic.readTimelineIndex).not.toHaveBeenCalled();
    expect(episodic.buildTimelineBrief).not.toHaveBeenCalled();
  });

  it("restores an active slice and appends the new user turn", async () => {
    fakeDisk.persistSlice(makeSlice({
      turns: [
        { timestamp: "t0", role: "user", content: "earlier" },
        { timestamp: "t1", role: "agent", content: "reply" },
      ],
    }));

    // Client history matches the slice (its user turns are the aligned tail)
    // — no rebuild, plain restore. Like production, the history ENDS with
    // the current user message.
    const input = makeInput("follow up", {
      modelMessages: [
        { role: "user", content: "earlier" },
        { role: "assistant", content: "reply" },
        { role: "user", content: "follow up" },
      ] as unknown as TurnInput["modelMessages"],
    });
    const { slice, rebuiltHistory } = await housekeeping(input);

    expect(episodic.createSlice).not.toHaveBeenCalled();
    expect(slice.slice_id).toBe("2026-07-14-0900");
    expect(slice.turns).toHaveLength(3);
    expect(slice.turns[2].content).toBe("follow up");
    expect(rebuiltHistory).toBeUndefined();
    expect(episodic.saveSliceSnapshot).toHaveBeenCalledWith(slice, expect.anything());
  });

  it("refresh within the idle gap keeps the slice open and rebuilds the window from the slice's turns", async () => {
    fakeDisk.persistSlice(makeSlice({
      turns: [
        { timestamp: "t0", role: "user", content: "earlier" },
        { timestamp: "t1", role: "agent", content: "reply" },
        { timestamp: "t2", role: "user", content: "another" },
        { timestamp: "t3", role: "agent", content: "reply2" },
      ],
    }));

    // Page refresh: the client sends ONLY the new user message (no assistant
    // history) — the slice must NOT close; the window is rebuilt from the
    // slice's own turns instead.
    const input = makeInput("new after refresh");
    const { slice, rebuiltHistory } = await housekeeping(input);

    expect(episodic.createSlice).not.toHaveBeenCalled();
    expect(slice.slice_id).toBe("2026-07-14-0900");
    // The user turn append proceeds normally; the rebuilt window carries the
    // whole slice (current message included, appended once).
    expect(slice.turns).toHaveLength(5);
    expect(rebuiltHistory).toEqual([
      { role: "user", content: "earlier" },
      { role: "assistant", content: "reply" },
      { role: "user", content: "another" },
      { role: "assistant", content: "reply2" },
      { role: "user", content: "new after refresh" },
    ]);
  });

  it("stale writes (client has turns the slice never recorded) still trust the slice", async () => {
    fakeDisk.persistSlice(makeSlice({
      turns: [
        { timestamp: "t0", role: "user", content: "q1" },
        { timestamp: "t1", role: "agent", content: "a1" },
      ],
    }));

    // The client's recent tail diverges from the slice (a write that never
    // landed) — the slice is authoritative, not closed, and the unsaved
    // turns do NOT leak into the rebuilt window. The history ends with the
    // current message, as production sends it.
    const input = makeInput("current", {
      modelMessages: [
        { role: "user", content: "q1" },
        { role: "assistant", content: "a1" },
        { role: "user", content: "unsaved question" },
        { role: "assistant", content: "unsaved reply" },
        { role: "user", content: "current" },
      ] as unknown as TurnInput["modelMessages"],
    });
    const { slice, rebuiltHistory } = await housekeeping(input);

    expect(slice.slice_id).toBe("2026-07-14-0900");
    expect(rebuiltHistory).toEqual([
      { role: "user", content: "q1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "current" },
    ]);
  });

  it("regenerate: no duplicate user turn and no window rebuild", async () => {
    fakeDisk.persistSlice(makeSlice({
      turns: [
        { timestamp: "t0", role: "user", content: "same question" },
        { timestamp: "t1", role: "agent", content: "rejected reply" },
      ],
    }));

    // The SDK truncated the rejected assistant message locally, so the
    // history legitimately mismatches the slice — detection is skipped for
    // the regenerate turn shape.
    const { slice, rebuiltHistory } = await housekeeping(
      makeInput("same question", { regenerate: true }),
    );

    // The slice survives and the question is NOT re-appended.
    expect(slice.slice_id).toBe("2026-07-14-0900");
    expect(slice.turns).toHaveLength(2);
    expect(rebuiltHistory).toBeUndefined();
    expect(episodic.appendTurn).not.toHaveBeenCalled();
  });

  it("returns previouslyContent along with slice", async () => {
    const result = await housekeeping(makeInput("hello world"));
    expect(result.previouslyContent).toBeDefined();
    expect(typeof result.previouslyContent).toBe("string");
  });
});

describe("slicing policy: close decisions + checkpoint continuation", () => {
  it("an over-age slice is summarized + closed IN the entry beat (time_cap) — decision and execution are atomic", async () => {
    seedAgedActiveSlice({ turns: [{ timestamp: "t0", role: "user", content: "old" }] });
    mockCreateSlice("2026-07-14-1000");

    const hk = await housekeeping(makeInput("new topic"));

    // The close already happened — inside housekeeping, before the user turn
    // landed on the new slice.
    expect(episodic.closeSlice).toHaveBeenCalledOnce();
    expect(episodic.closeSlice.mock.calls[0][1]).toBe("time_cap");
    expect((episodic.closeSlice.mock.calls[0][0] as TimeSlice).slice_id).toBe("2026-07-14-0900");
    expect(hk.slice.slice_id).toBe("2026-07-14-1000");
    expect(hk.slice.continuesFrom).toBe("2026-07-14-0900");
  });

  it("the turn cap forces a close decision (capacity) and links the new slice", async () => {
    fakeDisk.persistSlice(makeSlice({
      turns: Array.from({ length: 40 }, (_, i) => ({ timestamp: `t${i}`, role: "user" as const, content: `m${i}` })),
    }));
    mockCreateSlice("2026-07-14-1100");

    const hk = await housekeeping(makeInput("keep going"));

    expect(episodic.closeSlice).toHaveBeenCalledOnce();
    expect(episodic.closeSlice.mock.calls[0][1]).toBe("capacity");
    expect(hk.slice.continuesFrom).toBe("2026-07-14-0900");
    // Only the last 10 turns are carried (from the in-memory closing slice).
    expect(hk.contextPrefix).toHaveLength(10);
    expect(hk.contextPrefix?.[0]).toEqual({ role: "user", content: "m30" });
    expect(episodic.loadSlice).not.toHaveBeenCalled();
  });

  it("closes on idle_gap when the last turn is older than the idle gap — a genuine new conversation", async () => {
    const disk = fakeDisk.persistSlice(makeSlice({
      turns: [{ timestamp: "t0", role: "user", content: "old topic" }],
    }));
    void disk;
    slicer.checkIdleGap.mockReturnValue(true);
    mockCreateSlice("2026-07-14-1000");

    const hk = await housekeeping(makeInput("back after lunch"));

    expect(episodic.closeSlice).toHaveBeenCalledOnce();
    expect(episodic.closeSlice.mock.calls[0][1]).toBe("idle_gap");
    // No continuation link, no carry-over — the user left and came back.
    expect(hk.slice.continuesFrom).toBeUndefined();
    expect(hk.contextPrefix).toBeUndefined();
    expect(episodic.loadSlice).not.toHaveBeenCalled();
  });

  it("idle gap wins over time_cap when both thresholds are exceeded", async () => {
    seedAgedActiveSlice({ turns: [{ timestamp: "t0", role: "user", content: "old topic" }] });
    slicer.checkIdleGap.mockReturnValue(true);
    mockCreateSlice("2026-07-14-1000");

    const hk = await housekeeping(makeInput("much later"));

    expect(episodic.closeSlice).toHaveBeenCalledOnce();
    expect(episodic.closeSlice.mock.calls[0][1]).toBe("idle_gap");
    expect(hk.slice.continuesFrom).toBeUndefined();
  });

  it("does NOT idle-close when the gap is below the threshold", async () => {
    fakeDisk.persistSlice(makeSlice({
      turns: [
        { timestamp: "t0", role: "user", content: "earlier" },
        { timestamp: "t1", role: "agent", content: "reply" },
      ],
    }));

    const input = makeInput("follow up", {
      modelMessages: [
        { role: "assistant", content: "reply" },
      ] as unknown as TurnInput["modelMessages"],
    });
    const hk = await housekeeping(input);

    expect(episodic.closeSlice).not.toHaveBeenCalled();
    expect(hk.slice.slice_id).toBe("2026-07-14-0900");
  });

  it("a client-history mismatch gets NO close — the slice stays open with a rebuilt window (no continuation link, no carry-over)", async () => {
    fakeDisk.persistSlice(makeSlice({
      turns: [
        { timestamp: "t0", role: "user", content: "earlier" },
        { timestamp: "t1", role: "agent", content: "reply" },
        { timestamp: "t2", role: "user", content: "another" },
        { timestamp: "t3", role: "agent", content: "reply2" },
      ],
    }));
    mockCreateSlice("2026-07-14-1200");

    const { slice, contextPrefix, rebuiltHistory } = await housekeeping(makeInput("new from different device"));

    expect(episodic.createSlice).not.toHaveBeenCalled();
    expect(slice.slice_id).toBe("2026-07-14-0900");
    expect(slice.continuesFrom).toBeUndefined();
    expect(contextPrefix).toBeUndefined();
    expect(rebuiltHistory).toEqual([
      { role: "user", content: "earlier" },
      { role: "assistant", content: "reply" },
      { role: "user", content: "another" },
      { role: "assistant", content: "reply2" },
      { role: "user", content: "new from different device" },
    ]);
  });

  it("later turns of a checkpointed slice re-read the frozen predecessor via loadSlice", async () => {
    fakeDisk.persistSlice(makeSlice({
      slice_id: "2026-07-14-1000",
      continuesFrom: "2026-07-14-0900",
      turns: [
        { timestamp: "t0", role: "user", content: "q1" },
        { timestamp: "t1", role: "agent", content: "a1" },
        { timestamp: "t2", role: "user", content: "q2" },
      ],
    }));
    episodic.loadSlice.mockResolvedValue(
      makeSlice({
        slice_id: "2026-07-14-0900",
        status: "closed",
        turns: Array.from({ length: 12 }, (_, i) => ({
          timestamp: `p${i}`,
          role: i % 2 === 0 ? ("user" as const) : ("agent" as const),
          content: `p${i}`,
        })),
      }),
    );
    try {
      const input = makeInput("q2", {
        modelMessages: [
          { role: "assistant", content: "a1" },
        ] as unknown as TurnInput["modelMessages"],
      });
      const { contextPrefix } = await housekeeping(input);

      expect(episodic.loadSlice).toHaveBeenCalledWith("2026-07-14-0900");
      // The tail is capped at the last 10 turns, roles mapped to the wire shape.
      expect(contextPrefix).toHaveLength(10);
      expect(contextPrefix?.[0]).toEqual({ role: "user", content: "p2" });
      expect(contextPrefix?.[9]).toEqual({ role: "assistant", content: "p11" });
    } finally {
      episodic.loadSlice.mockResolvedValue(null);
    }
  });

  it("unreadable predecessor degrades to no carry-over (best-effort)", async () => {
    fakeDisk.persistSlice(makeSlice({
      slice_id: "2026-07-14-1000",
      continuesFrom: "2026-07-14-0900",
      turns: [
        { timestamp: "t0", role: "user", content: "q1" },
        { timestamp: "t1", role: "agent", content: "a1" },
      ],
    }));

    const input = makeInput("q1", {
      modelMessages: [
        { role: "assistant", content: "a1" },
      ] as unknown as TurnInput["modelMessages"],
    });
    const { slice, contextPrefix } = await housekeeping(input);

    // The turn proceeds normally — just without the carried tail.
    expect(slice.slice_id).toBe("2026-07-14-1000");
    expect(contextPrefix).toBeUndefined();
  });

  it("emits the checkpoint continuity tier for a continued slice", async () => {
    seedAgedActiveSlice({
      focus: "rust loops",
      turns: [
        { timestamp: "t0", role: "user", content: "q1" },
        { timestamp: "t1", role: "agent", content: "a1" },
      ],
    });
    mockCreateSlice("2026-07-14-1000");

    await housekeeping(makeInput("next question"));

    const chunk = workflowMock.written.find(
      (c) =>
        c.type === "data-phase" &&
        (c.data as { phase: string; running: boolean }).phase === "context" &&
        (c.data as { running: boolean }).running === false,
    );
    const summaries =
      ((chunk?.data as { summaries?: string[] } | undefined)?.summaries ?? []) as string[];
    expect(summaries.join(" ")).toContain("continuity: checkpoint");
  });
});

describe("entry reckoning (归纳上一页 + 闭片归档, v0.21 §3)", () => {
  it("analyzes the ended page's turns, marks + closes it in the same beat, and never touches its mailbox", async () => {
    seedAgedActiveSlice({
      turns: [
        { timestamp: "t0", role: "user", content: "old" },
        { timestamp: "t1", role: "agent", content: "reply" },
      ],
    });
    mockCreateSlice("2026-07-14-1000");
    // A due task on the shelf — the entry beat does NOT scan it for dispatch
    // (the 序 4/5 chain is retired; §A.3.3 read-face statements are a separate
    // channel, asserted in the housekeeping describe above).
    fakeDisk.taskDirs.add("体检");
    fakeDisk.taskDirs.add("报税");
    fakeDisk.files.set("memory/tasks/体检/index.md", "# 体检\n\n日期锚：2026-07-13\n\n去做。\n");
    fakeDisk.files.set("memory/tasks/报税/index.md", "# 报税\n\n日期锚：2026-08-01\n\n。\n");
    episodic.analyzeTurn.mockResolvedValue({
      ...baseAnalysis(),
      closedMarking: { focus: "morning planning", summary: "planned the day", tone: "calm" },
    });

    const hk = await housekeeping(makeInput("wrapping up"));

    // The analyzer saw the closing slice's turns — and ONLY those (the
    // summarization object is the ended page, never this turn's message).
    expect(episodic.analyzeTurn).toHaveBeenCalledOnce();
    const analyzeArgs = episodic.analyzeTurn.mock.calls[0][0] as {
      userMessage: string;
      closingSlice?: { turns: unknown[] };
    };
    expect(analyzeArgs.userMessage).toBe("wrapping up");
    expect(analyzeArgs.closingSlice?.turns).toHaveLength(2);

    // The close executed in the SAME beat, AFTER the analysis, carrying the
    // analyzer's marking.
    expect(
      episodic.analyzeTurn.mock.invocationCallOrder[0],
    ).toBeLessThan(episodic.closeSlice.mock.invocationCallOrder[0]);
    expect(episodic.closeSlice).toHaveBeenCalledOnce();
    expect(episodic.closeSlice.mock.calls[0][1]).toBe("time_cap");
    const closedSlice = JSON.parse(fakeDisk.files.get("2026-07-14-0900:core")!) as TimeSlice;
    expect(closedSlice.status).toBe("closed");
    expect(closedSlice.focus).toBe("morning planning");
    expect(closedSlice.summary).toBe("planned the day");
    expect(closedSlice.emotional_tone).toBe("calm");

    // §A.2.2: no [boundary-event] post, no mailbox write of any kind — the
    // closed slice's agent.md simply does not exist.
    expect(fakeDisk.files.get("2026-07-14-0900:agent")).toBeUndefined();

    // The slice-closed row was emitted (edge-mode checklist).
    const closedPhase = workflowMock.written.find(
      (c) =>
        c.type === "data-phase" &&
        (c.data as { phase: string }).phase === "slice-closed",
    );
    expect(closedPhase).toBeDefined();

    // And the user turn landed on the NEW slice, after the close.
    expect(hk.slice.slice_id).toBe("2026-07-14-1000");
    expect(hk.slice.continuesFrom).toBe("2026-07-14-0900");
  });

  it("falls back to a deterministic mark when the analyzer returns no closed marking (never close dry)", async () => {
    seedAgedActiveSlice({ turns: [{ timestamp: "t0", role: "user", content: "old" }] });
    mockCreateSlice("2026-07-14-1000");

    await housekeeping(makeInput("wrapping up"));

    const closedSlice = JSON.parse(fakeDisk.files.get("2026-07-14-0900:core")!) as TimeSlice;
    expect(closedSlice.status).toBe("closed");
    expect(closedSlice.focus).toBe("fallback focus");
    expect(closedSlice.summary).toBe("fallback summary");
  });

  it("no page ends → ZERO summarization: the derivation runs without a closing slice and nothing closes", async () => {
    fakeDisk.persistSlice(makeSlice({
      turns: [
        { timestamp: "t0", role: "user", content: "earlier" },
        { timestamp: "t1", role: "agent", content: "reply" },
      ],
    }));

    const input = makeInput("follow up", {
      modelMessages: [
        { role: "assistant", content: "reply" },
      ] as unknown as TurnInput["modelMessages"],
    });
    const hk = await housekeeping(input);

    // The derivation still ran (its memoryUpdate reading feeds 序 6)…
    expect(episodic.analyzeTurn).toHaveBeenCalledOnce();
    expect(
      (episodic.analyzeTurn.mock.calls[0][0] as { closingSlice?: unknown }).closingSlice,
    ).toBeUndefined();
    // …but nothing closed: the living page waits for its real end.
    expect(episodic.closeSlice).not.toHaveBeenCalled();
    expect(hk.slice.status).toBe("active");
    expect(hk.slice.slice_id).toBe("2026-07-14-0900");
  });

  it("an already-marked page is closed AS-IS — needs_marking idempotency, never re-summarized", async () => {
    seedAgedActiveSlice({
      focus: "existing focus",
      summary: "existing summary",
      turns: [{ timestamp: "t0", role: "user", content: "old" }],
    });
    mockCreateSlice("2026-07-14-1000");
    // Even when the analyzer WOULD return a marking, it must not land: the
    // page is already marked, so it is never the derivation's object.
    episodic.analyzeTurn.mockResolvedValue({
      ...baseAnalysis(),
      closedMarking: { focus: "SHOULD NOT LAND", summary: "SHOULD NOT LAND", tone: "calm" },
    });

    await housekeeping(makeInput("new topic"));

    expect(episodic.analyzeTurn).toHaveBeenCalledOnce();
    expect(
      (episodic.analyzeTurn.mock.calls[0][0] as { closingSlice?: unknown }).closingSlice,
    ).toBeUndefined();
    expect(episodic.closeSlice).toHaveBeenCalledOnce();
    const closedSlice = JSON.parse(fakeDisk.files.get("2026-07-14-0900:core")!) as TimeSlice;
    expect(closedSlice.status).toBe("closed");
    expect(closedSlice.focus).toBe("existing focus");
    expect(closedSlice.summary).toBe("existing summary");
  });

  it("a closed predecessor's mailbox is never touched — the 序 4/5 dispatch chain is retired (v0.21 §A.2.2)", async () => {
    // A closed predecessor carrying an UNANSWERED question marker on its
    // mailbox, plus an active slice. Pre-v0.21 the scribe segment would have
    // posted a [boundary-event] there and fired the boundary/question runs.
    fakeDisk.persistSlice(makeSlice({
      slice_id: "2026-07-14-0700",
      status: "closed",
      closedBy: "idle_gap",
      focus: "earlier",
      start: "2026-07-14T07:00:00.000Z",
      end: "2026-07-14T07:30:00.000Z",
      turns: [{ timestamp: "u0", role: "user", content: "before" }],
    } as Partial<TimeSlice>));
    fakeDisk.persistSlice(makeSlice({
      turns: [
        { timestamp: "t0", role: "user", content: "earlier" },
        { timestamp: "t1", role: "agent", content: "reply" },
      ],
    }));
    const mailboxBefore = '[doc-marker] {"id":"q1","kind":"question","title":"x"}\n';
    fakeDisk.files.set("2026-07-14-0700:agent", mailboxBefore);

    const input = makeInput("follow up", {
      modelMessages: [
        { role: "assistant", content: "reply" },
      ] as unknown as TurnInput["modelMessages"],
    });
    const hk = await housekeeping(input);
    await runExplicitEvolution(input, hk);
    await runExplicitEvolution(input, hk); // redelivery of the whole post-reply segment

    expect(episodic.closeSlice).not.toHaveBeenCalled();
    // Byte-identical: no [boundary-event], no marker consumption, nothing.
    expect(fakeDisk.files.get("2026-07-14-0700:agent")).toBe(mailboxBefore);
  });

  it("an orphaned active slice with no re-derivable signal is warned and left open (never fabricate a cause)", async () => {
    // The orphan is NOT aged and below every cap — nothing re-derives.
    fakeDisk.persistSlice(makeSlice({
      slice_id: "2026-07-14-0800",
      turns: [{ timestamp: "u0", role: "user", content: "orphan" }],
    }));
    fakeDisk.persistSlice(makeSlice({
      turns: [{ timestamp: "t0", role: "user", content: "earlier" }],
    }));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      await housekeeping(makeInput("hi"));

      expect(episodic.closeSlice).not.toHaveBeenCalled();
      expect(
        warnSpy.mock.calls.some(
          (c) => typeof c[0] === "string" && c[0].includes("re-derives no close signal"),
        ),
      ).toBe(true);
      // The derivation ran with NO closing slice — the orphan is skipped, not
      // summarized.
      expect(
        (episodic.analyzeTurn.mock.calls[0][0] as { closingSlice?: unknown }).closingSlice,
      ).toBeUndefined();
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe("explicit-instruction channel (序 6)", () => {

  it("序 6 runs the evolution ONLY on an explicit instruction — focus = the update, no fitness buckets", async () => {
    fakeDisk.persistSlice(makeSlice({
      turns: [
        { timestamp: "t0", role: "user", content: "earlier" },
        { timestamp: "t1", role: "agent", content: "reply" },
      ],
    }));
    episodic.analyzeTurn.mockResolvedValue({
      ...baseAnalysis(),
      memoryUpdate: { content: "Always answer in Chinese" },
    });
    evolution.runCardEvolution.mockResolvedValue({
      ran: true,
      changed: true,
      droppedRecent: 0,
      note: "evolved",
      summary: "记下了语言偏好",
    });

    const input = makeInput("记住：以后都用中文", {
      modelMessages: [
        { role: "assistant", content: "reply" },
      ] as unknown as TurnInput["modelMessages"],
    });
    const hk = await housekeeping(input);
    await runExplicitEvolution(input, hk);

    expect(evolution.runCardEvolution).toHaveBeenCalledOnce();
    const arg = evolution.runCardEvolution.mock.calls[0][0];
    expect(arg.focus).toBe("Always answer in Chinese");
    expect(arg.signal).toBe("new_observation");
    // v0.19 R4: the fitness trigger chain is retired — the explicit channel
    // carries NO trigger buckets and NO SOP write allowance.
    expect(arg.triggeredBuckets).toBeUndefined();
    expect(arg.allowedSopWrites).toBeUndefined();
    // The changed run's summary freezes into the slice (replaying in the L3
    // slice-head block on later turns) and is re-snapshotted in this batch.
    expect(hk.slice.evolutionSummary).toBe("记下了语言偏好");
    expect(
      episodic.saveSliceSnapshot.mock.calls.some((c) => c[0] === hk.slice),
    ).toBe(true);
    const terminal = workflowMock.written
      .filter((c) => c.type === "data-evolution")
      .at(-1);
    expect(terminal?.data).toMatchObject({ status: "done", hasChanges: true });
  });

  it("no explicit instruction → no evolution run, no evolution chunks", async () => {
    fakeDisk.persistSlice(makeSlice({
      turns: [
        { timestamp: "t0", role: "user", content: "old" },
        { timestamp: "t1", role: "agent", content: "reply" },
      ],
    }));

    const input = makeInput("just chatting", {
      modelMessages: [
        { role: "assistant", content: "reply" },
      ] as unknown as TurnInput["modelMessages"],
    });
    const hk = await housekeeping(input);
    await runExplicitEvolution(input, hk);

    expect(evolution.runCardEvolution).not.toHaveBeenCalled();
    expect(
      workflowMock.written.filter((c) => c.type === "data-evolution"),
    ).toHaveLength(0);
  });

  it("streams throttled live thinking lines on data-evolution, one merged id", async () => {
    fakeDisk.persistSlice(makeSlice({
      turns: [
        { timestamp: "t0", role: "user", content: "old" },
        { timestamp: "t1", role: "agent", content: "reply" },
      ],
    }));
    episodic.analyzeTurn.mockResolvedValue({
      ...baseAnalysis(),
      memoryUpdate: { content: "记住这个偏好" },
    });
    evolution.runCardEvolution.mockImplementationOnce(async (input) => {
      input.onProgress?.("reading");
      input.onEvolutionLine?.("比较卡片", "thinking"); // sent — first line
      input.onEvolutionLine?.("比较卡片中", "thinking"); // dropped — inside 40ms, longer
      await new Promise((r) => setTimeout(r, 60));
      input.onEvolutionLine?.("比较卡片中…", "thinking"); // sent — throttle elapsed
      input.onEvolutionLine?.("落笔", "writing"); // sent — stage change forces
      input.onProgress?.("reviewing");
      return { ran: true, changed: false, droppedRecent: 0, note: "reviewed" };
    });

    const input = makeInput("记一下", {
      modelMessages: [
        { role: "assistant", content: "reply" },
      ] as unknown as TurnInput["modelMessages"],
    });
    const hk = await housekeeping(input);
    await runExplicitEvolution(input, hk);

    const evo = workflowMock.written.filter((c) => c.type === "data-evolution");
    expect(evo.length).toBeGreaterThan(0);
    expect(evo.every((c) => c.id === "evolution")).toBe(true);

    const live = evo
      .map((c) => c.data as { live?: string; liveStage?: string })
      .filter((d) => d.live);
    expect(live.map((d) => d.live)).toEqual(["比较卡片", "比较卡片中…", "落笔"]);
    expect(live.map((d) => d.liveStage)).toEqual([
      "thinking",
      "thinking",
      "writing",
    ]);
    expect(live[0]).toMatchObject({
      running: true,
      status: "running",
      step: "reading",
    });

    const terminal = evo.at(-1)!.data as Record<string, unknown>;
    expect(terminal).toMatchObject({
      running: false,
      status: "done",
      hasChanges: false,
      note: "reviewed",
    });
  });

  it("demo mode skips the reckoning AND the explicit channel (no analysis, no evolution, no writes)", async () => {
    const hk = await housekeeping(makeInput("记住：以后都用中文", { useDemo: true }));
    await explicitEvolutionSegment(makeInput("记住：以后都用中文", { useDemo: true }), hk);

    expect(episodic.analyzeTurn).not.toHaveBeenCalled();
    expect(evolution.runCardEvolution).not.toHaveBeenCalled();
    expect(episodic.closeSlice).not.toHaveBeenCalled();
  });
});

describe("entry beat — bridge (outsourced) path", () => {
  function bridgeInput(msg = "记住这个") {
    const base = makeInput(msg, {
      modelMessages: [
        { role: "assistant", content: "reply" },
      ] as unknown as TurnInput["modelMessages"],
    });
    return {
      ...base,
      model: "bridge/claude",
      modelConfig: { ...base.modelConfig, id: "bridge/claude", sdk: "bridge" as const },
    };
  }

  function setupActiveSlice() {
    fakeDisk.persistSlice(makeSlice({
      turns: [
        { timestamp: "t0", role: "user", content: "old" },
        { timestamp: "t1", role: "agent", content: "reply" },
      ],
    }));
  }

  function makeReport(overrides: Record<string, unknown> = {}) {
    return {
      analysis: {
        semantic_hint: [],
        intent: "chat",
        memory_worthy: true,
        memory_update: "把这条记下来",
        emotional_signal: { intensity: "none", register: "neutral", note: "" },
      },
      closed_marking: null,
      evolution: {
        worth: true,
        reason: "user asked",
        mutations: [{ op: "addNow", content: "prefers concrete answers" }],
      },
      backfill_marks: [],
      strand_merges: [],
      direction: null,
      playbooks: [],
      ...overrides,
    };
  }

  it("ONE bridge call with the minimal payload (A1) — no dry slices / merge candidates / signals / playbooks / direction", async () => {
    setupActiveSlice();
    bridgePhases.runHousekeepingBridge.mockResolvedValue({
      ok: true,
      report: makeReport(),
    });

    const input = bridgeInput();
    const hk = await housekeeping(input);
    await runExplicitEvolution(input, hk);

    expect(bridgePhases.runHousekeepingBridge).toHaveBeenCalledOnce();
    const payload = bridgePhases.runHousekeepingBridge.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.userMessage).toBe("记住这个");
    expect(payload.sliceId).toBe("2026-07-14-0900");
    // The retired payload fields are simply absent.
    for (const k of ["drySlices", "strandsForMerge", "signals", "playbookTriggerBuckets", "playbooks", "directionContent", "selfModelContent", "directionMode"]) {
      expect(payload[k]).toBeUndefined();
    }
    // The explicit update's mutations apply through the card-session machinery.
    expect(bridgePhases.applyBridgeCardEvolution).toHaveBeenCalledOnce();
    const applyArgs = bridgePhases.applyBridgeCardEvolution.mock.calls[0][0] as {
      reason: string;
      mutations: unknown[];
    };
    expect(applyArgs.reason).toBe("user asked");
    expect(applyArgs.mutations).toHaveLength(1);
  });

  it("a failed bridge call degrades to the deterministic path — warning on the card, no evolution", async () => {
    setupActiveSlice();
    bridgePhases.runHousekeepingBridge.mockResolvedValue({
      ok: false,
      reason: "bridge-not-found",
    });

    const input = bridgeInput();
    const hk = await housekeeping(input);
    await runExplicitEvolution(input, hk);

    expect(bridgePhases.applyBridgeCardEvolution).not.toHaveBeenCalled();
    const cardFrames = workflowMock.written.filter(
      (c) =>
        c.type === "data-phase" &&
        (c.data as { phase?: string }).phase === "bridgeHousekeeping",
    );
    expect(
      cardFrames.some((c) => (c.data as { warning?: string }).warning === "bridge-not-found"),
    ).toBe(true);
  });
});

describe("cross-day continuity (disk scan, no catalog)", () => {
  function contextSummaries(): string[] {
    const chunk = workflowMock.written.find(
      (c) =>
        c.type === "data-phase" &&
        (c.data as { phase: string; running: boolean }).phase === "context" &&
        (c.data as { running: boolean }).running === false,
    );
    return ((chunk?.data as { summaries?: string[] } | undefined)?.summaries ??
      []) as string[];
  }

  it("uses the newest CLOSED slice from the recent-day scan — gap computed from its real end", async () => {
    // A closed slice earlier today; the just-created active slice must NOT be
    // picked as the reference (excludeFromId).
    fakeDisk.persistSlice(makeSlice({
      slice_id: "2026-07-14-0700",
      status: "closed",
      closedBy: "idle_gap",
      focus: "morning planning",
      start: "2026-07-14T07:00:00.000Z",
      end: "2026-07-14T07:30:00.000Z",
      turns: [{ timestamp: "u0", role: "user", content: "morning" }],
    } as Partial<TimeSlice>));
    mockCreateSlice("2026-07-14-1300");

    await housekeeping(makeInput("back again"));
    expect(contextSummaries().join(" ")).toContain("continuity: recent_return");
  });

  it("falls back to full enumeration when the recent-day dirs hold no closed slice", async () => {
    // Nothing in today/yesterday's dirs; the enumeration finds a slice closed
    // four days ago.
    enumerate.enumerateSliceIds.mockResolvedValue(["2026/07/10/0900"]);
    fakeDisk.files.set(
      "2026-07-10-0900:core",
      JSON.stringify(makeSlice({
        slice_id: "2026-07-10-0900",
        status: "closed",
        closedBy: "idle_gap",
        focus: "last week",
        start: "2026-07-10T09:00:00.000Z",
        end: "2026-07-10T09:30:00.000Z",
        turns: [{ timestamp: "u0", role: "user", content: "old" }],
      })),
    );
    mockCreateSlice("2026-07-14-1300");

    await housekeeping(makeInput("long time no see"));
    expect(contextSummaries().join(" ")).not.toContain("continuity: none");
  });

  it("reports none when the disk holds no closed slice at all", async () => {
    mockCreateSlice("2026-07-14-1300");

    await housekeeping(makeInput("first ever"));
    expect(contextSummaries().join(" ")).toContain("continuity: none");
  });
});

describe("kill matrix (workflow redelivery)", () => {
  const outcome: TurnOutcome = {
    text: "agent reply",
    finishReason: "stop",
    cognition: "",
  };

  /** Read the persisted state of a slice from the fake disk. */
  function diskSlice(id: string): TimeSlice {
    return JSON.parse(fakeDisk.files.get(`${id}:core`)!) as TimeSlice;
  }

  it("kill after the entry beat: the close is already committed — redelivery dedupes the turn and never re-closes (v0.21 §3)", async () => {
    seedAgedActiveSlice({
      turns: [{ timestamp: "t0", role: "user", content: "old" }],
    });
    mockCreateSlice("2026-07-14-1000");
    const input = makeInput("new topic");

    // ── First delivery: the entry beat lands EVERYTHING (归纳 + 闭片 + 新片
    //    + user turn) in its one commit; persistAgentTurn appends the reply;
    //    then the run DIES before the post-reply segment.
    const hk1 = await housekeeping(input);
    await persistAgentTurn(hk1.slice, outcome, input.turnId);

    // The old slice is already closed + marked on the fake disk (deterministic
    // fallback — the default analyzer verdict carries no closedMarking).
    expect(diskSlice("2026-07-14-0900").status).toBe("closed");

    // ── Redelivery: housekeeping recovers the NEW slice (newer id sorts
    //    first), dedupes the user turn; no page ends this time, so the beat's
    //    derivation runs with NO closing slice (zero re-summarization).
    const hk2 = await housekeeping(input);
    expect(hk2.slice.slice_id).toBe("2026-07-14-1000");
    await persistAgentTurn(hk2.slice, outcome, input.turnId);
    await runExplicitEvolution(input, hk2);

    const finalNew = diskSlice("2026-07-14-1000");
    expect(finalNew.turns.filter((t) => t.role === "user" && t.turnId === "test-id")).toHaveLength(1);
    expect(finalNew.turns.filter((t) => t.role === "agent" && t.turnId === "test-id")).toHaveLength(1);
    expect(episodic.appendTurn).toHaveBeenCalledTimes(1); // the agent turn, once
    // Exactly ONE close across both deliveries — the redelivery found the old
    // slice already closed and never re-decided it.
    expect(episodic.closeSlice).toHaveBeenCalledOnce();
    expect(episodic.closeSlice.mock.calls[0][1]).toBe("time_cap");
    expect(episodic.analyzeTurn).toHaveBeenCalledTimes(2);
    expect(
      (episodic.analyzeTurn.mock.calls[1][0] as { closingSlice?: unknown }).closingSlice,
    ).toBeUndefined();
    const finalOld = diskSlice("2026-07-14-0900");
    expect(finalOld.status).toBe("closed");
    expect(finalOld.closedBy).toBe("time_cap");
    expect(finalOld.focus).toBe("fallback focus");
    // §A.2.2: no [boundary-event] was ever posted — the mailbox does not exist.
    expect(fakeDisk.files.get("2026-07-14-0900:agent")).toBeUndefined();
  });

  it("kill replay with the close already on disk: nothing re-closes, nothing re-summarizes, the mailbox stays untouched", async () => {
    // Disk state as if the entry beat committed and the run died right after:
    // the old slice is CLOSED + marked; the successor carries the full turn.
    fakeDisk.persistSlice(makeSlice({
      slice_id: "2026-07-14-0900",
      status: "closed",
      closedBy: "time_cap",
      focus: "marked",
      summary: "marked",
      start: "2026-07-14T09:00:00.000Z",
      end: "2026-07-14T09:30:00.000Z",
      turns: [
        { timestamp: "t0", role: "user", content: "old" },
        { timestamp: "t1", role: "user", content: "new topic", turnId: "test-id" },
      ],
    } as Partial<TimeSlice>));
    fakeDisk.persistSlice(makeSlice({
      slice_id: "2026-07-14-1000",
      turns: [
        { timestamp: "t2", role: "user", content: "new topic", turnId: "test-id" },
        { timestamp: "t3", role: "agent", content: "agent reply", turnId: "test-id" },
      ],
    }));
    const input = makeInput("new topic");

    const hk = await housekeeping(input);
    await runExplicitEvolution(input, hk);
    const hk2 = await housekeeping(input); // a second redelivery for good measure
    await runExplicitEvolution(input, hk2);

    expect(episodic.closeSlice).not.toHaveBeenCalled();
    // Every derivation ran WITHOUT a closing slice — a closed page is never
    // re-read, let alone re-summarized.
    expect(episodic.analyzeTurn).toHaveBeenCalledTimes(2);
    for (const call of episodic.analyzeTurn.mock.calls) {
      expect((call[0] as { closingSlice?: unknown }).closingSlice).toBeUndefined();
    }
    expect(fakeDisk.files.get("2026-07-14-0900:agent")).toBeUndefined();
    // The closed page's marks are byte-identical.
    const old = diskSlice("2026-07-14-0900");
    expect(old.focus).toBe("marked");
    expect(old.summary).toBe("marked");
  });
});

describe("turn idempotency (workflow redelivery)", () => {
  const outcome: TurnOutcome = {
    text: "agent reply",
    finishReason: "stop",
    cognition: "",
  };

  it("does not re-append the user turn when housekeeping re-runs with the same turnId", async () => {
    // Disk state after a first run that committed but whose result was lost:
    // the user turn is already persisted, keyed by turnId.
    fakeDisk.persistSlice(makeSlice({
      turns: [
        { timestamp: "t0", role: "user", content: "earlier", turnId: "prev-id" },
        { timestamp: "t1", role: "agent", content: "reply", turnId: "prev-id" },
        { timestamp: "t2", role: "user", content: "follow up", turnId: "test-id" },
      ],
    }));

    // Include an assistant message so the context continuity check passes.
    const input = makeInput("follow up", {
      modelMessages: [
        { role: "assistant", content: "reply" },
      ] as unknown as TurnInput["modelMessages"],
    });
    const { slice } = await housekeeping(input);

    expect(slice.turns).toHaveLength(3);
    expect(
      slice.turns.filter((t) => t.role === "user" && t.turnId === "test-id"),
    ).toHaveLength(1);
    expect(episodic.appendTurn).not.toHaveBeenCalled();
  });

  it("does not re-append the agent turn when persistAgentTurn re-runs with the same turnId", async () => {
    const slice = makeSlice({
      turns: [
        { timestamp: "t0", role: "user", content: "hi", turnId: "test-id" },
        { timestamp: "t1", role: "agent", content: "agent reply", turnId: "test-id" },
      ],
    });

    await persistAgentTurn(slice, outcome, "test-id");

    expect(slice.turns.filter((t) => t.role === "agent")).toHaveLength(1);
    expect(episodic.appendTurn).not.toHaveBeenCalled();
  });

  it("stores exactly one user turn and one agent turn even when both steps are redelivered", async () => {
    // First delivery: fresh slice, user turn minted by createSlice.
    const { slice } = await housekeeping(makeInput("hello world"));

    // Agent turn appended once, then the whole persist step is redelivered
    // against the same slice state (same turnId).
    await persistAgentTurn(slice, outcome, "test-id");
    await persistAgentTurn(slice, outcome, "test-id");

    expect(slice.turns.filter((t) => t.role === "user")).toHaveLength(1);
    expect(slice.turns.filter((t) => t.role === "agent")).toHaveLength(1);
  });

  it("closeTurnStream emits the terminal status + lifecycle tail", async () => {
    await closeTurnStream(outcome, "test-id");
    expect(workflowMock.written.map((c) => c.type)).toEqual([
      "data-turn-status",
      "finish-step",
      "finish",
    ]);
    expect(workflowMock.written[0].data).toMatchObject({
      status: "done",
      turnId: "test-id",
    });
  });
});
