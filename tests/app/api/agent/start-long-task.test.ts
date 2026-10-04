/**
 * startLongTask — the field's on-the-spot dispatch of the conversation's
 * sub-stream (v0.21 §2). The question run's durable workflow is mocked; the
 * mailbox write runs against a real in-memory local fs and the REAL consumer
 * parser (librarian.ts's extractDocMarkers) — every appended line re-verifies
 * the frozen [doc-marker] contract (§A.3.1). No memory/ directory is touched.
 *
 * Pins: marker-first ordering (the pass's agenda IS the markers), the
 * questionRun payload ({ sliceId, user-local date }), demo/empty refusals,
 * the honest failure surface when start throws, and retry idempotency.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const io = vi.hoisted(() => {
  // io-helpers resolves its backend at module load; without this, the vitest
  // env (NODE_ENV=test, no STORAGE) auto-detects "demo" and writes would
  // route to the demo backend.
  process.env.STORAGE = "local";
  return { files: new Map<string, string>(), order: [] as string[] };
});

vi.mock("@/lib/tools/local-fs", () => ({
  readFileLocal: async (p: string) => {
    if (!io.files.has(p)) throw new Error(`File not found: "${p}"`);
    return io.files.get(p)!;
  },
  writeFileLocal: async (p: string, content: string) => {
    if (p.endsWith("agent.md")) io.order.push("append");
    const created = !io.files.has(p);
    io.files.set(p, content);
    return { path: p, created };
  },
  listFilesLocal: vi.fn(async () => []),
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
  writeFileDemo: vi.fn(async () => {
    throw new Error("demo write should not be called");
  }),
}));

const h = vi.hoisted(() => ({
  start: vi.fn(async (_workflow: unknown, _args: unknown[], _opts?: unknown) => {
    io.order.push("start");
    return { runId: "run-question-1" };
  }),
  questionRun: vi.fn(),
}));

vi.mock("workflow/api", () => ({
  getHookByToken: vi.fn(),
  resumeHook: vi.fn(),
  start: h.start,
  getRun: vi.fn(),
}));

// The durable workflow itself is a stub — its body (executeQuestionRun in
// background-steps.ts) is covered by background-runs.test.ts.
vi.mock("@/app/api/evolution/question-run", () => ({
  questionRun: h.questionRun,
}));

import {
  startLongTaskExecute,
  type ToolContext,
} from "@/app/api/agent/tool-executors";
import { extractDocMarkers } from "@/lib/episodic/flash/librarian";

const SLICE = "2026-11-05-2030";
// v0.19 R2: writes land at the records root (flat HHMM/ layout, no timeline/).
const AGENT_PATH = "memory/records/2026/11/05/2030/agent.md";

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    repo: "local",
    owner: "local",
    useGithub: false,
    useDemo: false,
    sliceId: SLICE,
    recentTurns: [],
    ...overrides,
  };
}

function opts(ctx: ToolContext, toolCallId = "tc-1") {
  return { context: ctx, toolCallId };
}

beforeEach(() => {
  vi.clearAllMocks();
  io.files.clear();
  io.order.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("startLongTask — the dispatch (v0.21 §2)", () => {
  it("appends ONE question marker to the live slice's mailbox, THEN starts the question run", async () => {
    const r = await startLongTaskExecute(
      { task: "查一下屏幕供应商的报价历史", note: "线索：2026-10-04-0131 谈过" },
      opts(makeCtx()),
    );

    expect(r).toEqual({ ok: true, runId: "run-question-1" });

    // The marker round-trips the REAL consumer parser — the doc-research
    // pass's agenda is exactly these fields.
    const markers = extractDocMarkers(io.files.get(AGENT_PATH) ?? "");
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({
      kind: "question",
      id: `${SLICE}-tc-1`,
      title: "查一下屏幕供应商的报价历史",
      note: "线索：2026-10-04-0131 谈过",
    });

    // The run carries the current slice and the user-local date — and the
    // marker is on disk BEFORE the run starts (the pass scans the mailbox).
    expect(io.order).toEqual(["append", "start"]);
    expect(h.start).toHaveBeenCalledTimes(1);
    const [workflowFn, args, startOpts] = h.start.mock.calls[0];
    expect(workflowFn).toBe(h.questionRun);
    expect(args[0]).toEqual({
      sliceId: SLICE,
      date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    });
    expect(startOpts).toEqual({ region: "hkg1" });
  });

  it("stamps the run with the USER-LOCAL date (ctx.timezone), not the UTC date", async () => {
    // 2026-03-02 16:30 UTC = 2026-03-03 00:30 in Asia/Shanghai.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-02T16:30:00.000Z"));

    await startLongTaskExecute(
      { task: "整理上个月的差旅票据" },
      opts(makeCtx({ timezone: "Asia/Shanghai" })),
    );

    const args = h.start.mock.calls[0][1];
    expect(args[0]).toMatchObject({ sliceId: SLICE, date: "2026-03-03" });
  });

  it("empty task is refused before any write or dispatch", async () => {
    const r = await startLongTaskExecute({ task: "   " }, opts(makeCtx()));
    expect(r.ok).toBe(false);
    expect(io.files.size).toBe(0);
    expect(h.start).not.toHaveBeenCalled();
  });

  it("demo mode refuses — nothing recorded, nothing started", async () => {
    const r = await startLongTaskExecute(
      { task: "查一下 X" },
      opts(makeCtx({ useDemo: true })),
    );
    expect(r.ok).toBe(false);
    expect(io.files.size).toBe(0);
    expect(h.start).not.toHaveBeenCalled();
  });

  it("start failing → visible refusal NOW (the close-scan re-fire route is retired); the marker stays", async () => {
    h.start.mockRejectedValueOnce(new Error("world unreachable"));

    const r = await startLongTaskExecute({ task: "查一下 X" }, opts(makeCtx()));

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain("could not be started");
      expect(r.reason).toContain("world unreachable");
    }
    // the question is still recorded in the mailbox (HQ reads markers as
    // prose clues) — but nothing re-fires the run on its own.
    expect(extractDocMarkers(io.files.get(AGENT_PATH) ?? "")).toHaveLength(1);
  });

  it("a step retry (same toolCallId) does not double-append the marker", async () => {
    await startLongTaskExecute({ task: "查一下 X" }, opts(makeCtx(), "tc-retry"));
    await startLongTaskExecute({ task: "查一下 X" }, opts(makeCtx(), "tc-retry"));

    const markers = extractDocMarkers(io.files.get(AGENT_PATH) ?? "");
    expect(markers).toHaveLength(1);
    // the second start fired too — a duplicate RUN is absorbed downstream by
    // the pass's processed-marker record (at-least-once + writer-is-reader).
    expect(h.start).toHaveBeenCalledTimes(2);
  });
});
