/**
 * The summary run (v0.42 §1/§2) — the burst's 被动存盘 in ONE commit.
 *
 * The episodic io layer is mocked to the in-memory map (the same pattern as
 * the old writer-run tests); the workflow runtime (registry / metadata /
 * run returnValues), the merge-line model, and the reflection-wake engine
 * are mocked. persistTurnSummary + shouldStartSummary run REAL.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

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
}));

vi.mock("@/lib/tools/local-fs", () => ({
  readFileLocal: vi.fn(async (path: string) => {
    const content = io.files.get(path);
    if (content === undefined) throw new Error(`File not found: "${path}"`);
    return content;
  }),
  listFilesLocal: vi.fn(async () => []),
  writeFileLocal: vi.fn(async (path: string, content: string) => {
    io.files.set(path, content);
    return { path, created: true };
  }),
  deleteFileLocal: vi.fn(async () => {}),
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
      list: async () => ({ data: io.registry }),
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

vi.mock("@/lib/models/provider", () => ({
  createModel: vi.fn(() => ({ _mock: "model" })),
}));
vi.mock("ai", async () => {
  const actual = await vi.importActual("ai");
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
  over: { burst?: string; createdAt?: string } = {},
) {
  return {
    runId,
    status,
    createdAt: over.createdAt ?? null,
    attributes: { slice: SLICE_ID, turn, ...(over.burst ? { burst: over.burst } : {}) },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  io.files.clear();
  io.flushes.length = 0;
  io.registry.length = 0;
  io.returnValues.clear();
  io.files.set(CORE_PATH, BASE_CORE);
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

  it("a live summary for the slice + MY turn already on disk → deduped, no flush, no bell", async () => {
    // Dedupe only stands when the owner's work covers THIS turn — seed own's
    // turns on disk first (the semantics narrowed 2026-10-21: a live summary
    // that snapshotted before this turn finished must NOT block this run).
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

    const outcome = await persistTurnSummary(payload());

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

  it("a slice that does not exist yet is materialized from the birth record (turn 0 never re-appended)", async () => {
    io.files.delete(CORE_PATH);
    io.registry.push(turnRun("summary-own", "a1b2c3", "completed"));

    const outcome = await persistTurnSummary(
      payload({
        own: ownRecord({
          birth: {
            sliceId: SLICE_ID,
            start: "2026-10-20T18:40:00.000Z",
            timezone: "Asia/Shanghai",
            turn: {
              turnId: "a1b2c3",
              timestamp: "2026-10-20T18:40:00.000Z",
              content: "我想换手机，预算 5000。",
            },
          },
        }),
      }),
    );

    expect(outcome.kind).toBe("committed");
    const core = io.files.get(CORE_PATH)!;
    // the birth user turn is turn 0 — appended ONCE, not twice
    expect(core.match(/我想换手机，预算 5000。/g)?.length).toBe(1);
    expect(core).toContain("推荐看看小屏旗舰。");
  });

  it("a member's seal closes the old page on disk (落盘归总结流, v0.42 §2)", async () => {
    const OLD_SLICE = "2026-10-20-1200";
    const OLD_CORE = "memory/records/2026/10/20/1200/core.md";
    io.files.set(
      OLD_CORE,
      `---\nslice_id: 2026-10-20-1200\nstart: 2026-10-20T12:00:00.000Z\n---\n\n## Turn u9 — 2026-10-20T12:30:00.000Z (user)\n\n旧页内容。\n`,
    );
    io.registry.push(turnRun("summary-own", "a1b2c3", "completed"));

    const outcome = await persistTurnSummary(
      payload({
        own: ownRecord({
          sealed: {
            sliceId: OLD_SLICE,
            signal: "idle_gap",
            focus: "旧话题",
            summary: "旧页已收束。",
            openLoops: [],
            decisions: [],
            end: "2026-10-20T12:30:00.000Z",
          },
        }),
      }),
    );

    expect(outcome.kind).toBe("committed");
    const oldCore = io.files.get(OLD_CORE)!;
    expect(oldCore).toContain("closed_by: idle_gap");
    expect(oldCore).toContain("旧页已收束。");
    expect(io.flushes[0].message).toContain("- sealed 2026-10-20-1200 (idle_gap)");
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
    io.registry.push(turnRun("summary-own", "a1b2c3", "completed"));

    const outcome = await persistTurnSummary(payload());

    expect(outcome.kind).toBe("nothing");
    expect(io.flushes).toHaveLength(0);
    expect(wake.deliverReflectionWake).not.toHaveBeenCalled();
  });
});

describe("shouldStartSummary — 对话流完成后查自己是不是最后一个 (v0.42 §1)", () => {
  it("a burst sibling still answering → NOT the last → no summary (不是最后一个什么都不做)", async () => {
    io.registry.push(
      turnRun("turn-sib", "x9y8z7", "running", { burst: "b1" }),
      turnRun("summary-own", "a1b2c3", "running", { burst: "b1" }),
    );

    expect(
      await shouldStartSummary({ sliceId: SLICE_ID, turnId: "a1b2c3", burstId: "b1" }),
    ).toBe(false);
  });

  it("a tail-stamped sibling yields → THIS is the last → start the summary", async () => {
    io.registry.push(
      turnRun("turn-sib", "x9y8z7", "running", { burst: "b1" }),
      turnRun("summary-own", "a1b2c3", "running", { burst: "b1" }),
    );
    io.registry[0] = {
      ...io.registry[0],
      attributes: { ...io.registry[0].attributes, phase: "tail" },
    };

    expect(
      await shouldStartSummary({ sliceId: SLICE_ID, turnId: "a1b2c3", burstId: "b1" }),
    ).toBe(true);
  });

  it("a live summary already owns the slice → no second one", async () => {
    io.registry.push(
      { runId: "summary-other", status: "running", attributes: { role: "summary", slice: SLICE_ID } },
      turnRun("summary-own", "a1b2c3", "running"),
    );

    expect(
      await shouldStartSummary({ sliceId: SLICE_ID, turnId: "a1b2c3" }),
    ).toBe(false);
  });

  it("a SOLO turn is trivially the last → its persistence must happen (no overlapping-sibling gate can skip it)", async () => {
    io.registry.push(turnRun("summary-own", "a1b2c3", "running"));

    expect(await shouldStartSummary({ sliceId: SLICE_ID, turnId: "a1b2c3" })).toBe(true);
  });
});
