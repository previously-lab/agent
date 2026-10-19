/**
 * The writer run (v0.38 §3.2/§4) — writer-per-turn over an in-memory local
 * fs: ONE step, ONE batch, ONE commit; single-flight = dedupe by turnId;
 * the bell rings after EVERY successful commit (pure doorbell, v0.38 §3.3 —
 * sealing the slice is NOT the trigger).
 *
 * The episodic io layer is mocked to the in-memory map (the same pattern as
 * steps.test.ts); the workflow runtime (registry / metadata / stream) and
 * the reflection-wake engine are mocked. commitWriterTurn runs REAL.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const io = vi.hoisted(() => ({
  files: new Map<string, string>(),
  flushes: [] as Array<{ message: string; paths: string[] }>,
  registry: [] as Array<{
    runId: string;
    status: string;
    attributes?: Record<string, string> | null;
  }>,
  returnValues: new Map<string, unknown>(),
  mergeModelText: "" as string,
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
    flushBatch: vi.fn(async (batch: { entries: Map<string, string | null> }, message: string) => {
      io.flushes.push({
        message,
        paths: [...batch.entries.keys()],
      });
      for (const [p, c] of batch.entries) {
        if (c === null) io.files.delete(p);
        else io.files.set(p, c);
      }
      batch.entries.clear();
    }),
  };
});

vi.mock("workflow", () => ({
  getWorkflowMetadata: () => ({ workflowRunId: "writer-own" }),
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
}));

const wake = vi.hoisted(() => ({
  deliverReflectionWake: vi.fn(
    async (): Promise<
      | { ok: true; delivered: "rung" | "started"; runId: string }
      | { ok: false; reason: string }
    > => ({ ok: true, delivered: "rung", runId: "hq-1" }),
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
        yield io.mergeModelText;
      })(),
    })),
  };
});

import {
  commitWriterTurn,
  decideBurstMergeLine,
  type BurstMergeParams,
} from "@/app/api/chat/steps";
import type { WriterRunPayload } from "@/lib/chat/turn-types";

const SLICE_ID = "2026-10-14-1836";
const CORE_PATH = "memory/records/2026/10/14/1836/core.md";

const BASE_CORE = `---
slice_id: 2026-10-14-1836
start: 2026-10-14T18:36:00.000Z
---

## Turn u1 — 2026-10-14T18:36:00.000Z (user)

我想换手机，预算 5000。
`;

function payload(overrides: Partial<WriterRunPayload> = {}): WriterRunPayload {
  return {
    sliceId: SLICE_ID,
    turnId: "a1b2c3",
    replyText: "推荐看看小屏旗舰。",
    cognition: "### Thinking\n权衡过续航。",
    date: "2026-10-14",
    useGithub: false,
    useDemo: false,
    owner: "local",
    repo: "local",
    locale: "zh",
    model: "test-model",
    modelConfig: { id: "test-model", sdk: "deepseek" } as WriterRunPayload["modelConfig"],
    ...overrides,
  };
}

function mergeParams(overrides: Partial<BurstMergeParams> = {}): BurstMergeParams {
  return {
    sliceId: SLICE_ID,
    turnId: "a1b2c3",
    ownReplyText: "我自己的回答。",
    locale: "zh",
    model: "test-model",
    modelConfig: { id: "test-model", sdk: "deepseek" } as BurstMergeParams["modelConfig"],
    useGithub: false,
    useDemo: false,
    owner: "local",
    repo: "local",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  io.files.clear();
  io.flushes.length = 0;
  io.registry.length = 0;
  io.returnValues.clear();
  io.mergeModelText = "";
  io.files.set(CORE_PATH, BASE_CORE);
});

describe("commitWriterTurn — one step, one batch, one commit (v0.38 §4)", () => {
  it("commits reply + cognition + snapshot in ONE flush named `Turn {turnId} — reply`", async () => {
    const outcome = await commitWriterTurn(payload());

    expect(outcome.kind).toBe("committed");
    expect(outcome.segments).toEqual(["reply", "cognition", "snapshot"]);
    expect(io.flushes).toHaveLength(1);
    expect(io.flushes[0].message).toMatch(/^Turn a1b2c3 — reply\n\n- reply\n- cognition\n- snapshot$/);
    const core = io.files.get(CORE_PATH)!;
    expect(core).toContain("推荐看看小屏旗舰。");
    // the reply turn carries NO burst segment without a burstId
    expect(core).not.toContain("[burst");
  });

  it("a live writer for the SAME turnId → deduped, no writes, no flush", async () => {
    io.registry.push({
      runId: "writer-other",
      status: "running",
      attributes: { role: "writer", slice: SLICE_ID, turn: "a1b2c3" },
    });

    const outcome = await commitWriterTurn(payload());

    expect(outcome.kind).toBe("deduped");
    expect(io.flushes).toHaveLength(0);
    expect(io.files.get(CORE_PATH)).toBe(BASE_CORE);
  });

  it("a live writer for a DIFFERENT turnId does NOT block this commit (并发合法)", async () => {
    io.registry.push({
      runId: "writer-sibling",
      status: "running",
      attributes: { role: "writer", slice: SLICE_ID, turn: "zzzzzz" },
    });

    const outcome = await commitWriterTurn(payload());

    expect(outcome.kind).toBe("committed");
  });

  it("turnId-keyed idempotence: an existing agent turn with this turnId is not re-appended", async () => {
    io.files.set(
      CORE_PATH,
      BASE_CORE +
        "\n## Turn a1b2c3 — 2026-10-14T18:37:00.000Z (agent)\n\n推荐看看小屏旗舰。\n",
    );

    const outcome = await commitWriterTurn(payload());

    expect(outcome.kind).toBe("committed");
    const core = io.files.get(CORE_PATH)!;
    expect(core.match(/推荐看看小屏旗舰。/g)?.length).toBe(1);
  });

  it("the merge turn rides the same commit, stamped [merge] (+ [burst {id}] with a burst)", async () => {
    const outcome = await commitWriterTurn(
      payload({ mergeLine: "更正：预算以 6000 为准。", burstId: "burst-ulid-1" }),
    );

    expect(outcome.segments).toEqual(["reply", "cognition", "merge", "snapshot"]);
    expect(io.flushes).toHaveLength(1); // 收合轮不单独提交
    const core = io.files.get(CORE_PATH)!;
    expect(core).toContain("[merge]");
    expect(core).toContain("[burst burst-ulid-1]");
  });

  it("a flush failure after the bounded self-heal → { kind: \"failed\" }, honestly — and NO bell (the turn stays uncommitted; its bell belongs to the next successful one)", async () => {
    const { flushBatch } = await import("@/lib/episodic");
    // non-ref error: no self-heal possible, one attempt, honest failure
    vi.mocked(flushBatch).mockRejectedValueOnce(new Error("disk full"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const outcome = await commitWriterTurn(payload());
      expect(outcome.kind).toBe("failed");
      expect(outcome.error).toContain("disk full");
      expect(wake.deliverReflectionWake).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("a ref conflict is absorbed by the bounded self-heal (≤2) and the commit lands", async () => {
    const { flushBatch } = await import("@/lib/episodic");
    vi.mocked(flushBatch)
      .mockRejectedValueOnce(new Error("Update rejected: not a fast-forward"))
      .mockResolvedValueOnce(undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const outcome = await commitWriterTurn(payload());
      expect(outcome.kind).toBe("committed");
      expect(vi.mocked(flushBatch).mock.calls.length).toBeGreaterThanOrEqual(2);
    } finally {
      warn.mockRestore();
    }
  });

  it("rings the reflection bell after EVERY successful commit — a sealed slice is NOT the trigger (v0.38 §3.3)", async () => {
    await commitWriterTurn(payload());
    expect(wake.deliverReflectionWake).toHaveBeenCalledTimes(1);
  });

  it("a sealed slice still rings exactly ONCE (not twice)", async () => {
    await commitWriterTurn(payload({ closedSliceId: SLICE_ID }));
    expect(wake.deliverReflectionWake).toHaveBeenCalledTimes(1);
  });

  it("the bell's log label is the turn's own sliceId", async () => {
    wake.deliverReflectionWake.mockResolvedValueOnce({
      ok: false,
      reason: "no live run hook",
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await commitWriterTurn(payload());
      expect(wake.deliverReflectionWake).toHaveBeenCalledTimes(1);
      const message = warn.mock.calls
        .map((c) => String(c[0]))
        .find((m) => m.includes("wake not delivered"));
      expect(message).toBeDefined();
      expect(message).toContain(SLICE_ID);
    } finally {
      warn.mockRestore();
    }
  });

  it("an empty reply with no merge line → nothing to commit", async () => {
    const outcome = await commitWriterTurn(payload({ replyText: "" }));
    expect(outcome.kind).toBe("nothing");
    expect(io.flushes).toHaveLength(0);
  });
});

describe("decideBurstMergeLine — lastness + completed-only reads (v0.38 §3.2 ②)", () => {
  function turnRun(runId: string, status: string, turn: string, burst?: string) {
    io.registry.push({
      runId,
      status,
      attributes: {
        slice: SLICE_ID,
        turn,
        phase: "tail",
        ...(burst ? { burst } : {}),
      },
    });
  }

  it("not the last (a sibling still answering) → no merge line", async () => {
    turnRun("sib-1", "running", "x1y2z3", "burst-1");
    const line = await decideBurstMergeLine(
      mergeParams({ burstId: "burst-1" }),
    );
    expect(line).toBeUndefined();
  });

  it("the last, with a COMPLETED sibling whose reply contradicts → the merge line is generated and announced", async () => {
    turnRun("sib-1", "completed", "x1y2z3", "burst-1");
    io.returnValues.set("sib-1", "预算 6000，选 iPhone。");
    io.mergeModelText = "更正：预算以最后一条的 5000 为准。";

    const line = await decideBurstMergeLine(mergeParams({ burstId: "burst-1" }));

    expect(line).toBe("更正：预算以最后一条的 5000 为准。");
  });

  it("a FAILED sibling is skipped (completed-only reads) — nothing to reconcile → no line", async () => {
    turnRun("sib-1", "failed", "x1y2z3", "burst-1");
    io.returnValues.set("sib-1", "garbage that must not be read");

    const line = await decideBurstMergeLine(mergeParams({ burstId: "burst-1" }));

    expect(line).toBeUndefined();
    expect(io.mergeModelText).toBe(""); // the model was never called
  });

  it("the model says EMPTY (no correction needed) → 收合可空: no merge line", async () => {
    turnRun("sib-1", "completed", "x1y2z3", "burst-1");
    io.returnValues.set("sib-1", "互不矛盾的回答。");
    io.mergeModelText = "EMPTY";

    const line = await decideBurstMergeLine(mergeParams({ burstId: "burst-1" }));

    expect(line).toBeUndefined();
  });

  it("no burstId (legacy) → the overlap heuristic: a solo turn gets no merge line", async () => {
    // registry holds only THIS run (registered as own by metadata)
    io.registry.push({
      runId: "writer-own",
      status: "running",
      attributes: { slice: SLICE_ID, turn: "a1b2c3", phase: "tail" },
    });
    const line = await decideBurstMergeLine(mergeParams());
    expect(line).toBeUndefined();
  });
});
