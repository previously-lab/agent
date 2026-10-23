import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { TimeSlice } from "@/lib/episodic";
import type {
  HousekeepingResult,
  TurnInput,
  TurnOutcome,
} from "@/lib/chat/turn-types";

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
  saveSliceSnapshot: vi.fn(
    async (slice: TimeSlice, batch?: { entries: Map<string, unknown> }) => {
      // Mirror the real fsWriteFile: a BATCHED snapshot only QUEUES (the
      // entry beat never flushes — v0.42 §1); only a batch-less call lands.
      if (batch) {
        batch.entries.set(`${slice.slice_id}:core`, JSON.stringify(slice));
        return;
      }
      fakeDisk.persistSlice(slice);
    },
  ),
  writeAgentTimeline: vi.fn(async (sliceId: string, content: string) => {
    const key = `${sliceId}:agent`;
    const existing = fakeDisk.files.get(key);
    fakeDisk.files.set(key, existing ? `${existing.trimEnd()}\n\n${content}` : content);
    return { path: key, created: !existing };
  }),
  readStrands: vi.fn(async () => ({})),
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

// The mechanical bell (v0.34 R1) is mocked at its module boundary: the
// engine's three delivery paths are pinned in reflection-wake.test.ts, so
// here only the step's threading (payload in, warn-not-throw out) matters.
const reflectionWake = vi.hoisted(() => ({
  deliverReflectionWake: vi.fn(
    async (): Promise<
      | { ok: true; delivered: "rung" | "started"; runId: string }
      | { ok: false; reason: string }
    > => ({ ok: true, delivered: "rung", runId: "hq-1" }),
  ),
}));
vi.mock("@/app/api/evolution/reflection-wake", () => reflectionWake);

// v0.39 — the 暂存 read goes through the commit-log reader (mocked here).
const hqLog = vi.hoisted(() => ({ note: null as { note: string; at: string } | null }));
vi.mock("@/lib/chat/hq-log", () => ({
  readLatestReflectionNote: async () => hqLog.note,
  readReflectionCursor: async () => ({ sliceId: null, sha: null, at: null, degraded: false }),
  readReflectionLog: async () => ({ entries: [], available: true }),
}));

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
vi.mock("@/lib/deepseek/generate", async () => {
  const actual = await vi.importActual("@/lib/deepseek/generate");
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

vi.mock("workflow", () => ({
  getWritable: workflowMock.getWritable,
  // v0.33 连发并行: housekeeping stamps the run registry (slice/turn) and
  // counts live siblings — the step-context API is mocked through, and the
  // runtime world below lists zero live runs (no siblings in these tests).
  getWorkflowMetadata: vi.fn(() => ({ workflowRunId: "wrun_test" })),
  setAttributes: vi.fn(async () => {}),
}));
vi.mock("workflow/runtime", () => ({
  getWorld: vi.fn(async () => ({
    runs: { list: vi.fn(async () => ({ data: [], cursor: null })) },
  })),
}));

import {
  housekeeping,
  finalizeTurn,
  closeTurnStream,
  ringReflection,
  type EntryReckoning,
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

/** A minimal HousekeepingResult for driving finalizeTurn without a full
 *  housekeeping run — only the fields the turn tail reads. */
function hkFor(slice: TimeSlice): HousekeepingResult & EntryReckoning {
  return {
    slice,
    previouslyContent: "",
    sliceHeadBlock: "",
    identityPrompt: "",
    analysis: null,

    evidenceAttachments: null,
    previouslyUpdate: null,
    sliceOnDisk: true,
  };
}

/** Run the post-reply turn tail the way the workflow does — ONE finalizeTurn
 *  step (落盘 + 序 6 + 回程 in a single commit); the housekeeping result
 *  threads through BY VALUE (EntryReckoning). */
async function runExplicitEvolution(
  input: TurnInput,
  hk: Awaited<ReturnType<typeof housekeeping>>,
) {
  await finalizeTurn(hk.slice, TAIL_OUTCOME, input, hk);
}

/** The outcome the tail helper persists — a plain stop, no cognition. */
const TAIL_OUTCOME: TurnOutcome = {
  text: "agent reply",
  finishReason: "stop",
  cognition: "",
};

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
  hqLog.note = null;
});

describe("housekeeping step (进场那一拍 — the entry beat)", () => {
  it("collects the turn's evidence attachments onto the result (the bytes ride to the summary stream) and records the names on the user turn (v0.19 §C.1, v0.42 review blocker 1)", async () => {
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

      // v0.42 — the entry beat commits NOTHING: the bytes ride the result to
      // the summary stream, which persists them through the same fuses. The
      // beat only COLLECTS (and annotates the in-memory turn for the model).
      expect([...fakeDisk.files.keys()].filter((k) => k.includes("/attachments/"))).toEqual([]);
      expect(hk.evidenceAttachments).toEqual([
        { name: "shot.png", dataBase64: Buffer.from("png-bytes").toString("base64") },
      ]);
      // the in-memory turn still points at its own evidence (model context).
      const userTurn = hk.slice.turns.find((t) => t.role === "user");
      expect(userTurn?.content).toContain("[attachments: shot.png]");
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("a persisted user turn is NOT re-collected (userTurnRecorded skips the whole block)", async () => {
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
    // First delivery on an edgeless turn: the shell carries the evidence.
    const hk = await housekeeping(input);
    expect(hk.evidenceAttachments).toHaveLength(1);

    // The SAME turn already persisted on disk: the beat skips the collection
    // (the summary's turnId dedupe converges anything else).
    fakeDisk.persistSlice(hk.slice);
    const hk2 = await housekeeping(input);
    expect(hk2.evidenceAttachments).toBeNull();
    const userTurn = hk2.slice.turns.find((t) => t.role === "user");
    expect(userTurn?.content.match(/\[attachments:/g)).toHaveLength(1);
  });

  it("an over-fuse attachment still RIDES the result (the fuse verdict moves to the summary stream, visible, never thrown)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const big = Buffer.alloc(5 * 1024 * 1024 + 1, 1);
    const bigDataUrl = `data:application/pdf;base64,${big.toString("base64")}`;
    try {
      const hk = await housekeeping(
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
      // the beat does not judge fuses — it carries; the summary stream's
      // persistEvidenceAttachments applies the 5MB fuse and warns (pinned in
      // summary-run.test.ts).
      expect(hk.evidenceAttachments?.map((a) => a.name)).toEqual(["big.pdf"]);
      expect([...fakeDisk.files.keys()].some((k) => k.includes("/attachments/"))).toBe(false);
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("§A.3.3: a tasks/ tail line dated today becomes the dueTasksBlock; yesterday's does not", async () => {
    const { createCase, appendTail, serializeCaseDoc } = await import("@/lib/docs");
    const todayCase = appendTail(
      createCase({
        category: "tasks",
        caseName: "后台回复",
        opened: "2026-07-14",
        body: "后台流的完成通知册。",
      }),
      { date: "2026-07-14", text: "查了：手机话题 —— 结果已写入 research/手机话题演变/index.md。" },
    );
    fakeDisk.taskDirs.add("后台回复");
    fakeDisk.files.set("memory/tasks/后台回复/index.md", serializeCaseDoc(todayCase));
    const yesterdayCase = appendTail(
      createCase({
        category: "tasks",
        caseName: "旧账",
        opened: "2026-07-10",
        body: "旧任务。",
      }),
      { date: "2026-07-13", text: "昨天的结案行不该再陈述。" },
    );
    fakeDisk.taskDirs.add("旧账");
    fakeDisk.files.set("memory/tasks/旧账/index.md", serializeCaseDoc(yesterdayCase));

    const hk = await housekeeping(makeInput("hi"));

    expect(hk.dueTasksBlock).toBeDefined();
    expect(hk.dueTasksBlock).toContain("tasks/后台回复");
    expect(hk.dueTasksBlock).toContain("查了：手机话题");
    expect(hk.dueTasksBlock).toContain("state it, don't promise");
    expect(hk.dueTasksBlock).not.toContain("旧账");
  });

  it("v0.39 待裁决 3: the 暂存 rides the result, now read from the COMMIT LOG (reflectionNote)", async () => {
    // The log reader is mocked at the module boundary (the real one's
    // isomorphic-git leg has no place in this harness): the newest
    // `Reflection round —` commit's note paragraph + its commit timestamp.
    hqLog.note = {
      note: "核对了屏幕供应商案，把跟进写进了 research/。",
      at: "2026-07-14T09:30:00.000Z",
    };

    const hk = await housekeeping(makeInput("hi"));

    expect(hk.reflectionNote).toEqual({
      note: "核对了屏幕供应商案，把跟进写进了 research/。",
      at: "2026-07-14T09:30:00.000Z",
    });
  });

  it("no note in the log → reflectionNote is omitted entirely (exactly-once discipline unchanged)", async () => {
    hqLog.note = null;
    const hk = await housekeeping(makeInput("hi"));
    expect(hk.reflectionNote).toBeUndefined();
    expect("reflectionNote" in hk).toBe(false);
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

  it("the entry beat's ONE derivation runs ZERO-归纳 — no closing slice, no close, zero projection writes (v0.42 §1, v0.19 A1)", async () => {
    seedAgedActiveSlice({
      turns: [{ timestamp: "t0", role: "user", content: "old" }],
    });

    await housekeeping(makeInput("new topic"));

    // The turn's ONE semantic derivation still runs (its memoryUpdate reading
    // feeds 序 6) — but NEVER over a closing slice: no page ends at the entry.
    expect(episodic.analyzeTurn).toHaveBeenCalledOnce();
    const analyzeArgs = episodic.analyzeTurn.mock.calls[0][0] as {
      userMessage: string;
      closingSlice?: { turns: unknown[] };
    };
    expect(analyzeArgs.userMessage).toBe("new topic");
    expect(analyzeArgs.closingSlice).toBeUndefined();
    // NOTHING closes or is minted at the entry — the landing judgment (续写
    // 还是开新片) is the summary stream's call.
    expect(episodic.closeSlice).not.toHaveBeenCalled();
    expect(episodic.createSlice).not.toHaveBeenCalled();
    // No evolution here — that is the post-reply explicit channel (序 6), and
    // this message carries no explicit instruction anyway.

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

    // Like production, the history ENDS with the current user message.
    const input = makeInput("follow up", {
      modelMessages: [
        { role: "user", content: "earlier" },
        { role: "assistant", content: "reply" },
        { role: "user", content: "follow up" },
      ] as unknown as TurnInput["modelMessages"],
    });
    const { slice } = await housekeeping(input);

    expect(episodic.createSlice).not.toHaveBeenCalled();
    expect(slice.slice_id).toBe("2026-07-14-0900");
    expect(slice.turns).toHaveLength(3);
    expect(slice.turns[2].content).toBe("follow up");
    expect(episodic.saveSliceSnapshot).toHaveBeenCalledWith(slice, expect.anything());
  });

  it("regenerate: no duplicate user turn", async () => {
    fakeDisk.persistSlice(makeSlice({
      turns: [
        { timestamp: "t0", role: "user", content: "same question" },
        { timestamp: "t1", role: "agent", content: "rejected reply" },
      ],
    }));

    // The SDK truncated the rejected assistant message locally.
    const { slice } = await housekeeping(
      makeInput("same question", { regenerate: true }),
    );

    // The slice survives and the question is NOT re-appended.
    expect(slice.slice_id).toBe("2026-07-14-0900");
    expect(slice.turns).toHaveLength(2);
    expect(episodic.appendTurn).not.toHaveBeenCalled();
  });

  it("returns previouslyContent along with slice", async () => {
    const result = await housekeeping(makeInput("hello world"));
    expect(result.previouslyContent).toBeDefined();
    expect(typeof result.previouslyContent).toBe("string");
  });
});

describe("slicing policy: the edge slice is READ-ONLY context (v0.42 §1 — 落点判断归总结流)", () => {
  it("an over-age edge is NOT closed at the entry — the turn answers inside it read-only; the landing judgment moved to the summary stream", async () => {
    seedAgedActiveSlice({ turns: [{ timestamp: "t0", role: "user", content: "old" }] });

    const hk = await housekeeping(makeInput("new topic"));

    expect(episodic.closeSlice).not.toHaveBeenCalled();
    expect(episodic.createSlice).not.toHaveBeenCalled();
    expect(hk.slice.slice_id).toBe("2026-07-14-0900");
    expect(hk.slice.status).toBe("active");
  });

  it("the turn cap does NOT close at the entry either — no continuation link, no carry-over", async () => {
    fakeDisk.persistSlice(makeSlice({
      turns: Array.from({ length: 40 }, (_, i) => ({ timestamp: `t${i}`, role: "user" as const, content: `m${i}` })),
    }));

    const hk = await housekeeping(makeInput("keep going"));

    expect(episodic.closeSlice).not.toHaveBeenCalled();
    expect(hk.slice.slice_id).toBe("2026-07-14-0900");
    expect(hk.contextPrefix).toBeUndefined();
  });

  it("an idle-gap edge is NOT closed at the entry (a genuine new conversation is the summary stream's call)", async () => {
    fakeDisk.persistSlice(makeSlice({
      turns: [{ timestamp: "t0", role: "user", content: "old topic" }],
    }));
    slicer.checkIdleGap.mockReturnValue(true);

    const hk = await housekeeping(makeInput("back after lunch"));

    expect(episodic.closeSlice).not.toHaveBeenCalled();
    expect(hk.slice.slice_id).toBe("2026-07-14-0900");
    expect(hk.contextPrefix).toBeUndefined();
  });

  it("an edgeless turn answers on an UNSAVED context shell — nothing is minted or written at the entry", async () => {
    const hk = await housekeeping(makeInput("first message"));

    expect(episodic.createSlice).toHaveBeenCalledOnce(); // the context shell only
    expect(episodic.flushBatch).not.toHaveBeenCalled();
    // …and the shell persisted nothing under its own id.
    expect(fakeDisk.files.has(`${hk.slice.slice_id}:core`)).toBe(false);
    expect(hk.slice.turns[0]?.content).toBe("first message");
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

    expect(slice.slice_id).toBe("2026-07-14-1000");
    expect(contextPrefix).toBeUndefined();
  });

  it("the context phase still emits the disk-derived continuity tier (no close happened at the entry)", async () => {
    fakeDisk.persistSlice(makeSlice({
      turns: [
        { timestamp: "t0", role: "user", content: "q1" },
        { timestamp: "t1", role: "agent", content: "a1" },
      ],
    }));

    await housekeeping(makeInput("next question"));

    expect(episodic.closeSlice).not.toHaveBeenCalled();
    const chunk = workflowMock.written.find(
      (c) =>
        c.type === "data-phase" &&
        (c.data as { phase: string; running: boolean }).phase === "context" &&
        (c.data as { running: boolean }).running === false,
    );
    const summaries =
      ((chunk?.data as { summaries?: string[] } | undefined)?.summaries ?? []) as string[];
    expect(summaries.join(" ")).toContain("continuity:");
  });
});

describe("entry derivation (v0.42 §1 — 归纳随封口走; the summary stream seals)", () => {
  it("the derivation runs ZERO-归纳 — analyzeTurn sees NO closing slice and the entry NEVER closes anything, even when the analyzer offers a marking", async () => {
    seedAgedActiveSlice({
      turns: [
        { timestamp: "t0", role: "user", content: "old" },
        { timestamp: "t1", role: "agent", content: "reply" },
      ],
    });
    // Even a full marking offered by the analyzer must not close anything at
    // the entry — the seal is the summary stream's job.
    episodic.analyzeTurn.mockResolvedValue({
      ...baseAnalysis(),
      closedMarking: {
        focus: "morning planning",
        summary: "planned the day",
        tone: "calm",
        openLoops: ["confirm the flight time"],
        decisions: ["ship v0.11 first"],
      },
    });

    const hk = await housekeeping(makeInput("wrapping up"));

    expect(episodic.analyzeTurn).toHaveBeenCalledOnce();
    const analyzeArgs = episodic.analyzeTurn.mock.calls[0][0] as {
      userMessage: string;
      closingSlice?: unknown;
    };
    expect(analyzeArgs.userMessage).toBe("wrapping up");
    expect(analyzeArgs.closingSlice).toBeUndefined();
    expect(episodic.closeSlice).not.toHaveBeenCalled();
    expect(hk.slice.slice_id).toBe("2026-07-14-0900");
    expect(hk.slice.status).toBe("active");
    // No slice-closed checklist row either.
    const closedPhase = workflowMock.written.find(
      (c) =>
        c.type === "data-phase" &&
        (c.data as { phase: string }).phase === "slice-closed",
    );
    expect(closedPhase).toBeUndefined();
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
    // …but nothing closed — and under v0.42 §1 nothing EVER closes here.
    expect(episodic.closeSlice).not.toHaveBeenCalled();
    expect(hk.slice.status).toBe("active");
    expect(hk.slice.slice_id).toBe("2026-07-14-0900");
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

  it("orphaned active slices are NOT scanned at the entry — the summary stream's edge read converges them", async () => {
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
      // No orphan re-derivation warning — the entry does not scan.
      expect(
        warnSpy.mock.calls.some(
          (c) => typeof c[0] === "string" && c[0].includes("re-derives no close signal"),
        ),
      ).toBe(false);
      // The orphan is untouched (the summary stream seals it when a batch
      // opens a new page past it).
      const orphan = JSON.parse(fakeDisk.files.get("2026-07-14-0800:core")!) as TimeSlice;
      expect(orphan.status).toBe("active");
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
    await finalizeTurn(
      hk.slice,
      TAIL_OUTCOME,
      makeInput("记住：以后都用中文", { useDemo: true }),
      hk,
    );

    expect(episodic.analyzeTurn).not.toHaveBeenCalled();
    expect(evolution.runCardEvolution).not.toHaveBeenCalled();
    expect(episodic.closeSlice).not.toHaveBeenCalled();
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

  it("kill after the entry beat: the beat committed NOTHING (the summary owns the landing) — redelivery re-runs read-only, no close, no birth (v0.42 §1)", async () => {
    seedAgedActiveSlice({
      turns: [{ timestamp: "t0", role: "user", content: "old" }],
    });
    const input = makeInput("new topic");

    // ── First delivery: the entry beat is READ-ONLY (no 归纳/闭片/新片, no
    //    user-turn commit); finalize runs the 序 6 channel; then the run
    //    DIES before the post-reply segment.
    const hk1 = await housekeeping(input);
    await finalizeTurn(hk1.slice, outcome, input, hk1);

    // The old slice is STILL ACTIVE — no close happened anywhere.
    expect(diskSlice("2026-07-14-0900").status).toBe("active");
    expect(fakeDisk.files.get("2026-07-14-0900:agent")).toBeUndefined();
    expect(episodic.closeSlice).not.toHaveBeenCalled();
    expect(episodic.createSlice).not.toHaveBeenCalled();

    // ── Redelivery: the same read-only beat, the same edge, zero writes.
    const hk2 = await housekeeping(input);
    expect(hk2.slice.slice_id).toBe("2026-07-14-0900");
    await finalizeTurn(hk2.slice, outcome, input, hk2);
    await runExplicitEvolution(input, hk2);

    expect(episodic.closeSlice).not.toHaveBeenCalled();
    expect(episodic.createSlice).not.toHaveBeenCalled();
    expect(episodic.analyzeTurn).toHaveBeenCalledTimes(2);
    expect(
      (episodic.analyzeTurn.mock.calls[1][0] as { closingSlice?: unknown }).closingSlice,
    ).toBeUndefined();
    // Nothing PERSISTED across two deliveries + a finalize: the edge on disk
    // still carries exactly its seeded turn (the in-memory appends are the
    // summary stream's to dedupe).
    const finalEdge = diskSlice("2026-07-14-0900");
    expect(finalEdge.status).toBe("active");
    expect(finalEdge.turns).toHaveLength(1);
    expect(finalEdge.turns[0]?.content).toBe("old");
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

  it("does not re-append the agent turn when finalizeTurn re-runs with the same turnId", async () => {
    const slice = makeSlice({
      turns: [
        { timestamp: "t0", role: "user", content: "hi", turnId: "test-id" },
        { timestamp: "t1", role: "agent", content: "agent reply", turnId: "test-id" },
      ],
    });

    await finalizeTurn(slice, outcome, makeInput("hi"), hkFor(slice));

    expect(slice.turns.filter((t) => t.role === "agent")).toHaveLength(1);
    expect(episodic.appendTurn).not.toHaveBeenCalled();
  });

  it("a redelivered finalizeTurn adds NOTHING (v0.38 §6 — 回复侧零批; the reply moved to the writer)", async () => {
    // First delivery: fresh slice, user turn minted by createSlice.
    const { slice } = await housekeeping(makeInput("hello world"));

    // The whole finalize step is redelivered against the same slice state
    // (same turnId): zero appends, zero snapshot — the tail only carries the
    // evolution拍, and this turn has no explicit instruction.
    const input = makeInput("hello world");
    await finalizeTurn(slice, outcome, input, hkFor(slice));
    await finalizeTurn(slice, outcome, input, hkFor(slice));

    expect(slice.turns.filter((t) => t.role === "user")).toHaveLength(1);
    expect(slice.turns.filter((t) => t.role === "agent")).toHaveLength(0);
    expect(episodic.appendTurn).not.toHaveBeenCalled();
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

// ── flushTurnBatch write-conflict self-heal (T-10, steps.ts:1307-1340) ─────
// Additive mock, appended with this describe — no existing case is affected:
// `@/lib/tools/readFile` is only reached on the flush-conflict retry path
// (readFileFresh) and the useGithub read helper (readFile), which no test in
// this file drives (every makeInput runs useGithub: false; the one other
// consumer in the graph, config/loader, swallows read failures to defaults).
const readFileMock = vi.hoisted(() => ({
  readFile: vi.fn(async (): Promise<string> => {
    throw new Error("github read should not be called in these tests");
  }),
  readFileFresh: vi.fn(async (): Promise<string> => {
    throw new Error("readFileFresh not stubbed");
  }),
  invalidateReadCache: vi.fn(),
}));
vi.mock("@/lib/tools/readFile", () => readFileMock);

// Real serializer — the retry path's mergeTurnsWithRemote re-parses this.
import { serializeSlice } from "@/lib/episodic/manager";

describe("finalizeTurn — flushTurnBatch write-conflict self-heal (T-10)", () => {
  const outcome: TurnOutcome = {
    text: "agent reply",
    finishReason: "stop",
    cognition: "",
  };
  // sliceIdToFilePath mock output for the default makeSlice id.
  const CORE_PATH = "memory/records/2026/07/14/0900/core.md";

  /** A GitHub non-fast-forward rejection (isRefConflictError: status 422). */
  const refConflict = () =>
    Object.assign(new Error("Update is not a fast forward"), { status: 422 });

  function makeConflictedSlice(): TimeSlice {
    return makeSlice({
      turns: [{ timestamp: "t0", role: "user", content: "hi", turnId: "test-id" }],
    });
  }

  let batches: Array<{ entries: Map<string, string> }>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    batches = [];
    episodic.createBatch.mockImplementation(() => {
      const b = { entries: new Map<string, string>() };
      batches.push(b);
      return b;
    });
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    // Restore the file-level defaults — clearAllMocks keeps implementations.
    episodic.createBatch.mockImplementation(() => ({
      entries: new Map<string, string>(),
    }));
    episodic.flushBatch.mockImplementation(async () => {});
  });

  it("retries after a non-fast-forward conflict: re-reads the remote core, merges, and lands on a later attempt", async () => {
    episodic.flushBatch
      .mockRejectedValueOnce(refConflict())
      .mockRejectedValueOnce(refConflict())
      .mockResolvedValueOnce(undefined);
    // The remote slice gained a turn our stale base does not have.
    readFileMock.readFileFresh.mockResolvedValue(
      serializeSlice(
        makeSlice({
          turns: [
            { timestamp: "t0", role: "user", content: "hi", turnId: "test-id" },
            { timestamp: "tx", role: "agent", content: "remote-only turn", turnId: "remote-1" },
          ],
        }),
      ),
    );

    const slice = makeConflictedSlice();
    await finalizeTurn(slice, outcome, makeInput("hi"), hkFor(slice));

    expect(episodic.flushBatch).toHaveBeenCalledTimes(3);
    expect(readFileMock.readFileFresh).toHaveBeenCalledTimes(2);
    // The merged remote content was swapped into the batch before each retry.
    const merged = batches[0].entries.get(CORE_PATH);
    expect(merged).toBeDefined();
    expect(merged).toContain("remote-only turn");
  });

  it("gives up after MAX_FLUSH_RETRIES and fails the step (the throw feeds the queue retry)", async () => {
    episodic.flushBatch.mockRejectedValue(refConflict());
    readFileMock.readFileFresh.mockResolvedValue(
      serializeSlice(makeConflictedSlice()),
    );

    const slice = makeConflictedSlice();
    await expect(
      finalizeTurn(slice, outcome, makeInput("hi"), hkFor(slice)),
    ).rejects.toThrow("not a fast forward");
    // initial attempt + MAX_FLUSH_RETRIES (2) retries
    expect(episodic.flushBatch).toHaveBeenCalledTimes(3);
    expect(readFileMock.readFileFresh).toHaveBeenCalledTimes(2);
  });

  it("a NON-conflict flush failure throws immediately — no merge, no retry", async () => {
    episodic.flushBatch.mockRejectedValue(
      Object.assign(new Error("boom"), { status: 500 }),
    );

    const slice = makeConflictedSlice();
    await expect(
      finalizeTurn(slice, outcome, makeInput("hi"), hkFor(slice)),
    ).rejects.toThrow("boom");
    expect(episodic.flushBatch).toHaveBeenCalledTimes(1);
    expect(readFileMock.readFileFresh).not.toHaveBeenCalled();
  });

  it("merge-failure degradation: an unreadable remote slice retries the commit as-is and succeeds", async () => {
    episodic.flushBatch
      .mockRejectedValueOnce(refConflict())
      .mockResolvedValueOnce(undefined);
    readFileMock.readFileFresh.mockRejectedValue(new Error("Not Found"));

    const slice = makeConflictedSlice();
    await finalizeTurn(slice, outcome, makeInput("hi"), hkFor(slice));

    expect(episodic.flushBatch).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("remote re-read failed, retrying as-is:"),
      expect.anything(),
    );
    // No merged content was swapped into the batch.
    expect(batches[0].entries.has(CORE_PATH)).toBe(false);
  });

  it("merge-failure degradation: when the as-is retry ALSO conflicts, the loop keeps healing and eventually throws", async () => {
    episodic.flushBatch.mockRejectedValue(refConflict());
    readFileMock.readFileFresh.mockRejectedValue(new Error("Not Found"));

    const slice = makeConflictedSlice();
    await expect(
      finalizeTurn(slice, outcome, makeInput("hi"), hkFor(slice)),
    ).rejects.toThrow("not a fast forward");
    expect(episodic.flushBatch).toHaveBeenCalledTimes(3);
    // Every retry took the degradation branch (remote never readable).
    expect(
      warnSpy.mock.calls.filter((c) =>
        String(c[0]).includes("remote re-read failed, retrying as-is:"),
      ),
    ).toHaveLength(2);
  });
});

// ── v0.42 §0/§2 — the entry beat commits NOTHING ─────────────────────────
// `Turn {turnId} — user turn` is retired: the user turn, the page seal and
// the snapshot ride the turn's structured result to the burst's summary run
// (summary-run.test.ts owns the flush — and flushTurnBatch's merge-retry
// self-heal — now). This block pins the REMOVAL at the layer whose commit
// used to cause the platform-retry storm.
describe("housekeeping — v0.42 零提交 (被动存盘归总结流)", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
    // Restore the file-level default — clearAllMocks keeps implementations,
    // and a rejected flushBatch must not leak into the next test's tail.
    episodic.flushBatch.mockImplementation(async () => {});
  });

  it("the beat resolves with the user turn IN MEMORY and ZERO flushes — nothing lands on disk from the turn side", async () => {
    const hk = await housekeeping(makeInput("hi"));

    expect(hk.slice.turns.some((t) => t.role === "user" && t.content === "hi")).toBe(
      true,
    );
    expect(episodic.flushBatch).not.toHaveBeenCalled();
  });

  it("the beat's result carries the evidence/previously riders — and NO seal/birth (the landing judgment is the summary stream's)", async () => {
    const hk = await housekeeping(makeInput("hi"));

    expect(hk).toHaveProperty("evidenceAttachments");
    expect(hk).toHaveProperty("previouslyUpdate");
    expect(hk).not.toHaveProperty("sealed");
    expect(hk).not.toHaveProperty("birth");
  });

  it("a flush rejection configured by a previous test CANNOT leak into the beat — there is no flush to reject (the D-storm is structurally gone)", async () => {
    // The old D-batch stormed because the beat itself flushed. With the flush
    // retired, a rejected flushBatch mock is simply never called — the beat
    // cannot be driven into the retry loop at all.
    episodic.flushBatch.mockRejectedValue(
      Object.assign(new Error("not a fast forward"), { status: 422 }),
    );
    const hk = await housekeeping(makeInput("hi"));
    expect(hk.slice.turns.length).toBeGreaterThan(0);
    expect(episodic.flushBatch).not.toHaveBeenCalled();
  });
});

describe("finalizeTurn — the tail's single commit", () => {
  const outcome: TurnOutcome = {
    text: "agent reply",
    finishReason: "stop",
    cognition: "",
  };

  let batches: Array<{ entries: Map<string, string> }>;

  beforeEach(() => {
    batches = [];
    episodic.createBatch.mockImplementation(() => {
      const b = { entries: new Map<string, string>() };
      batches.push(b);
      return b;
    });
  });

  afterEach(() => {
    episodic.createBatch.mockImplementation(() => ({
      entries: new Map<string, string>(),
    }));
    episodic.flushBatch.mockImplementation(async () => {});
  });

  it("flushes exactly ONE commit named `Turn {turnId} — finalize`", async () => {
    const slice = makeSlice({
      turns: [{ timestamp: "t0", role: "user", content: "hi", turnId: "test-id" }],
    });
    await finalizeTurn(slice, outcome, makeInput("hi"), hkFor(slice));

    expect(episodic.flushBatch).toHaveBeenCalledTimes(1);
    const message = episodic.flushBatch.mock.calls[0][1] as string;
    // In this mocked fs no segment grows the batch (the persist/evolution
    // writes go through the mocked fs helpers) — the bare headline proves
    // the single commit.
    expect(message).toBe("Turn test-id — finalize");
  });

  it("v0.42 A-fix: a context SHELL (no slice on disk) is NEVER written — 序 6's evolution runs, but the finalize batch carries NO records/ entry", async () => {
    // No slice on disk → the entry beat answers on an UNSAVED shell.
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
    const input = makeInput("记住：以后都用中文");

    const hk = await housekeeping(input);
    expect(hk.sliceOnDisk).toBe(false);

    await finalizeTurn(hk.slice, outcome, input, hk);

    // The evolution RAN (its own user-model write is the turn's business)…
    expect(evolution.runCardEvolution).toHaveBeenCalledOnce();
    // …but NOTHING under records/ was queued — no ghost slice.
    const finalizeBatch = batches.at(-1)!;
    expect(
      [...finalizeBatch.entries.keys()].filter((k) => k.includes("memory/records/")),
    ).toEqual([]);
  });

  it("…and WITH an edge slice the freeze snapshot IS queued (disk-backed behavior unchanged)", async () => {
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
    expect(hk.sliceOnDisk).toBe(true);

    await finalizeTurn(hk.slice, outcome, input, hk);

    const finalizeBatch = batches.at(-1)!;
    // The mock saveSliceSnapshot queues the fakeDisk-style key.
    expect([...finalizeBatch.entries.keys()]).toContain("2026-07-14-0900:core");
  });

  it("an empty tail (no reply, no explicit update) no-ops the flush", async () => {
    const slice = makeSlice({
      turns: [{ timestamp: "t0", role: "user", content: "hi", turnId: "test-id" }],
    });
    // finishReason "error" with no text → segment 1 queues nothing.
    await finalizeTurn(
      slice,
      { text: "", finishReason: "error", cognition: "" },
      makeInput("hi"),
      hkFor(slice),
    );
    expect(episodic.flushBatch).toHaveBeenCalledTimes(1);
    expect(batches[0].entries.size).toBe(0);
  });
});

describe("ringReflection — the mechanical bell (v0.34 R1)", () => {
  it("delivers the wake built from the sealed slice's pointer", async () => {
    const slice = makeSlice();
    await ringReflection(slice.slice_id);
    // v0.38 §3.3 — the bell is PURE: no payload is built or delivered; the
    // v0.42 §4 range is OPTIONAL (absent on this plain call → undefined).
    expect(reflectionWake.deliverReflectionWake).toHaveBeenCalledTimes(1);
    expect(reflectionWake.deliverReflectionWake).toHaveBeenCalledWith(undefined);
  });

  it("a failed delivery only warns — the turn never fails on the bell", async () => {
    reflectionWake.deliverReflectionWake.mockResolvedValueOnce({
      ok: false,
      reason: "no reflection hook",
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(ringReflection(makeSlice().slice_id)).resolves.toBeUndefined();
      expect(
        warnSpy.mock.calls.some(
          (c) => typeof c[0] === "string" && c[0].includes("[Reflection] wake not delivered"),
        ),
      ).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("a thrown engine error only warns — the turn never fails on the bell", async () => {
    reflectionWake.deliverReflectionWake.mockRejectedValueOnce(new Error("boom"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(ringReflection(makeSlice().slice_id)).resolves.toBeUndefined();
      expect(
        warnSpy.mock.calls.some(
          (c) => typeof c[0] === "string" && c[0].includes("[Reflection] wake failed"),
        ),
      ).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe("finalizeTurn — the episode tail (v0.30 §3.4, D7)", () => {
  const outcome: TurnOutcome = {
    text: "main reply",
    finishReason: "stop",
    cognition: "",
  };

  /** Slice with the outer user turn plus two queued episode arrivals. */
  function episodeSlice(): TimeSlice {
    return makeSlice({
      turns: [
        { timestamp: "t0", role: "user", content: "first", turnId: "test-id" },
        { timestamp: "t1", role: "user", content: "queued q2", turnId: "u2" },
        { timestamp: "t2", role: "user", content: "queued q3", turnId: "u3" },
      ],
    });
  }

  const twoBubbles = {
    bubbles: [
      { turnId: "nu2", replyTo: "u2", text: "answer two", finishReason: "stop", doneAt: "t3" },
      { turnId: "nu3", replyTo: "u3", text: "answer three", finishReason: "stop", doneAt: "t4" },
    ],
    mergeSummary: "Both queued questions got answered above.",
  };

  it("one agent turn per terminal bubble with replyTo, mergeSummary FOLDED into the outer turn, ONE commit", async () => {
    const slice = episodeSlice();
    await finalizeTurn(slice, outcome, makeInput("first"), hkFor(slice), twoBubbles);

    const bubbles = slice.turns.filter((t) => t.role === "agent" && t.replyTo);
    expect(bubbles).toEqual([
      { timestamp: "t3", role: "agent", content: "answer two", turnId: "nu2", replyTo: "u2" },
      { timestamp: "t4", role: "agent", content: "answer three", turnId: "nu3", replyTo: "u3" },
    ]);
    // v0.38 §6 — the outer reply turn (and the mergeSummary fold) moved to
    // the WRITER; finalize's episode-residual handles the BUBBLES only.
    const outer = slice.turns.filter((t) => t.role === "agent" && t.turnId === "test-id");
    expect(outer).toHaveLength(0);
    expect(episodic.flushBatch).toHaveBeenCalledTimes(1);
  });

  it("a failed bubble's partial text records [partial]-style; a textless failure leaves NO turn", async () => {
    const slice = episodeSlice();
    await finalizeTurn(slice, outcome, makeInput("first"), hkFor(slice), {
      bubbles: [
        { turnId: "nu2", replyTo: "u2", text: "half an answer", finishReason: "error" },
        { turnId: "nu3", replyTo: "u3", text: "", finishReason: "error" },
      ],
    });

    const partial = slice.turns.find((t) => t.turnId === "nu2");
    expect(partial).toMatchObject({
      role: "agent",
      content: "[partial] half an answer",
      replyTo: "u2",
    });
    // the textless failure stays an unanswered user turn on disk (the honest
    // record reflection reads) — no agent turn for nu3
    expect(slice.turns.some((t) => t.turnId === "nu3")).toBe(false);
  });

  it("redelivery dedupes PER bubble — a retried finalize re-appends nothing", async () => {
    const slice = episodeSlice();
    const input = makeInput("first");
    await finalizeTurn(slice, outcome, input, hkFor(slice), twoBubbles);
    const turnCount = slice.turns.length;
    episodic.appendTurn.mockClear();

    await finalizeTurn(slice, outcome, input, hkFor(slice), twoBubbles);
    expect(slice.turns).toHaveLength(turnCount);
    expect(episodic.appendTurn).not.toHaveBeenCalled();
  });

  it("a nested tail persists even when the OUTER reply produced no text", async () => {
    const slice = episodeSlice();
    await finalizeTurn(
      slice,
      { text: "", finishReason: "error", cognition: "" },
      makeInput("first"),
      hkFor(slice),
      twoBubbles,
    );
    // the bubbles landed (their text justifies the snapshot) though the outer
    // turn has no agent reply
    expect(slice.turns.filter((t) => t.replyTo)).toHaveLength(2);
    expect(slice.turns.some((t) => t.role === "agent" && t.turnId === "test-id")).toBe(false);
    expect(episodic.saveSliceSnapshot).toHaveBeenCalled();
  });
});
