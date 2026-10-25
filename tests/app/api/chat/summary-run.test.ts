/**
 * The summary run (v0.42 §1/§2) — the burst's 被动存盘 in ONE commit.
 *
 * The episodic io layer is mocked to the in-memory map (the same pattern as
 * the old writer-run tests); the workflow runtime (registry / metadata /
 * run returnValues), the merge-line model, and the reflection-wake engine
 * are mocked. persistTurnSummary + shouldStartSummary run REAL.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.hoisted(() => {
  // The edge reader (tryLoadTodaySlice) routes through io-helpers' backend
  // switch — pin the local backend (unset STORAGE resolves to demo under
  // vitest, where fsReadFile/fsListFiles would bypass our mocks).
  process.env.STORAGE = "local";
});

const io = vi.hoisted(() => ({
  files: new Map<string, string>(),
  flushes: [] as Array<{ message: string; paths: string[] }>,
  registry: [] as Array<{
    runId: string;
    status: string;
    createdAt?: string | null;
    completedAt?: string | null;
    attributes?: Record<string, string> | null;
  }>,
  returnValues: new Map<string, unknown>(),
  summaries: [] as Array<{ sha: string; sliceId: string; turnIds: string[]; message: string }>,
  registryUnavailable: false,
}));

vi.mock("@/lib/tools/local-fs", () => ({
  walkPathsLocal: vi.fn(async () => [...io.files.keys()]),
  readFileLocal: vi.fn(async (path: string) => {
    const content = io.files.get(path);
    if (content === undefined) throw new Error(`File not found: "${path}"`);
    return content;
  }),
  // A fake directory tree over io.files — tryLoadTodaySlice (the summary
  // stream's edge reader) walks day dirs through this.
  listFilesLocal: vi.fn(async (path: string) => {
    const prefix = `${path}/`;
    const names = new Set<string>();
    for (const key of io.files.keys()) {
      if (!key.startsWith(prefix)) continue;
      names.add(key.slice(prefix.length).split("/")[0]!);
    }
    return [...names].map((name) => ({
      name,
      type: (io.files.has(`${prefix}${name}`) ? "file" : "dir") as "file" | "dir",
      path: `${prefix}${name}`,
    }));
  }),
  writeFileLocal: vi.fn(async (path: string, content: string) => {
    io.files.set(path, content);
    return { path, created: true };
  }),
  deleteFileLocal: vi.fn(async () => {}),
  MAX_BINARY_FILE_SIZE_BYTES: 10 * 1024 * 1024,
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
    throw new Error("demo read should not be called");
  }),
  listFilesDemo: vi.fn(async () => []),
}));

vi.mock("@/lib/episodic", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/episodic")>();
  return {
    ...actual,
    // Deterministic mint: a landed NEW page always takes NEW_SLICE_ID (the
    // real createSlice mints from the wall clock — minute-flaky in tests).
    createSlice: vi.fn(
      (
        userMessage: string,
        timezone: string,
        turnId: string,
        continuesFrom?: string,
      ) => ({
        slice_id: NEW_SLICE_ID,
        focus: "",
        summary: "",
        status: "active" as const,
        start: "2026-10-20T05:00:00.000Z",
        timezone,
        open_loops: [] as string[],
        decisions: [] as string[],
        tags: [] as string[],
        related_slices: [] as string[],
        loops: [] as string[],
        turns: [
          {
            timestamp: "2026-10-20T05:00:00.000Z",
            role: "user" as const,
            content: userMessage,
            turnId,
          },
        ],
        estimatedTokens: 16,
        ...(continuesFrom ? { continuesFrom } : {}),
      }),
    ),
    createBatch: () => ({
      entries: new Map<string, string | null>(),
      encodings: new Map<string, "base64">(),
    }),
    flushBatch: vi.fn(
      async (batch: { entries: Map<string, string | null> }, message: string) => {
        io.flushes.push({
          message,
          paths: [...batch.entries.keys()],
        });
        for (const [p, c] of batch.entries) {
          if (c === null) io.files.delete(p);
          else io.files.set(p, c);
        }
        batch.entries.clear();
        const sha = `summary-${io.flushes.length}`;
        const sliceId = message.split("\n")[0]!.replace("Summary — ", "");
        const turnIds = [...message.matchAll(/^- (?:user turn|reply) (\S+)/gm)].map((m) => m[1]!);
        io.summaries.unshift({ sha, sliceId, turnIds, message });
        return sha;
      },
    ),
  };
});

vi.mock("workflow", () => ({
  getWorkflowMetadata: () => ({ workflowRunId: "summary-own" }),
  setAttributes: vi.fn(async () => {}),
  getWritable: () => ({
    getWriter: () => ({
      write: vi.fn(async () => {}),
      releaseLock: () => {},
    }),
  }),
}));

vi.mock("workflow/runtime", () => ({
  getWorld: async () => ({
    runs: {
      list: async () => {
        if (io.registryUnavailable) throw new Error("registry unavailable");
        return { data: io.registry };
      },
    },
  }),
}));

vi.mock("workflow/api", () => ({
  getRun: (runId: string) => ({
    returnValue: Promise.resolve(io.returnValues.get(runId)),
  }),
  start: vi.fn(),
}));

const wake = vi.hoisted(() => ({
  deliverReflectionWake: vi.fn(
    async (): Promise<{ ok: true; delivered: "rung"; runId: string }> => ({
      ok: true,
      delivered: "rung",
      runId: "hq-1",
    }),
  ),
}));
vi.mock("@/app/api/evolution/reflection-wake", () => wake);
vi.mock("@/lib/chat/hq-log", () => ({
  readSummaryLog: async () => ({ entries: io.summaries, available: true }),
  readLatestReflectionNote: async () => null,
}));

vi.mock("@/lib/models/provider", () => ({
  createModel: vi.fn(() => ({ _mock: "model" })),
}));
vi.mock("@/lib/deepseek/generate", async () => {
  const actual = await vi.importActual("@/lib/deepseek/generate");
  return {
    ...actual,
    streamText: vi.fn(() => ({
      textStream: (async function* () {
        yield "";
      })(),
    })),
  };
});

import {
  persistTurnSummary,
  shouldStartSummary,
} from "@/app/api/chat/steps";
import type {
  SummaryRunPayload,
  TurnRunResult,
} from "@/lib/chat/turn-types";

const SLICE_ID = "2026-10-20-1836";
const CORE_PATH = "memory/records/2026/10/20/1836/core.md";
const AGENT_PATH = "memory/records/2026/10/20/1836/agent.md";
/** The deterministic id the createSlice mock mints (a landed NEW page). */
const NEW_SLICE_ID = "2026-10-20-0500";
const NEW_CORE_PATH = "memory/records/2026/10/20/0500/core.md";

const BASE_CORE = `---
slice_id: 2026-10-20-1836
start: 2026-10-20T18:36:00.000Z
---

## Turn u0 — 2026-10-20T18:36:00.000Z (user)

更早的一句。
`;

function ownRecord(over: Partial<TurnRunResult> = {}): TurnRunResult {
  return {
    turnId: "a1b2c3",
    sliceId: SLICE_ID,
    at: "2026-10-20T18:40:00.000Z",
    userText: "我想换手机，预算 5000。",
    replyText: "推荐看看小屏旗舰。",
    cognition: "### Thinking\n权衡过续航。",
    ...over,
  };
}

function payload(over: Partial<SummaryRunPayload> = {}): SummaryRunPayload {
  return {
    sliceId: SLICE_ID,
    date: "2026-10-20",
    own: ownRecord(),
    slicing: { idleGapMinutes: 720, maxSliceMinutes: 30, maxTurnsPerSlice: 40 },
    clientTimezone: "Asia/Shanghai",
    modelConfig: { id: "test-model", sdk: "deepseek" } as SummaryRunPayload["modelConfig"],
    useGithub: false,
    useDemo: false,
    owner: "local",
    repo: "local",
    locale: "zh",
    ...over,
  };
}

function turnRun(
  runId: string,
  turn: string,
  status: string,
  over: { burst?: string; createdAt?: string; slice?: string } = {},
) {
  return {
    runId,
    status,
    createdAt: over.createdAt ?? null,
    attributes: {
      slice: over.slice ?? SLICE_ID,
      turn,
      ...(over.burst !== undefined ? { burst: over.burst } : {}),
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-21T12:00:00.000Z")); // yesterday's (10-20) dirs are scanned
  vi.clearAllMocks();
  io.files.clear();
  io.flushes.length = 0;
  io.registry.length = 0;
  io.returnValues.clear();
  io.summaries.length = 0;
  io.registryUnavailable = false;
  io.files.set(CORE_PATH, BASE_CORE);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("persistTurnSummary — ONE commit for the burst's 被动存盘 (v0.42 §2)", () => {
  it("two completed siblings + one failed → ONE flush: 2 user turns + 2 replies + cognition + merge; the failed one recorded honestly", async () => {
    io.registry.push(
      turnRun("turn-t1", "t1x2y3", "completed", { burst: "b1", createdAt: "2026-10-20T18:37:00.000Z" }),
      turnRun("turn-t2", "t2y3z4", "failed", { burst: "b1" }),
      turnRun("summary-own", "a1b2c3", "completed", { burst: "b1" }),
    );
    io.returnValues.set("turn-t1", {
      turnId: "t1x2y3",
      sliceId: SLICE_ID,
      at: "2026-10-20T18:37:00.000Z",
      userText: "不是包子，是饺子。",
      replyText: "记住了，是饺子。",
      cognition: "### Thinking\n纠正识别。",
      burstId: "b1",
    } satisfies TurnRunResult);

    const outcome = await persistTurnSummary(
      payload({ burstId: "b1", own: ownRecord({ mergeLine: "统一更正：是饺子，不是包子。" }) }),
    );

    expect(outcome.kind).toBe("committed");
    // exactly ONE commit…
    expect(io.flushes).toHaveLength(1);
    // …named by the new prefix, its body naming what landed + the honest gap
    expect(io.flushes[0].message).toMatch(/^Summary — 2026-10-20-1836\n\n/);
    expect(io.flushes[0].message).toContain("- user turn t1x2y3");
    expect(io.flushes[0].message).toContain("- reply a1b2c3");
    expect(io.flushes[0].message).toContain("- merge a1b2c3");
    expect(io.flushes[0].message).toContain("- 第 t2y3z4 条没答成（failed）");
    // the slice carries both members' user turns + replies + the merge…
    const core = io.files.get(CORE_PATH)!;
    expect(core).toContain("不是包子，是饺子。");
    expect(core).toContain("记住了，是饺子。");
    expect(core).toContain("我想换手机，预算 5000。");
    expect(core).toContain("推荐看看小屏旗舰。");
    expect(core).toContain("统一更正：是饺子，不是包子。");
    expect(core.match(/^## Turn/gm)?.length).toBe(6); // 旧1 + 2×user + 2×reply + 1×merge
    // …both cognitions land on the slice's agent timeline…
    const agent = io.files.get(AGENT_PATH)!;
    expect(agent).toContain("## Cognition t1x2y3");
    expect(agent).toContain("## Cognition a1b2c3");
    // …and the failed sibling's answer is NOWHERE in the slice
    expect(core).not.toContain("t2y3z4");
  });

  it("rings the reflection bell exactly ONCE after the commit, carrying {sliceId, turnRange} (v0.42 §4)", async () => {
    io.registry.push(turnRun("summary-own", "a1b2c3", "completed"));

    const outcome = await persistTurnSummary(payload());

    expect(outcome.kind).toBe("committed");
    expect(wake.deliverReflectionWake).toHaveBeenCalledTimes(1);
    // ringReflection's label is a log aid only — the range is the argument.
    expect(wake.deliverReflectionWake).toHaveBeenCalledWith({
      sliceId: SLICE_ID,
      turnIds: ["a1b2c3"],
    });
  });

  it("review-1. evidence attachments ride the result → the summary commit lands the file AND the user turn carries [attachments: …]", async () => {
    io.registry.push(turnRun("summary-own", "a1b2c3", "completed"));
    const outcome = await persistTurnSummary(
      payload({
        own: ownRecord({
          attachments: [{ name: "屏幕截图.png", dataBase64: Buffer.from("PNG-BYTES").toString("base64") }],
        }),
      }),
    );

    expect(outcome.kind).toBe("committed");
    // the binary rode the SAME batch — one flush, the file among the paths
    expect(io.flushes).toHaveLength(1);
    const attachPath = io.flushes[0]!.paths.find((p) =>
      p.startsWith("memory/records/2026/10/20/1836/attachments/"),
    );
    expect(attachPath).toBeDefined();
    expect(attachPath).toContain("a1b2c3-");
    expect(io.files.get(attachPath!)).toBe(Buffer.from("PNG-BYTES").toString("base64"));
    // …and the persisted user turn names its evidence
    const core = io.files.get(CORE_PATH)!;
    expect(core).toContain("[attachments:");
    expect(core).toContain("a1b2c3-");
  });

  it("review-1b. an over-fuse attachment is SKIPPED at the summary with a visible reason (the moved fuse verdict) — the turn still lands", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      io.registry.push(turnRun("summary-own", "a1b2c3", "completed"));
      const big = Buffer.alloc(5 * 1024 * 1024 + 1, 1);
      const outcome = await persistTurnSummary(
        payload({
          own: ownRecord({
            attachments: [{ name: "big.pdf", dataBase64: big.toString("base64") }],
          }),
        }),
      );

      expect(outcome.kind).toBe("committed");
      expect(
        io.flushes[0]!.paths.some((p) => p.includes("attachments/")),
      ).toBe(false);
      expect(
        warn.mock.calls.some(
          (c) => typeof c[0] === "string" && c[0].includes("[Attachments] skipped big.pdf"),
        ),
      ).toBe(true);
      // the user turn itself still landed — only the file was refused
      expect(io.files.get(CORE_PATH)!).toContain("我想换手机");
      expect(io.files.get(CORE_PATH)!).not.toContain("[attachments:");
    } finally {
      warn.mockRestore();
    }
  });

  it("review-2. a mid-life previously snapshot for an EXISTING slice rides the result → lands in the summary commit", async () => {
    io.registry.push(turnRun("summary-own", "a1b2c3", "completed"));
    const outcome = await persistTurnSummary(
      payload({ own: ownRecord({ previously: "---\ncard: 更新后的用户模型\n---\n" }) }),
    );

    expect(outcome.kind).toBe("committed");
    expect(io.flushes[0]!.paths).toContain(
      "memory/records/2026/10/20/1836/previously.md",
    );
    expect(io.files.get("memory/records/2026/10/20/1836/previously.md")).toContain(
      "更新后的用户模型",
    );
  });

  it("review-1+2. the MINIMAL (degraded) commit carries the riders too — the user evidence is never the thing that gets dropped", async () => {
    const { flushBatch } = await import("@/lib/episodic");
    vi.mocked(flushBatch)
      .mockRejectedValueOnce(new Error("blip one"))
      .mockRejectedValueOnce(new Error("blip two"));
    io.registry.push(turnRun("summary-own", "a1b2c3", "completed"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const outcome = await persistTurnSummary(
        payload({
          own: ownRecord({
            previously: "快照内容",
            attachments: [{ name: "照片.png", dataBase64: Buffer.from("BYTES").toString("base64") }],
          }),
        }),
      );
      expect(outcome.kind).toBe("committed");
      // 3 flushBatch CALLS (2 rejected attempts + the minimal commit), but
      // only the minimal commit RECORDS a flush.
      expect(vi.mocked(flushBatch).mock.calls.length).toBe(3);
      expect(
        vi.mocked(flushBatch).mock.calls[2]![1] as string,
      ).toContain("degraded commit");
      expect(io.flushes).toHaveLength(1);
      expect(
        io.flushes[0]!.paths.some((p) => p.includes("attachments/a1b2c3-")),
      ).toBe(true);
      expect(io.files.get("memory/records/2026/10/20/1836/previously.md")).toContain("快照内容");
      expect(io.files.get(CORE_PATH)!).toContain("[attachments:");
    } finally {
      warn.mockRestore();
    }
  });

  it("a. ONE burst across DIFFERENT entry shells (0837/0838): the survivor's member collection gathers BOTH turns — one commit, two user turns + two replies", async () => {
    io.registry.push(
      turnRun("turn-a", "YjTtMg", "completed", { burst: "ead59415", slice: "2026-10-20-0837", createdAt: "2026-10-20T08:37:56.000Z" }),
      turnRun("summary-own", "a1b2c3", "completed", { burst: "ead59415", slice: "2026-10-20-0838" }),
    );
    io.returnValues.set("turn-a", {
      turnId: "YjTtMg",
      sliceId: "2026-10-20-0837",
      at: "2026-10-20T08:37:56.000Z",
      userText: "第一条",
      replyText: "第一条的回答。",
      cognition: "",
      burstId: "ead59415",
    } satisfies TurnRunResult);

    const outcome = await persistTurnSummary(payload({ burstId: "ead59415", own: ownRecord({ cognition: "" }) }));

    expect(outcome.kind).toBe("committed");
    expect(io.flushes).toHaveLength(1);
    expect(io.flushes[0]!.message).toContain("- user turn YjTtMg");
    expect(io.flushes[0]!.message).toContain("- reply YjTtMg");
    expect(io.flushes[0]!.message).toContain("- user turn a1b2c3");
    expect(io.flushes[0]!.message).toContain("- reply a1b2c3");
    const core = io.files.get(CORE_PATH)!; // the judged landing (the seeded edge)
    expect(core).toContain("第一条");
    expect(core).toContain("第一条的回答。");
    expect(core).toContain("推荐看看小屏旗舰。");
  });

  it("b2. my turn already on disk → deduped (f2f4f80) — regardless of any live summary", async () => {
    io.files.set(
      CORE_PATH,
      BASE_CORE +
        "\n## Turn a1b2c3 — 2026-10-20T18:40:00.000Z (user)\n\n我想换手机，预算 5000。\n" +
        "\n## Turn a1b2c3 — 2026-10-20T18:40:00.000Z (agent)\n\n推荐看看小屏旗舰。\n",
    );
    io.registry.push(
      { runId: "summary-other", status: "running", attributes: { role: "summary", slice: "2026-10-20-0837", burst: "ead59415" } },
      turnRun("summary-own", "a1b2c3", "completed", { burst: "ead59415", slice: "2026-10-20-0838" }),
    );

    const outcome = await persistTurnSummary(payload({ burstId: "ead59415", own: ownRecord({ cognition: "" }) }));

    expect(outcome.kind).toBe("deduped");
    expect(io.flushes).toHaveLength(0);
  });

  it("b3. a live summary is running but MY turn is NOT on disk → I proceed and write it — no whole-run exit (the real-machine loss)", async () => {
    // The live summary cannot see this turn (cross-shell enumeration gaps);
    // exiting here would lose the turn forever. The incremental append
    // converges under the live summary instead.
    io.registry.push(
      { runId: "summary-other", status: "running", attributes: { role: "summary", slice: "2026-10-20-0837", burst: "ead59415" } },
      turnRun("summary-own", "a1b2c3", "completed", { burst: "ead59415", slice: "2026-10-20-0838" }),
    );

    const outcome = await persistTurnSummary(payload({ burstId: "ead59415" }));

    expect(outcome.kind).toBe("committed");
    expect(io.flushes).toHaveLength(1);
    const core = io.files.get(CORE_PATH)!;
    expect(core).toContain("我想换手机，预算 5000。");
    expect(core).toContain("推荐看看小屏旗舰。");
  });

  it("c. NO burstId: a completed run on a DIFFERENT slice is NOT a member, and a live summary on another slice does NOT dedupe (legacy shape unchanged)", async () => {
    io.registry.push(
      turnRun("turn-other", "zz9yy8", "completed", { slice: "2026-10-20-0837" }),
      { runId: "summary-other", status: "running", attributes: { role: "summary", slice: "2026-10-20-0837" } },
      turnRun("summary-own", "a1b2c3", "completed"),
    );
    io.returnValues.set("turn-other", {
      turnId: "zz9yy8",
      sliceId: "2026-10-20-0837",
      at: "2026-10-20T08:39:00.000Z",
      userText: "别片的轮",
      replyText: "不该被收。",
      cognition: "",
    } satisfies TurnRunResult);

    const outcome = await persistTurnSummary(payload());

    // own is not on disk → proceeds and lands; the cross-slice run is NOT a
    // member without a burst id (legacy shape unchanged), and the live
    // summary on the other slice does not gate anything.
    expect(outcome.kind).toBe("committed");
    const core = io.files.get(CORE_PATH)!;
    expect(core).not.toContain("别片的轮");
    expect(core).toContain("推荐看看小屏旗舰。");
  });

  it("my turn already on disk → deduped, no flush, no bell (f2f4f80 — the only dedupe; a live summary is irrelevant to it)", async () => {
    io.files.set(
      CORE_PATH,
      BASE_CORE +
        "\n## Turn a1b2c3 — 2026-10-20T18:40:00.000Z (user)\n\n我想换手机，预算 5000。\n" +
        "\n## Turn a1b2c3 — 2026-10-20T18:40:00.000Z (agent)\n\n推荐看看小屏旗舰。\n",
    );
    io.registry.push(
      { runId: "summary-other", status: "running", attributes: { role: "summary", slice: SLICE_ID } },
      turnRun("summary-own", "a1b2c3", "completed"),
    );

    const outcome = await persistTurnSummary(payload({ own: ownRecord({ cognition: "" }) }));

    expect(outcome.kind).toBe("deduped");
    expect(io.flushes).toHaveLength(0);
    expect(wake.deliverReflectionWake).not.toHaveBeenCalled();
  });

  it("a. the real-machine shape: A's summary runs while B is still answering → A lands (NOT deduped, NO failure note for B); then B's summary also lands → 2 user turns + 2 replies", async () => {
    // Turn A completed; turn B STILL RUNNING; ANOTHER summary run holds the
    // token (it snapshotted before this turn existed — the 2026-10-21 bug).
    io.registry.push(
      turnRun("turn-a", "AR6sLw", "completed", { burst: "b1" }),
      turnRun("turn-b", "6OMTsQ", "running", { burst: "b1" }),
      turnRun("summary-own", "a1b2c3", "running"),
      { runId: "summary-other", status: "running", attributes: { role: "summary", slice: SLICE_ID } },
    );
    io.returnValues.set("turn-a", {
      turnId: "AR6sLw",
      sliceId: SLICE_ID,
      at: "2026-10-20T04:03:00.000Z",
      userText: "第一条",
      replyText: "第一条的回答。",
      cognition: "",
      burstId: "b1",
    } satisfies TurnRunResult);
    const ownA: TurnRunResult = {
      turnId: "a1b2c3",
      sliceId: SLICE_ID,
      at: "2026-10-20T04:04:00.000Z",
      userText: "我自己的那条",
      replyText: "我自己的回答。",
      cognition: "",
      burstId: "b1",
    };

    // A's survivor: the live summary must NOT block it (its own reply is not
    // on disk), and the running B must NOT be recorded as a failure.
    const first = await persistTurnSummary(payload({ burstId: "b1", own: ownA }));
    expect(first.kind).toBe("committed");
    expect(io.flushes).toHaveLength(1);
    expect(io.flushes[0]!.message).not.toContain("没答成"); // b. running ≠ failure
    let core = io.files.get(CORE_PATH)!;
    expect(core).toContain("第一条的回答。");
    expect(core).toContain("我自己的回答。");

    // B finishes; ITS last-one check starts a second summary run. The first
    // summary is done; nothing dedupes B — and A's turns are already on disk
    // so A is not re-collected. B's record rides THIS payload (the run reads
    // completed siblings only for turns it does not own).
    io.registry.length = 0;
    io.registry.push(
      turnRun("turn-a", "AR6sLw", "completed", { burst: "b1" }),
      turnRun("summary-own-2", "6OMTsQ", "running"),
    );
    const ownB: TurnRunResult = {
      turnId: "6OMTsQ",
      sliceId: SLICE_ID,
      at: "2026-10-20T04:05:00.000Z",
      userText: "第二条",
      replyText: "第二条的回答。",
      cognition: "",
      burstId: "b1",
    };
    const second = await persistTurnSummary(payload({ burstId: "b1", own: ownB }));
    expect(second.kind).toBe("committed");

    core = io.files.get(CORE_PATH)!;
    expect(core).toContain("第一条");
    expect(core).toContain("第一条的回答。");
    expect(core).toContain("第二条");
    expect(core).toContain("第二条的回答。");
    // the final record: the old turn + two user turns + two replies — nothing lost
    // (burst turns carry a "[burst b1]" header segment — no end anchor).
    expect(core.match(/^## Turn .* \(user\)/gm)?.length).toBe(4);
    expect(core.match(/^## Turn .* \(agent\)/gm)?.length).toBe(3);
    expect(io.flushes).toHaveLength(2);
  });

  it("LANDING (the real-machine bug): no edge on disk + two members 8s apart across a minute → ONE fresh slice, BOTH land — not two slices", async () => {
    io.files.delete(CORE_PATH); // no edge
    io.registry.push(
      turnRun("turn-a", "AR6sLw", "completed", { burst: "b1", createdAt: "2026-10-20T04:17:56.000Z" }),
      turnRun("summary-own", "a1b2c3", "completed", { burst: "b1" }),
    );
    io.returnValues.set("turn-a", {
      turnId: "AR6sLw",
      sliceId: SLICE_ID,
      at: "2026-10-20T04:17:56.000Z",
      userText: "第一条",
      replyText: "第一条的回答。",
      cognition: "",
      burstId: "b1",
    } satisfies TurnRunResult);
    // the second member crosses the minute (04:17:56 → 04:18:04)
    const own = ownRecord({ at: "2026-10-20T04:18:04.000Z", burstId: "b1" });

    const outcome = await persistTurnSummary(payload({ burstId: "b1", own }));

    expect(outcome.kind).toBe("committed");
    expect(io.flushes).toHaveLength(1); // ONE commit…
    expect(io.flushes[0]!.message).toContain(`Summary — ${NEW_SLICE_ID}`);
    expect(io.flushes[0]!.paths).toContain(NEW_CORE_PATH);
    expect(io.flushes[0]!.paths).not.toContain(CORE_PATH);
    const core = io.files.get(NEW_CORE_PATH)!;
    expect(core).toContain("第一条"); // …carrying BOTH members
    expect(core).toContain("第一条的回答。");
    expect(core.match(/我想换手机，预算 5000。/g)?.length).toBe(1); // own's user turn once
    expect(core).toContain("推荐看看小屏旗舰。");
  });

  it("LANDING b. idle gap beyond the threshold → TWO pages: the edge sealed idle_gap, the batch lands in a NEW slice WITHOUT continuesFrom", async () => {
    io.files.set(
      CORE_PATH,
      `---
slice_id: 2026-10-20-1836
start: 2026-10-20T01:00:00.000Z
---

## Turn u0 — 2026-10-20T01:00:00.000Z (user)

凌晨那句。
`,
    );
    io.registry.push(turnRun("summary-own", "a1b2c3", "completed"));
    const own = ownRecord({ at: "2026-10-20T03:00:00.000Z" }); // 2h silence ≥ 60min

    const outcome = await persistTurnSummary(
      payload({ own, slicing: { idleGapMinutes: 60, maxSliceMinutes: 30, maxTurnsPerSlice: 40 } }),
    );

    expect(outcome.kind).toBe("committed");
    // the edge is sealed as a conversation boundary…
    const edgeCore = io.files.get(CORE_PATH)!;
    expect(edgeCore).toContain("closed_by: idle_gap");
    // …and the batch lands in a fresh page with NO checkpoint link
    const { parseSlice } = await import("@/lib/episodic");
    expect(parseSlice(io.files.get(NEW_CORE_PATH)!).continuesFrom).toBeUndefined();
    expect(io.files.get(NEW_CORE_PATH)!).toContain("我想换手机，预算 5000。");
    expect(io.flushes[0]!.message).toContain("- sealed 2026-10-20-1836 (idle_gap)");
  });

  it("LANDING c. the time cap → the edge sealed time_cap, the NEW slice carries continuesFrom to it (checkpoint)", async () => {
    io.files.set(
      CORE_PATH,
      `---
slice_id: 2026-10-20-1836
start: 2026-10-20T02:30:00.000Z
---

## Turn u0 — 2026-10-20T02:31:00.000Z (user)

半小时前那句。
`,
    );
    io.registry.push(turnRun("summary-own", "a1b2c3", "completed"));
    const own = ownRecord({ at: "2026-10-20T03:00:00.000Z" }); // 30min ≥ cap

    const outcome = await persistTurnSummary(
      payload({ own, slicing: { idleGapMinutes: 720, maxSliceMinutes: 30, maxTurnsPerSlice: 40 } }),
    );

    expect(outcome.kind).toBe("committed");
    expect(io.files.get(CORE_PATH)!).toContain("closed_by: time_cap");
    const { parseSlice } = await import("@/lib/episodic");
    const landed = parseSlice(io.files.get(NEW_CORE_PATH)!);
    expect(landed.continuesFrom).toBe(SLICE_ID); // the SAME conversation continues
    expect(landed.turns.some((t) => t.content.includes("我想换手机"))).toBe(true);
  });

  it("LANDING c2. the capacity cap → sealed capacity, continuesFrom carried", async () => {
    io.files.set(
      CORE_PATH,
      `---
slice_id: 2026-10-20-1836
start: 2026-10-20T18:39:00.000Z
---

## Turn u1 — 2026-10-20T18:39:01.000Z (user)

一。

## Turn u2 — 2026-10-20T18:39:02.000Z (user)

二。

## Turn u3 — 2026-10-20T18:39:03.000Z (user)

三。
`,
    );
    io.registry.push(turnRun("summary-own", "a1b2c3", "completed"));
    const outcome = await persistTurnSummary(
      payload({
        slicing: { idleGapMinutes: 720, maxSliceMinutes: 30, maxTurnsPerSlice: 2 }, // 3 turns ≥ 2
      }),
    );
    expect(outcome.kind).toBe("committed");
    expect(io.files.get(CORE_PATH)!).toContain("closed_by: capacity");
    const { parseSlice } = await import("@/lib/episodic");
    expect(parseSlice(io.files.get(NEW_CORE_PATH)!).continuesFrom).toBe(SLICE_ID);
  });

  it("LANDING d. a SOLO turn with a live edge → continues the edge, NO new page", async () => {
    io.registry.push(turnRun("summary-own", "a1b2c3", "completed"));
    const outcome = await persistTurnSummary(payload());
    expect(outcome.kind).toBe("committed");
    expect(io.files.has(NEW_CORE_PATH)).toBe(false);
    expect(io.files.get(CORE_PATH)!).toContain("推荐看看小屏旗舰。");
    expect(io.flushes).toHaveLength(1);
  });

  it("b. the full summary's first attempt fails transiently → ONE bounded retry succeeds", async () => {
    const { flushBatch } = await import("@/lib/episodic");
    vi.mocked(flushBatch).mockRejectedValueOnce(new Error("provider blip"));
    io.registry.push(turnRun("summary-own", "a1b2c3", "completed"));

    const outcome = await persistTurnSummary(payload());

    expect(outcome.kind).toBe("committed");
    // one flush per attempt — the retry re-ran the whole assembly
    expect(vi.mocked(flushBatch).mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(wake.deliverReflectionWake).toHaveBeenCalledTimes(1);
  });

  it("c. two consecutive failures → the MINIMAL commit lands (user turn + produced reply) through the SAME flush path, degraded-note in the body", async () => {
    const { flushBatch } = await import("@/lib/episodic");
    vi.mocked(flushBatch)
      .mockRejectedValueOnce(new Error("blip one"))
      .mockRejectedValueOnce(new Error("blip two"));
    io.registry.push(turnRun("summary-own", "a1b2c3", "completed"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const outcome = await persistTurnSummary(payload());

      expect(outcome.kind).toBe("committed");
      // 2 full-pass attempts + the minimal commit's own flush — one channel.
      expect(vi.mocked(flushBatch).mock.calls.length).toBe(3);
      const minimalMessage = vi.mocked(flushBatch).mock.calls[2]![1] as string;
      expect(minimalMessage).toContain("Summary — 2026-10-20-1836");
      expect(minimalMessage).toContain("degraded commit");
      const core = io.files.get(CORE_PATH)!;
      expect(core).toContain("我想换手机，预算 5000。"); // 用户那句话 — the floor
      expect(core).toContain("推荐看看小屏旗舰。"); // the produced reply
      expect(io.files.has(AGENT_PATH)).toBe(false); // no cognition rider in the minimal commit
      expect(wake.deliverReflectionWake).toHaveBeenCalledTimes(1); // the minimal commit still rings
    } finally {
      warn.mockRestore();
    }
  });

  it("THREE consecutive flush failures (both attempts + the minimal commit) → { kind: \"failed\" }, honestly — and NEVER rings the bell", async () => {
    const { flushBatch } = await import("@/lib/episodic");
    // one rejection per flush: attempt 1, attempt 2, the minimal commit.
    vi.mocked(flushBatch)
      .mockRejectedValueOnce(new Error("disk full"))
      .mockRejectedValueOnce(new Error("disk full"))
      .mockRejectedValueOnce(new Error("disk full"));
    io.registry.push(turnRun("summary-own", "a1b2c3", "completed"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const outcome = await persistTurnSummary(payload());
      expect(outcome.kind).toBe("failed");
      expect(outcome.error).toContain("disk full");
      expect(wake.deliverReflectionWake).not.toHaveBeenCalled();
      // the minimal commit could not land either — nothing is on the disk
      expect(io.files.get(CORE_PATH)).toBe(BASE_CORE);
    } finally {
      warn.mockRestore();
    }
  });

  it("everything already persisted (the losing racer) → nothing, no flush, no bell", async () => {
    io.files.set(
      CORE_PATH,
      BASE_CORE +
        "\n## Turn a1b2c3 — 2026-10-20T18:40:00.000Z (user)\n\n我想换手机，预算 5000。\n" +
        "\n## Turn a1b2c3 — 2026-10-20T18:40:00.000Z (agent)\n\n推荐看看小屏旗舰。\n",
    );
    io.files.set(
      AGENT_PATH,
      `## Cognition a1b2c3 — 2026-10-20T18:40:00.000Z
### Thinking
权衡过续航。`,
    );
    io.registry.push(turnRun("summary-own", "a1b2c3", "completed"));

    const outcome = await persistTurnSummary(payload());

    // own-on-disk IS the dedupe condition now — the run exits as "deduped"
    // (the older "nothing" tail is unreachable for an on-disk own turn).
    expect(outcome.kind).toBe("deduped");
    expect(io.flushes).toHaveLength(0);
    expect(wake.deliverReflectionWake).not.toHaveBeenCalled();
  });
});

describe("shouldStartSummary — 每一轮都唤起总结流，总结流只做增量 (v0.42 §1, election-free)", () => {
  it("burst path: EVERY turn returns true — a live sibling, a live summary, any registry shape (the summary run dedupes on its own)", async () => {
    io.registry.push(
      turnRun("turn-sib", "x9y8z7", "running", { burst: "b1" }),
      { runId: "summary-other", status: "running", attributes: { role: "summary", slice: SLICE_ID, burst: "b1" } },
      turnRun("summary-own", "a1b2c3", "running", { burst: "b1" }),
    );

    expect(
      await shouldStartSummary({ sliceId: SLICE_ID, turnId: "a1b2c3", burstId: "b1" }),
    ).toBe(true);
  });

  it("d. NO burstId → the legacy overlap path is unchanged: a blocking sibling still yields", async () => {
    io.registry.push(
      turnRun("turn-sib", "x9y8z7", "running"),
      turnRun("summary-own", "a1b2c3", "running"),
    );

    expect(
      await shouldStartSummary({ sliceId: SLICE_ID, turnId: "a1b2c3" }),
    ).toBe(false);
  });

  it("d2. NO burstId + no live siblings → true (solo persistence, unchanged)", async () => {
    io.registry.push(turnRun("summary-own", "a1b2c3", "running"));

    expect(await shouldStartSummary({ sliceId: SLICE_ID, turnId: "a1b2c3" })).toBe(true);
  });
});

describe("summary persistence identity regressions", () => {
  it("returns exact saved task proofs for every burst member, including an earlier sibling", async () => {
    const sibling = ownRecord({
      turnId: "sibling-with-intent", at: "2026-10-20T18:39:00.000Z", cognition: "",
      replyText: "Earlier member delivered its result.", finishReason: "stop", sourceRunId: "source-sibling",
      taskAckIntents: [{ kind: "result", resultId: "earlier-result", expectedRevision: 1 }],
    });
    io.registry.push(turnRun("source-sibling", sibling.turnId, "completed"));
    io.returnValues.set("source-sibling", sibling);
    const input = payload({ own: ownRecord({ cognition: "", taskAckIntents: [] }) });
    const saved = await persistTurnSummary(input);
    expect(saved.kind).toBe("committed");
    expect(saved.verifiedTaskReplies).toEqual([{
      reply: { status: "persisted", sliceId: SLICE_ID, turnId: sibling.turnId },
      sourceRunId: "source-sibling", finishReason: "stop", taskAckIntents: sibling.taskAckIntents,
    }]);
    expect(io.files.get(CORE_PATH)).toContain(sibling.replyText);
    const replay = await persistTurnSummary(input);
    expect(replay.kind).toBe("deduped");
    expect(replay.verifiedTaskReplies).toEqual(saved.verifiedTaskReplies);
  });

  it("preserves nested child task metadata only after its exact answer is saved", async () => {
    const child = {
      turnId: "nested-task-answer", replyTo: "nested-question", text: "The child delivered the result.",
      sourceRunId: "source-nested", finishReason: "stop",
      taskAckIntents: [{ kind: "result" as const, resultId: "nested-result", expectedRevision: 1 }],
    };
    const input = payload({ own: ownRecord({ cognition: "", nestedReplies: [child] }) });
    const saved = await persistTurnSummary(input);
    expect(saved.kind).toBe("committed");
    expect(saved.verifiedTaskReplies).toEqual([{
      reply: { status: "persisted", sliceId: SLICE_ID, turnId: child.turnId },
      sourceRunId: child.sourceRunId, finishReason: "stop", taskAckIntents: child.taskAckIntents,
    }]);
    expect(io.files.get(CORE_PATH)).toContain(child.text);
    expect(saved.receipt?.records[0]?.turnIds).toContain(child.turnId);
    const replay = await persistTurnSummary(input);
    expect(replay.kind).toBe("deduped");
    expect(replay.verifiedTaskReplies).toEqual(saved.verifiedTaskReplies);

    // The same id with a different answer is not proof of that new text.
    const mismatch = await persistTurnSummary({ ...input, own: {
      ...input.own, nestedReplies: [{ ...child, text: "Never actually saved" }],
    } });
    expect(mismatch.verifiedTaskReplies).toBeUndefined();
    expect(io.files.get(CORE_PATH)).not.toContain("Never actually saved");
  });

  it("does not copy a saved burst member when the next member crosses capacity", async () => {
    const first = ownRecord({ turnId: "first1", cognition: "", burstId: "b1" });
    const slicing = { idleGapMinutes: 720, maxSliceMinutes: 30, maxTurnsPerSlice: 3 };
    await persistTurnSummary(payload({ burstId: "b1", own: first, slicing }));
    io.registry.push(turnRun("turn-first", "first1", "completed", { burst: "b1" }));
    io.returnValues.set("turn-first", first);
    await persistTurnSummary(payload({ burstId: "b1", slicing, own: ownRecord({ turnId: "second2", at: "2026-10-20T18:40:05.000Z", cognition: "", burstId: "b1" }) }));
    const cores = [...io.files.entries()].filter(([p]) => p.endsWith("/core.md"));
    expect(cores.reduce((n, [, raw]) => n + (raw.match(/^## Turn first1 .*\(agent\)/gm)?.length ?? 0), 0)).toBe(1);
  });

  it("regeneration preserves the original question and records the new answer", async () => {
    io.files.set(CORE_PATH, BASE_CORE + "\n## Turn old123 — 2026-10-20T18:39:00.000Z (user)\n\n我想换手机，预算 5000。\n\n## Turn old123 — 2026-10-20T18:39:00.000Z (agent)\n\n旧答案。\n");
    await persistTurnSummary(payload({ own: { ...ownRecord({ turnId: "regen1" }), regenerate: true, clientMessageId: "message-1" } }));
    const raw = io.files.get(CORE_PATH)!;
    expect(raw.match(/我想换手机，预算 5000。/g)).toHaveLength(1);
    expect(raw).toContain("[reply-to old123]");
    expect(raw).toContain("旧答案。");
  });

  it("the carried own record survives an unavailable registry", async () => {
    io.registryUnavailable = true;
    const result = await persistTurnSummary(payload());
    expect(result.kind).toBe("committed");
    expect(io.files.get(CORE_PATH)).toContain("推荐看看小屏旗舰。");
  });
});
