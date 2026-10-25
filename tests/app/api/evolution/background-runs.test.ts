import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * The background stream's question run (v0.19 §A.2.3-b, v0.21 §5) — the
 * boundary run is retired (v0.30: the reflection unit wakes on the
 * mechanical bell and reads the record itself). The doc-research pass is
 * mocked at its module boundary — what is
 * under test here is the RUN's own contract: trigger discipline, empty-pass
 * legality, results-only storage (no run ledger — dedup is writer-is-reader
 * inside the passes), and the §A.3.3 completion notice.
 */

// In-memory memory root (same pattern as tests/lib/episodic/*).
const io = vi.hoisted(() => ({ files: new Map<string, string>() }));
vi.mock("@/lib/episodic/io-helpers", () => ({
  // The run coalesces its writes into ONE batch and ONE flush — createBatch/
  // flushBatch mirror the production shapes so the queued entries land on
  // the fake disk at flush time.
  createBatch: () => ({
    entries: new Map<string, string | null>(),
    encodings: new Map<string, "base64">(),
  }),
  flushBatch: vi.fn(
    async (batch: { entries: Map<string, string | null> }, _msg: string) => {
      for (const [p, c] of batch.entries) {
        if (c === null) io.files.delete(p);
        else io.files.set(p, c);
      }
      batch.entries.clear();
    },
  ),
  fsReadFile: vi.fn(async (path: string, batch?: { entries: Map<string, string | null> }) => {
    const content = batch?.entries.has(path) ? batch.entries.get(path) : io.files.get(path);
    if (content === undefined) throw new Error(`ENOENT: ${path}`);
    if (content === null) throw new Error(`ENOENT: ${path}`);
    return content;
  }),
  fsWriteFile: vi.fn(async (path: string, content: string, batch?: { entries: Map<string, string | null> }) => {
    if (batch) batch.entries.set(path, content);
    else io.files.set(path, content);
    return { path, created: true };
  }),
  fsListFiles: vi.fn(async (path: string) => {
    const prefix = `${path}/`;
    return [...io.files.keys()]
      .filter((p) => p.startsWith(prefix))
      .map((p) => {
        const rest = p.slice(prefix.length);
        return {
          name: rest.includes("/") ? rest.slice(0, rest.indexOf("/")) : rest,
          type: (rest.includes("/") ? "dir" : "file") as "dir" | "file",
          path: p,
        };
      });
  }),
}));

const episodic = vi.hoisted(() => ({
  loadSlice: vi.fn(),
  readSlicePart: vi.fn(async (sliceId: string, part: string) => {
    const v = io.files.get(`${sliceId}:${part}`);
    if (v === undefined) throw new Error(`missing ${sliceId}:${part}`);
    return v;
  }),
  slicePartPathCandidates: vi.fn(
    (sliceId: string, part: string) =>
      [`memory/records/${sliceId}/${part}.md`, `legacy/${sliceId}/${part}.md`] as [
        string,
        string,
      ],
  ),
}));
vi.mock("@/lib/episodic", () => episodic);

// The doc-research pass is mocked at its boundary; everything in the
// librarian module (marker parsing, applyCaseWriteIntent, buildSliceExcerpt)
// stays real.
const passes = vi.hoisted(() => ({
  runDocResearchPass: vi.fn(),
  calls: [] as string[],
}));
vi.mock("@/lib/episodic/flash/doc-research", () => ({
  runDocResearchPass: passes.runDocResearchPass,
}));

vi.mock("@/lib/models/registry", () => ({
  getModel: vi.fn(() => ({ id: "test-model" })),
  getDefaultModelId: vi.fn(() => "test-model"),
}));

import { executeQuestionRun } from "@/app/api/evolution/background-steps";
import { parseTaskLedger } from "@/lib/tasks/ledger";
import { TASK_LEDGER_PATH } from "@/lib/tasks/contracts";
import { createTask } from "@/lib/tasks/store";

const DATE = "2026-08-09";
const SLICE_ID = "2026-08-09-1300";
const Q1_PRODUCT = {
  markerId: "q-1", caseRef: "research/手机话题演变",
  productRef: "research/手机话题演变/index.md", outcome: "written" as const,
};

function seedSlice(overrides: Record<string, unknown> = {}) {
  episodic.loadSlice.mockResolvedValue({
    slice_id: SLICE_ID,
    focus: "手机话题",
    summary: "聊了换手机",
    status: "closed",
    tags: [],
    turns: [
      { timestamp: "t0", role: "user", content: "想换手机" },
      { timestamp: "t1", role: "agent", content: "预算多少" },
    ],
    ...overrides,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  io.files.clear();
  passes.calls.length = 0;
  passes.runDocResearchPass.mockImplementation(async () => {
    passes.calls.push("research");
    return { ran: true, written: [], skipped: [], productsByQuestion: [] };
  });
  seedSlice();
});

describe("executeQuestionRun — durable result events", () => {
  const QUESTION_MAILBOX =
    '[doc-marker] {"v":1,"id":"q-1","kind":"question","title":"手机话题这一年的演变","note":""}\n';

  beforeEach(() => {
    episodic.readSlicePart.mockResolvedValue(QUESTION_MAILBOX);
  });

  it("no unanswered question markers means no research and no result event", async () => {
    episodic.readSlicePart.mockResolvedValue("");
    const outcome = await executeQuestionRun({ sliceId: SLICE_ID, date: DATE });
    expect(outcome.ran).toBe(false);
    expect(passes.runDocResearchPass).not.toHaveBeenCalled();
    expect(io.files.has(TASK_LEDGER_PATH)).toBe(false);
  });

  it("commits a stable pending result with the research, reconciling the legacy task honestly", async () => {
    passes.runDocResearchPass.mockResolvedValue({
      ran: true,
      written: ["research/手机话题演变/index.md"],
      skipped: [],
      productsByQuestion: [Q1_PRODUCT],
    });

    const outcome = await executeQuestionRun({ sliceId: SLICE_ID, date: DATE });

    expect(outcome).toEqual({
      ran: true,
      written: ["research/手机话题演变/index.md"],
      resultIds: [`question-result:${SLICE_ID}:q-1`],
    });
    expect(io.files.has("memory/tasks/后台回复/index.md")).toBe(false);
    const ledger = parseTaskLedger(io.files.get(TASK_LEDGER_PATH)!);
    expect(ledger.tasks).toHaveLength(1);
    expect(ledger.tasks[0]).toMatchObject({
      ref: "tasks/手机话题这一年的演变",
      status: "needs_review",
    });
    expect(ledger.results).toHaveLength(1);
    expect(ledger.results[0]).toMatchObject({
      id: `question-result:${SLICE_ID}:q-1`,
      taskRef: "tasks/手机话题这一年的演变",
      delivery: { state: "pending" },
    });
    expect(ledger.results[0].evidence.statement).toContain("research/手机话题演变/index.md");
  });

  it("a pass that wrote nothing records no result", async () => {
    const outcome = await executeQuestionRun({ sliceId: SLICE_ID, date: DATE });
    expect(outcome.ran).toBe(true);
    expect(outcome.resultIds).toBeUndefined();
    expect(io.files.has(TASK_LEDGER_PATH)).toBe(false);
  });

  it("the same slice and marker stay one event across a later-day retry", async () => {
    passes.runDocResearchPass.mockResolvedValue({
      ran: true,
      written: ["research/手机话题演变/index.md"],
      skipped: [],
      productsByQuestion: [Q1_PRODUCT],
    });
    const first = await executeQuestionRun({ sliceId: SLICE_ID, date: DATE });
    const second = await executeQuestionRun({ sliceId: SLICE_ID, date: "2026-08-10" });

    expect(second.resultIds).toEqual(first.resultIds);
    const ledger = parseTaskLedger(io.files.get(TASK_LEDGER_PATH)!);
    expect(ledger.results).toHaveLength(1);
    expect(ledger.operations.filter((op) => op.kind === "record_result")).toHaveLength(1);
  });

  it("a failed commit rejects instead of reporting results, with no internal stale-ledger retry", async () => {
    passes.runDocResearchPass.mockResolvedValue({
      ran: true,
      written: ["research/手机话题演变/index.md"],
      skipped: [],
      productsByQuestion: [Q1_PRODUCT],
    });
    const { flushBatch } = await import("@/lib/episodic/io-helpers");
    vi.mocked(flushBatch).mockRejectedValueOnce(new Error("not a fast forward"));

    await expect(executeQuestionRun({ sliceId: SLICE_ID, date: DATE })).rejects.toThrow(
      "not a fast forward",
    );
    expect(vi.mocked(flushBatch)).toHaveBeenCalledTimes(1);
    expect(io.files.has(TASK_LEDGER_PATH)).toBe(false);

    const recovered = await executeQuestionRun({ sliceId: SLICE_ID, date: "2026-08-10" });
    expect(recovered.resultIds).toEqual([`question-result:${SLICE_ID}:q-1`]);
    expect(vi.mocked(flushBatch)).toHaveBeenCalledTimes(2);
    const ledger = parseTaskLedger(io.files.get(TASK_LEDGER_PATH)!);
    expect(ledger.results).toHaveLength(1);
  });

  it("records only a mapped successful question, not another question that failed", async () => {
    episodic.readSlicePart.mockResolvedValue(QUESTION_MAILBOX +
      '[doc-marker] {"v":1,"id":"q-2","kind":"question","title":"另一问尚未解决","note":""}\n');
    passes.runDocResearchPass.mockResolvedValue({
      ran: true, written: [Q1_PRODUCT.productRef],
      skipped: [{ id: "q-2", reason: "No accepted evidence" }],
      productsByQuestion: [Q1_PRODUCT],
    });
    const outcome = await executeQuestionRun({ sliceId: SLICE_ID, date: DATE });
    expect(outcome.resultIds).toEqual([`question-result:${SLICE_ID}:q-1`]);
    const ledger = parseTaskLedger(io.files.get(TASK_LEDGER_PATH)!);
    expect(ledger.results).toHaveLength(1);
    expect(ledger.results[0]!.evidence.statement).not.toContain("另一问");
    expect(ledger.tasks.map((task) => task.ref)).not.toContain("tasks/另一问尚未解决");
  });

  it("delivers an accepted existing product even when no new document was written", async () => {
    passes.runDocResearchPass.mockResolvedValue({
      ran: true, written: [], skipped: [],
      productsByQuestion: [{ ...Q1_PRODUCT, outcome: "existing" }],
    });
    const outcome = await executeQuestionRun({ sliceId: SLICE_ID, date: DATE });
    expect(outcome.written).toEqual([]);
    expect(outcome.resultIds).toEqual([`question-result:${SLICE_ID}:q-1`]);
    expect(parseTaskLedger(io.files.get(TASK_LEDGER_PATH)!).results[0]!.delivery.state).toBe("pending");
  });

  it("does not infer a question result from unmapped global writing", async () => {
    passes.runDocResearchPass.mockResolvedValue({
      ran: true, written: [Q1_PRODUCT.productRef], skipped: [], productsByQuestion: [],
    });
    const outcome = await executeQuestionRun({ sliceId: SLICE_ID, date: DATE });
    expect(outcome.resultIds).toBeUndefined();
    expect(io.files.has(TASK_LEDGER_PATH)).toBe(false);
  });

  it("holds the local task lock through the research commit so a field write survives", async () => {
    passes.runDocResearchPass.mockResolvedValue({
      ran: true, written: [Q1_PRODUCT.productRef], skipped: [], productsByQuestion: [Q1_PRODUCT],
    });
    const { flushBatch } = await import("@/lib/episodic/io-helpers");
    const flush = vi.mocked(flushBatch);
    const original = flush.getMockImplementation()!;
    let release!: () => void;
    let entered!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const flushing = new Promise<void>((resolve) => { entered = resolve; });
    flush.mockImplementationOnce(async (batch, message) => {
      entered();
      await barrier;
      return original(batch, message);
    });
    const background = executeQuestionRun({ sliceId: SLICE_ID, date: DATE });
    await flushing;
    let fieldFinished = false;
    const field = createTask({
      operationId: "concurrent-field", now: "2026-08-09T14:00:00.000Z",
      task: { ref: "tasks/同时登记的任务", summary: "不能被覆盖" },
      userCommitment: { sliceId: SLICE_ID, turnId: "field-user", statement: "请记住这个任务" },
    }).then(() => { fieldFinished = true; });
    try {
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(fieldFinished).toBe(false);
    } finally {
      release();
      await Promise.all([background, field]);
    }
    const ledger = parseTaskLedger(io.files.get(TASK_LEDGER_PATH)!);
    expect(ledger.tasks.map((task) => task.ref)).toContain("tasks/同时登记的任务");
    expect(ledger.results).toHaveLength(1);
  });
});
