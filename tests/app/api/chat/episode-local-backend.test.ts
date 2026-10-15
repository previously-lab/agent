/**
 * v0.30 batch-W regression tests — REAL local filesystem backend (a temp
 * MEMORY_ROOT per test), NO storage-layer mocks. The pre-W suites mocked the
 * episodic layer end to end, which is exactly how D-1/D-2 shipped green:
 *
 *   A. readEpisodeInbox routes through the turn's ACTIVE backend (D-1). The
 *      pre-fix code hard-wired getRepoConfig()+readFileFresh, so under
 *      STORAGE=local the episode drain died with "GITHUB_TOKEN environment
 *      variable is not set". The local branch must read the seeded slice; the
 *      github branch must still fail loudly without a token.
 *   B. The messages route persists the user turn to DISK (D-2, route side) —
 *      a POST lands the turn in the real core.md (header AND body), and a
 *      re-POST of the same turnId dedupes. messages-route.test.ts mocks
 *      @/lib/episodic entirely; this is the same call against real files.
 *   C. finalizeTurn no longer erases route-appended turns (D-2, pipeline
 *      side): the run's stale in-memory slice is unioned with the disk file
 *      before the snapshot write, and a redelivered finalize dedupes.
 *
 * Only boundaries are mocked: the workflow runtime API (getRun/resumeHook —
 * no durable runtime in a test process), the origin guard (exercised in its
 * own tests), and the reflection-wake module (keeps the reflection-run import
 * chain out; its delivery is never on these paths).
 */
import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  afterAll,
} from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";

// STORAGE must be pinned BEFORE any imported module freezes its data source
// (io-helpers resolves it at module load; vitest's NODE_ENV=test would
// otherwise auto-detect demo).
vi.hoisted(() => {
  process.env.STORAGE = "local";
});

const workflowApi = vi.hoisted(() => ({
  getRun: vi.fn(),
  resumeHook: vi.fn(async () => {}),
  getHookByToken: vi.fn(),
  start: vi.fn(),
}));
vi.mock("workflow/api", () => workflowApi);
vi.mock("@/lib/security/origin-guard", () => ({ guardRequest: () => null }));
vi.mock("@/app/api/evolution/reflection-wake", () => ({
  deliverReflectionWake: vi.fn(async () => ({
    ok: true as const,
    delivered: "resumed" as const,
    runId: "hq-test",
  })),
  buildReflectionWakePayload: vi.fn(() => ({})),
}));

import { readEpisodeInbox, finalizeTurn } from "@/app/api/chat/steps";
import {
  appendTurn,
  createBatch,
  flushBatch,
  saveSliceSnapshot,
  sliceIdToFilePath,
} from "@/lib/episodic";
import { parseSlice, serializeSlice } from "@/lib/episodic/manager";
import type { TimeSlice, Turn } from "@/lib/episodic/types";
import type { TurnInput } from "@/lib/chat/turn-types";

let memoryRoot: string;

function makeTurn(
  turnId: string,
  role: "user" | "agent",
  content: string,
  timestamp = "2026-07-14T10:00:00.000Z",
): Turn {
  return { timestamp, role, content, turnId };
}

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

/** tryLoadTodaySlice scans the REAL (UTC) today/yesterday dirs — mint ids from now. */
function todaySliceId(hhmm = "0900"): string {
  return `${new Date().toISOString().slice(0, 10)}-${hhmm}`;
}

function sliceAbsPath(sliceId: string): string {
  return join(
    memoryRoot,
    sliceIdToFilePath(sliceId).slice("memory/".length),
  );
}

function seedSliceOnDisk(slice: TimeSlice): void {
  const abs = sliceAbsPath(slice.slice_id);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, serializeSlice(slice), "utf8");
}

function readDiskSlice(sliceId: string): TimeSlice {
  return parseSlice(readFileSync(sliceAbsPath(sliceId), "utf8"));
}

function makeInput(overrides: Partial<TurnInput> = {}): TurnInput {
  return {
    modelMessages: [],
    recentTurns: [],
    lastUserMessage: "outer message",
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
    turnId: "outT01",
    imageAttachments: [],
    ...overrides,
  };
}

/** The minimal HousekeepingResult & EntryReckoning the turn tail reads. */
function hkFor(slice: TimeSlice) {
  return {
    slice,
    previouslyContent: "",
    sliceHeadBlock: "",
    identityPrompt: "",
    analysis: null,
    bridgeReport: null,
  };
}

beforeEach(() => {
  memoryRoot = mkdtempSync(join(tmpdir(), "previously-w-"));
  process.env.MEMORY_ROOT = memoryRoot;
  workflowApi.getRun.mockReturnValue({ status: Promise.resolve("running") });
});

afterEach(() => {
  delete process.env.MEMORY_ROOT;
  vi.unstubAllEnvs();
  rmSync(memoryRoot, { recursive: true, force: true });
});

afterAll(() => {
  delete process.env.STORAGE;
});

// ─── A. readEpisodeInbox — active-backend routing (D-1) ──────────────────

describe("readEpisodeInbox (D-1)", () => {
  it("reads the LOCAL slice file under STORAGE=local and returns the unanswered turn", async () => {
    const sliceId = todaySliceId();
    seedSliceOnDisk(
      makeSlice({
        slice_id: sliceId,
        turns: [
          makeTurn("outT01", "user", "outer message", "2026-07-14T10:00:00.000Z"),
          makeTurn("outT01", "agent", "outer reply", "2026-07-14T10:00:30.000Z"),
          makeTurn("m2xxxx", "user", "nested question", "2026-07-14T10:01:00.000Z"),
        ],
      }),
    );

    const inbox = await readEpisodeInbox(
      sliceId,
      "outT01",
      "2026-07-14T10:00:00.000Z",
      { useDemo: false, useGithub: false },
    );

    expect(inbox).toEqual([
      {
        turnId: "m2xxxx",
        timestamp: "2026-07-14T10:01:00.000Z",
        text: "nested question",
      },
    ]);
  });

  it("the github branch still fails loudly without a token", async () => {
    vi.stubEnv("GITHUB_TOKEN", "");
    await expect(
      readEpisodeInbox(todaySliceId(), "outT01", "2026-07-14T10:00:00.000Z", {
        useDemo: false,
        useGithub: true,
      }),
    ).rejects.toThrow(/GITHUB_TOKEN/);
  });
});

// ─── B. messages route — RETIRED (v0.33 连发并行) ────────────────────────
// The say-into-episode route was deleted with the parallel-turns batch: with
// episodeEnabled hard-off it persisted a user turn nobody answered ("一直等待").
// Mid-stream sends now start a fresh parallel turn run via POST /api/chat.

// ─── C. finalizeTurn — route-append survives the turn tail (D-2, pipeline) ─

describe("finalizeTurn disk-merge (D-2)", () => {
  it("unions the route-appended disk turn into the stale in-flight slice", async () => {
    const sliceId = todaySliceId();
    // The base BOTH sides start from: the entry beat persisted the outer user
    // turn; no agent turn exists yet (it lands only here, at finalize).
    const baseRaw = serializeSlice(
      makeSlice({
        slice_id: sliceId,
        turns: [makeTurn("outT01", "user", "outer message")],
      }),
    );
    const abs = sliceAbsPath(sliceId);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, baseRaw, "utf8");

    // The run's in-memory snapshot — STALE the moment the route commits below.
    const inFlight = parseSlice(baseRaw);

    // The messages route's disk effect, via its exact write chain.
    const routeCopy = parseSlice(readFileSync(abs, "utf8"));
    appendTurn(routeCopy, {
      timestamp: "2026-07-14T10:01:00.000Z",
      role: "user",
      content: "nested question body",
      turnId: "m2xxxx",
    });
    const routeBatch = createBatch();
    await saveSliceSnapshot(routeCopy, routeBatch);
    await flushBatch(routeBatch, "Turn m2xxxx — user message (episode)");

    const input = makeInput();
    await finalizeTurn(
      inFlight,
      { text: "final answer", finishReason: "stop", cognition: "" },
      input,
      hkFor(inFlight),
    );

    const disk = readDiskSlice(sliceId);
    expect(disk.turns.map((t) => `${t.role}:${t.turnId}`)).toEqual([
      "user:outT01",
      "user:m2xxxx",
      "agent:outT01",
    ]);
    // The nested turn survives with its BODY — a header-only husk is a fail.
    expect(disk.turns[1].content).toBe("nested question body");
    expect(disk.turns[2].content).toBe("final answer");

    // Redelivery: the same finalize re-runs against persisted state — no dupes.
    await finalizeTurn(
      inFlight,
      { text: "final answer", finishReason: "stop", cognition: "" },
      input,
      hkFor(inFlight),
    );
    const disk2 = readDiskSlice(sliceId);
    expect(disk2.turns.map((t) => `${t.role}:${t.turnId}`)).toEqual([
      "user:outT01",
      "user:m2xxxx",
      "agent:outT01",
    ]);
  });
});
