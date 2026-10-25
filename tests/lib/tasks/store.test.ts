import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WriteBatch } from "@/lib/episodic/io-helpers";
import type {
  CreateTaskInput,
  TaskEntry,
  TaskLedger,
  TaskLedgerErrorCode,
  TaskOperationReceipt,
  TaskResult,
  UpdateTaskInput,
} from "@/lib/tasks/contracts";

type BatchLike = Pick<WriteBatch, "entries" | "baseHeadSha">;

const io = vi.hoisted(() => ({
  files: new Map<string, string>(),
  source: "local" as "local" | "github" | "demo",
  head: "head-0",
  reads: 0,
  flushes: 0,
  readError: null as unknown,
  baseHeads: [] as Array<string | undefined>,
  onFlush: null as null | ((batch: BatchLike) => void | Promise<void>),
}));

vi.mock("@/lib/episodic/io-helpers", () => ({
  createBatch: () => ({
    entries: new Map<string, string | null>(),
    encodings: new Map<string, "base64">(),
  }),
  fsReadFile: vi.fn(
    async (path: string, batch?: WriteBatch) => {
      const pending = batch?.entries.get(path);
      if (pending !== undefined) {
        if (pending === null) throw new Error(`File not found: "${path}"`);
        return pending;
      }
      io.reads += 1;
      if (io.readError) throw io.readError;
      const content = io.files.get(path);
      if (content === undefined) throw new Error(`File not found: "${path}"`);
      return content;
    },
  ),
  fsWriteFile: vi.fn(
    async (path: string, content: string, batch?: WriteBatch) => {
      if (batch) batch.entries.set(path, content);
      else io.files.set(path, content);
      return { path, created: true };
    },
  ),
  flushBatch: vi.fn(async (batch: WriteBatch, _message: string) => {
    io.flushes += 1;
    io.baseHeads.push(batch.baseHeadSha);
    if (io.onFlush) await io.onFlush(batch);
    for (const [path, content] of batch.entries) {
      if (content === null) io.files.delete(path);
      else io.files.set(path, content);
    }
    batch.entries.clear();
    io.head = `head-commit-${io.flushes}`;
    return `commit-${io.flushes}`;
  }),
}));

vi.mock("@/lib/data-source/resolve", () => ({
  resolveDataSource: () => io.source,
}));
vi.mock("@/lib/capabilities", () => ({
  getRepoConfig: () => ({ owner: "test-owner", repo: "test-repo" }),
}));
vi.mock("@/lib/github/read-view", () => ({
  getGitHubReadHead: vi.fn(async () => ({ headSha: io.head })),
}));
vi.mock("@/lib/tools/batch-write", () => ({
  isRefConflictError: (error: unknown) => {
    if (!error || typeof error !== "object") return false;
    const candidate = error as { status?: unknown; message?: unknown };
    return (
      candidate.status === 422 ||
      candidate.status === 409 ||
      (typeof candidate.message === "string" &&
        /not a fast.?forward/i.test(candidate.message))
    );
  },
}));

import {
  TASK_LEDGER_PATH,
  TaskLedgerError,
  type TaskOperation,
} from "@/lib/tasks/contracts";
import {
  applyTaskOperation,
  emptyTaskLedger,
  parseTaskLedger,
  queryTasks,
  serializeTaskLedger,
  validateTaskLedger,
} from "@/lib/tasks/ledger";
import {
  acknowledgeTaskFollowups,
  confirmTaskResultDelivery,
  createTask,
  mutateTaskLedger,
  readTaskLedger,
  reconcileLegacyTasks,
  recordTaskResult,
  updateTaskFromUserFeedback,
  withTaskLedgerBatch,
} from "@/lib/tasks/store";
import {
  listPendingTaskResults,
  selectTaskCandidates,
} from "@/lib/tasks/selector";
import {
  createBatch,
  flushBatch,
  fsReadFile,
} from "@/lib/episodic/io-helpers";

const NOW = "2026-10-26T12:00:00.000Z";
const TODAY = "2026-10-26";
const REF_A = "tasks/alpha";
const REF_B = "tasks/beta";

function makeTask(ref: string, overrides: Partial<TaskEntry> = {}): TaskEntry {
  return {
    ref,
    summary: `Summary ${ref}`,
    status: "open",
    revision: 1,
    evidence: [
      {
        sliceId: "slice-create",
        turnId: "turn-create",
        statement: `I committed to ${ref}`,
      },
    ],
    updatedAt: NOW,
    ...overrides,
  };
}

function seed(
  tasks: TaskEntry[],
  results: TaskResult[] = [],
  operations: TaskOperationReceipt[] = [],
): void {
  io.files.set(
    TASK_LEDGER_PATH,
    serializeTaskLedger(
      validateTaskLedger({
        ...emptyTaskLedger(),
        tasks,
        results,
        operations,
      }),
    ),
  );
}

function createInput(ref: string, operationId: string): CreateTaskInput {
  return {
    operationId,
    now: NOW,
    task: { ref, summary: `Summary ${ref}` },
    userCommitment: {
      sliceId: `slice-${operationId}`,
      turnId: `turn-${operationId}`,
      statement: `I will handle ${ref}`,
    },
  };
}

function updateInput(
  ref: string,
  expectedRevision: number,
  operationId: string,
  changes: UpdateTaskInput["changes"],
): UpdateTaskInput {
  return {
    operationId,
    now: NOW,
    ref,
    expectedRevision,
    changes,
    evidence: {
      sliceId: `slice-${operationId}`,
      turnId: `turn-${operationId}`,
      statement: `Explicit user feedback ${operationId}`,
    },
  };
}

async function currentLedger(): Promise<TaskLedger> {
  const raw = io.files.get(TASK_LEDGER_PATH);
  expect(raw).toBeDefined();
  return parseTaskLedger(raw!);
}

async function expectCode(
  promise: Promise<unknown>,
  code: TaskLedgerErrorCode,
): Promise<void> {
  await expect(promise).rejects.toMatchObject({
    name: "TaskLedgerError",
    code,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  io.files.clear();
  io.source = "local";
  io.head = "head-0";
  io.reads = 0;
  io.flushes = 0;
  io.readError = null;
  io.baseHeads = [];
  io.onFlush = null;
});

describe("ledger read states and mutation refusal", () => {
  it("distinguishes missing from ready", async () => {
    expect(await readTaskLedger()).toEqual({
      status: "missing",
      basisHeadSha: null,
    });
    seed([makeTask(REF_A)]);
    const ready = await readTaskLedger();
    expect(ready.status).toBe("ready");
    if (ready.status === "ready") expect(ready.ledger.tasks).toHaveLength(1);
  });

  it("refuses corrupt state without resetting it", async () => {
    io.files.set(TASK_LEDGER_PATH, "{not-json");
    expect((await readTaskLedger()).status).toBe("corrupt");
    await expectCode(createTask(createInput(REF_A, "create-corrupt")), "ledger_corrupt");
    expect(io.files.get(TASK_LEDGER_PATH)).toBe("{not-json");
    expect(io.flushes).toBe(0);
  });

  it("refuses unavailable state without inventing an empty ledger", async () => {
    io.readError = new Error("backend unavailable");
    expect((await readTaskLedger()).status).toBe("unavailable");
    await expectCode(
      createTask(createInput(REF_A, "create-unavailable")),
      "ledger_unavailable",
    );
    expect(io.files.size).toBe(0);
    expect(io.flushes).toBe(0);
  });

  it("pins creation on a missing GitHub ledger to the fresh HEAD basis", async () => {
    io.source = "github";
    await createTask(createInput(REF_A, "create-github-missing"));
    expect(io.baseHeads).toEqual(["head-0"]);
    expect((await currentLedger()).tasks[0].ref).toBe(REF_A);
  });

  it.each([
    "tasks/%2e%2e%2fpeople%2fuser",
    "tasks/%2E%2E%5Cpeople%5Cuser",
    "tasks/%2e%2e",
    "tasks/%2fpeople",
    "tasks/%5cpeople",
    "tasks/CON",
    "tasks/aux.txt",
  ])("rejects %s before any storage IO", async (ref) => {
    await expectCode(
      createTask({
        ...createInput(REF_A, "invalid-ref"),
        task: { ref, summary: "Must not reach storage" },
      }),
      "invalid_operation",
    );
    expect(io.reads).toBe(0);
    expect(io.flushes).toBe(0);
    expect(io.files.size).toBe(0);
  });
});

describe("durable mutations, idempotency, and conflicts", () => {
  it("dedups a retry and a late replay cannot reopen a completed task", async () => {
    const create = createInput(REF_A, "create-once");
    await createTask(create);
    const retry = await createTask(create);
    expect(retry.outcome).toBe("deduped");
    expect(io.flushes).toBe(1);
    await updateTaskFromUserFeedback(
      updateInput(REF_A, 1, "complete", { status: "completed" }),
    );
    const lateReplay = await createTask(create);
    expect(lateReplay.outcome).toBe("deduped");
    const ledger = await currentLedger();
    expect(ledger.tasks[0]).toMatchObject({ status: "completed", revision: 2 });
    expect(ledger.operations).toHaveLength(2);
    expect(io.flushes).toBe(2);
  });

  it("rejects stale revisions and terminal reopen attempts", async () => {
    seed([makeTask(REF_A, { status: "completed", revision: 2 })]);
    const before = io.files.get(TASK_LEDGER_PATH);
    await expectCode(
      updateTaskFromUserFeedback(
        updateInput(REF_A, 1, "late-open", { status: "open" }),
      ),
      "stale_revision",
    );
    await expectCode(
      updateTaskFromUserFeedback(
        updateInput(REF_A, 2, "reopen", { status: "open" }),
      ),
      "terminal_task",
    );
    expect(io.files.get(TASK_LEDGER_PATH)).toBe(before);
    expect(io.flushes).toBe(0);
  });

  it.each(["completed", "cancelled"] as const)(
    "allows a genuine %s correction only with fresh revision, reopen flag, and new evidence",
    async (terminalStatus) => {
      const original = makeTask(REF_A, { status: terminalStatus, revision: 2 });
      seed([original]);
      const correction = updateInput(REF_A, 2, `reopen-${terminalStatus}`, {
        status: "open",
        reopen: true,
      });
      await expectCode(
        updateTaskFromUserFeedback(
          updateInput(REF_A, 1, `stale-reopen-${terminalStatus}`, {
            status: "open",
            reopen: true,
          }),
        ),
        "stale_revision",
      );
      await expectCode(
        updateTaskFromUserFeedback({
          ...correction,
          evidence: original.evidence[0],
        }),
        "terminal_task",
      );

      await updateTaskFromUserFeedback(correction);
      let ledger = await currentLedger();
      expect(ledger.tasks[0]).toMatchObject({
        status: "open",
        revision: 3,
      });
      expect(ledger.tasks[0].evidence).toHaveLength(2);
      expect(ledger.tasks[0]).not.toHaveProperty("reopen");
      expect((await updateTaskFromUserFeedback(correction)).outcome).toBe("deduped");
      expect((await currentLedger()).tasks[0].revision).toBe(3);

      await updateTaskFromUserFeedback(
        updateInput(REF_A, 3, `reterminal-${terminalStatus}`, {
          status: terminalStatus,
        }),
      );
      expect((await updateTaskFromUserFeedback(correction)).outcome).toBe("deduped");
      ledger = await currentLedger();
      expect(ledger.tasks[0]).toMatchObject({
        status: terminalStatus,
        revision: 4,
      });
    },
  );

  it("applies explicit completion, cancellation, and deferral immediately", async () => {
    seed([makeTask(REF_A), makeTask(REF_B), makeTask("tasks/gamma")]);
    await updateTaskFromUserFeedback(
      updateInput(REF_A, 1, "feedback-complete", { status: "completed" }),
    );
    await updateTaskFromUserFeedback(
      updateInput(REF_B, 1, "feedback-cancel", { status: "cancelled" }),
    );
    await updateTaskFromUserFeedback(
      updateInput("tasks/gamma", 1, "feedback-defer", {
        dueOn: "2026-11-15",
        nextCheckOn: "2026-11-10",
      }),
    );
    const ledger = await currentLedger();
    expect(ledger.tasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ref: REF_A, status: "completed", revision: 2 }),
        expect.objectContaining({ ref: REF_B, status: "cancelled", revision: 2 }),
        expect.objectContaining({
          ref: "tasks/gamma",
          status: "open",
          revision: 2,
          dueOn: "2026-11-15",
          nextCheckOn: "2026-11-10",
        }),
      ]),
    );
    expect(
      selectTaskCandidates(ledger, { todayLocal: TODAY, limit: 10 }).candidates,
    ).toEqual([]);
  });

  it("rejects one of two concurrent same-task updates instead of losing either silently", async () => {
    seed([makeTask(REF_A)]);
    const outcomes = await Promise.allSettled([
      updateTaskFromUserFeedback(
        updateInput(REF_A, 1, "concurrent-a", { summary: "Writer A" }),
      ),
      updateTaskFromUserFeedback(
        updateInput(REF_A, 1, "concurrent-b", { summary: "Writer B" }),
      ),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === "rejected");
    expect(rejected).toBeDefined();
    if (rejected?.status === "rejected") {
      expect(rejected.reason).toBeInstanceOf(TaskLedgerError);
      expect(rejected.reason.code).toBe("stale_revision");
    }
    const ledger = await currentLedger();
    expect(ledger.tasks[0].revision).toBe(2);
    expect(ledger.operations).toHaveLength(1);
  });

  it("replays onto a fresh HEAD and preserves a different-task write", async () => {
    io.source = "github";
    seed([makeTask(REF_A), makeTask(REF_B)]);
    let conflictInjected = false;
    io.onFlush = () => {
      if (conflictInjected) return;
      conflictInjected = true;
      const external = applyTaskOperation(parseTaskLedger(io.files.get(TASK_LEDGER_PATH)!), {
        ...updateInput(REF_B, 1, "external-beta", { summary: "Beta updated externally" }),
        type: "update",
      });
      io.files.set(TASK_LEDGER_PATH, serializeTaskLedger(external.ledger));
      io.head = "head-external";
      throw Object.assign(new Error("Update is not a fast forward"), { status: 422 });
    };

    const result = await updateTaskFromUserFeedback(
      updateInput(REF_A, 1, "alpha-replayed", { summary: "Alpha updated locally" }),
    );
    expect(result.attempts).toBe(2);
    const ledger = await currentLedger();
    expect(ledger.tasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ref: REF_A,
          revision: 2,
          summary: "Alpha updated locally",
        }),
        expect.objectContaining({
          ref: REF_B,
          revision: 2,
          summary: "Beta updated externally",
        }),
      ]),
    );
    expect(ledger.operations.map((receipt) => receipt.operationId).sort()).toEqual([
      "alpha-replayed",
      "external-beta",
    ]);
    expect(io.baseHeads).toEqual(["head-0", "head-external"]);
  });

  it("bounds repeated HEAD conflicts instead of retrying forever", async () => {
    io.source = "github";
    seed([makeTask(REF_A)]);
    io.onFlush = () => {
      throw Object.assign(new Error("Update is not a fast forward"), { status: 422 });
    };
    await expectCode(
      mutateTaskLedger(
        {
          ...updateInput(REF_A, 1, "bounded", { summary: "Changed" }),
          type: "update",
        },
        { maxHeadRetries: 1 },
      ),
      "head_conflict",
    );
    expect(io.flushes).toBe(2);
  });
});

describe("HQ batching and bounded turn reads", () => {
  it("coalesces same-round operations with read-your-writes and one caller flush", async () => {
    const batch = createBatch();
    await withTaskLedgerBatch(batch, async (mutate) => {
      await mutate({ ...createInput(REF_A, "batch-create-a"), type: "create" });
      await mutate({ ...createInput(REF_B, "batch-create-b"), type: "create" });
      const deduped = await mutate({
        ...createInput(REF_A, "batch-create-a"),
        type: "create",
      });
      expect(deduped.outcome).toBe("deduped");
      await mutate({
        ...updateInput(REF_A, 1, "batch-update-a", { summary: "Updated in round" }),
        type: "update",
      });
      expect(io.reads).toBe(1);
      expect(io.flushes).toBe(0);
      await flushBatch(batch, "HQ round");
    });
    const ledger = await currentLedger();
    expect(ledger.tasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ref: REF_A, revision: 2, summary: "Updated in round" }),
        expect.objectContaining({ ref: REF_B, revision: 1 }),
      ]),
    );
    expect(ledger.operations).toHaveLength(3);
    expect(io.flushes).toBe(1);
  });

  it.each(["local", "github"] as const)(
    "one warm %s ledger read serves selection and query without per-task document IO",
    async (source) => {
      io.source = source;
      seed(
        Array.from({ length: 8 }, (_, index) =>
          makeTask(`tasks/task-${index}`, {
            dueOn: index === 0 ? "2020-01-01" : undefined,
          }),
        ),
      );
      const read = await readTaskLedger();
      expect(read.status).toBe("ready");
      if (read.status !== "ready") return;
      const selection = selectTaskCandidates(read.ledger, {
        todayLocal: TODAY,
        limit: 3,
      });
      const page = queryTasks(read.ledger, { limit: 5 });
      const pending = listPendingTaskResults(read.ledger);
      expect(selection.totalCandidates).toBe(8);
      expect(page.total).toBe(8);
      expect(page.hasMore).toBe(true);
      expect(pending.total).toBe(0);
      expect(io.reads).toBe(1);
      expect(vi.mocked(fsReadFile).mock.calls.map((call) => call[0])).toEqual([
        TASK_LEDGER_PATH,
      ]);
    },
  );
});

describe("confirmed follow-ups", () => {
  it("does not consume cancelled or failed turns and acknowledges only a persisted reply", async () => {
    seed([makeTask(REF_A)]);
    const before = io.files.get(TASK_LEDGER_PATH);
    for (const status of ["failed", "cancelled"] as const) {
      const skipped = await acknowledgeTaskFollowups({
        operationId: `ack-${status}`,
        now: NOW,
        todayLocal: TODAY,
        outcome: { status },
        followups: [{ ref: REF_A, expectedRevision: 1 }],
      });
      expect(skipped).toEqual({
        outcome: "skipped",
        reason: "reply_not_persisted",
      });
    }
    expect(io.files.get(TASK_LEDGER_PATH)).toBe(before);
    expect(io.reads).toBe(0);
    expect(io.flushes).toBe(0);

    await acknowledgeTaskFollowups({
      operationId: "ack-persisted",
      now: NOW,
      todayLocal: TODAY,
      outcome: { status: "persisted", sliceId: "slice-reply", turnId: "turn-reply" },
      followups: [{ ref: REF_A, expectedRevision: 1 }],
    });
    const ledger = await currentLedger();
    expect(ledger.tasks[0]).toMatchObject({
      revision: 1,
      lastFollowup: {
        revision: 1,
        on: TODAY,
        reply: { sliceId: "slice-reply", turnId: "turn-reply" },
      },
    });
    expect(
      selectTaskCandidates(ledger, { todayLocal: TODAY, limit: 5 }).candidates,
    ).toEqual([]);
  });

  it("keeps same-revision follow-up days monotonic across late separate operations", async () => {
    seed([makeTask(REF_A)]);
    await acknowledgeTaskFollowups({
      operationId: "ack-oct-26",
      now: NOW,
      todayLocal: TODAY,
      outcome: { status: "persisted", sliceId: "slice-26", turnId: "reply-26" },
      followups: [{ ref: REF_A, expectedRevision: 1 }],
    });
    const late = await acknowledgeTaskFollowups({
      operationId: "ack-late-oct-25",
      now: "2026-10-25T12:00:00.000Z",
      todayLocal: "2026-10-25",
      outcome: { status: "persisted", sliceId: "slice-25", turnId: "reply-25" },
      followups: [{ ref: REF_A, expectedRevision: 1 }],
    });
    expect(late.outcome).toBe("applied");
    if (late.outcome !== "skipped") expect(late.taskRefs).toEqual([]);
    const ledger = await currentLedger();
    expect(ledger.tasks[0].lastFollowup).toEqual({
      revision: 1,
      on: TODAY,
      reply: { sliceId: "slice-26", turnId: "reply-26" },
    });
    expect(
      selectTaskCandidates(ledger, { todayLocal: TODAY, limit: 5 }).candidates,
    ).toEqual([]);
  });

  it("moves bounded undated review to the next task only after acknowledgment", async () => {
    seed([makeTask(REF_A), makeTask(REF_B)]);
    const firstRead = await readTaskLedger();
    if (firstRead.status !== "ready") throw new Error("expected ready ledger");
    const first = selectTaskCandidates(firstRead.ledger, {
      todayLocal: TODAY,
      limit: 1,
    }).candidates[0];
    expect(first.task.ref).toBe(REF_A);
    await acknowledgeTaskFollowups({
      operationId: "ack-rotate",
      now: NOW,
      todayLocal: TODAY,
      outcome: { status: "persisted", sliceId: "slice-reply", turnId: "turn-reply" },
      followups: [{ ref: REF_A, expectedRevision: 1 }],
    });
    const second = selectTaskCandidates(await currentLedger(), {
      todayLocal: TODAY,
      limit: 1,
    });
    expect(second.candidates[0].task.ref).toBe(REF_B);
  });
});

describe("separate background result events", () => {
  it("records an evidenced pending result and delivers it only after a persisted reply", async () => {
    seed([makeTask(REF_A)]);
    const rawRecordPath = "memory/records/2026/10/26/1000/core.md";
    io.files.set(rawRecordPath, "raw record bytes stay unchanged");
    await recordTaskResult({
      operationId: "record-result-op",
      now: "2020-01-01T00:00:00.000Z",
      result: {
        id: "result-1",
        taskRef: REF_A,
        evidence: {
          producerRunId: "background-run-1",
          statement: "The requested background research completed.",
          sliceId: "slice-background",
          turnId: "turn-background",
        },
      },
    });
    let ledger = await currentLedger();
    expect(ledger.tasks[0].status).toBe("open");
    expect(ledger.results[0]).toMatchObject({
      id: "result-1",
      revision: 1,
      createdAt: "2020-01-01T00:00:00.000Z",
      delivery: { state: "pending" },
    });
    expect(listPendingTaskResults(ledger).total).toBe(1);

    io.reads = 0;
    const skipped = await confirmTaskResultDelivery({
      operationId: "deliver-failed",
      now: NOW,
      resultId: "result-1",
      expectedRevision: 1,
      outcome: { status: "failed" },
    });
    expect(skipped.outcome).toBe("skipped");
    expect(io.reads).toBe(0);
    expect(listPendingTaskResults(await currentLedger()).total).toBe(1);

    const delivered = await confirmTaskResultDelivery({
      operationId: "deliver-persisted",
      now: NOW,
      resultId: "result-1",
      expectedRevision: 1,
      outcome: { status: "persisted", sliceId: "slice-reply", turnId: "turn-reply" },
    });
    expect(delivered.outcome).toBe("applied");
    const replay = await confirmTaskResultDelivery({
      operationId: "deliver-persisted",
      now: NOW,
      resultId: "result-1",
      expectedRevision: 1,
      outcome: { status: "persisted", sliceId: "slice-reply", turnId: "turn-reply" },
    });
    expect(replay.outcome).toBe("deduped");
    ledger = await currentLedger();
    expect(ledger.results[0]).toMatchObject({
      revision: 2,
      delivery: {
        state: "delivered",
        reply: { sliceId: "slice-reply", turnId: "turn-reply" },
      },
    });
    expect(listPendingTaskResults(ledger).total).toBe(0);
    expect(ledger.tasks[0].status).toBe("open");
    expect(io.files.get(rawRecordPath)).toBe("raw record bytes stay unchanged");
    expect(vi.mocked(fsReadFile).mock.calls.every((call) => call[0] === TASK_LEDGER_PATH)).toBe(true);
  });

  it("does not infer task completion from a result or a today-dated statement", async () => {
    seed([makeTask(REF_A, { summary: `${TODAY}：完成了，但这只是散文` })]);
    const operation: TaskOperation = {
      type: "record_result",
      operationId: "result-not-status",
      now: NOW,
      result: {
        id: "result-not-status",
        taskRef: REF_A,
        evidence: {
          producerRunId: "run",
          statement: `${TODAY}：背景工作完成`,
        },
      },
    };
    await mutateTaskLedger(operation);
    const ledger = await currentLedger();
    expect(ledger.tasks[0].status).toBe("open");
    expect(ledger.results[0].delivery.state).toBe("pending");
  });
});

describe("legacy reconciliation", () => {
  it("registers only needs_review, preserves existing state, and allows explicit HQ review", async () => {
    seed([makeTask(REF_A)]);
    const existingBefore = (await currentLedger()).tasks[0];
    await reconcileLegacyTasks({
      operationId: "legacy-scan-1",
      now: NOW,
      entries: [
        { ref: REF_A, summary: "Must not overwrite" },
        { ref: "tasks/legacy-b" },
        { ref: "tasks/legacy-c", summary: "Manifest summary only" },
      ],
    });
    let ledger = await currentLedger();
    expect(ledger.tasks.find((task) => task.ref === REF_A)).toEqual(existingBefore);
    for (const ref of ["tasks/legacy-b", "tasks/legacy-c"]) {
      expect(ledger.tasks.find((task) => task.ref === ref)).toMatchObject({
        status: "needs_review",
        revision: 1,
        evidence: [],
      });
      const task = ledger.tasks.find((item) => item.ref === ref)!;
      expect(task.dueOn).toBeUndefined();
      expect(task.nextCheckOn).toBeUndefined();
    }
    expect(queryTasks(ledger, { status: "needs_review" }).total).toBe(2);

    await reconcileLegacyTasks({
      operationId: "legacy-scan-2",
      now: NOW,
      entries: [{ ref: "tasks/legacy-b", summary: "Still no overwrite" }],
    });
    ledger = await currentLedger();
    expect(ledger.tasks.find((task) => task.ref === "tasks/legacy-b")?.summary).toBe(
      "Unreviewed legacy task; lifecycle status is unknown.",
    );

    await updateTaskFromUserFeedback(
      updateInput("tasks/legacy-b", 1, "hq-explicit-review", {
        status: "open",
        summary: "Reviewed against the document and raw records",
      }),
    );
    ledger = await currentLedger();
    expect(ledger.tasks.find((task) => task.ref === "tasks/legacy-b")).toMatchObject({
      status: "open",
      revision: 2,
    });
    expect(vi.mocked(fsReadFile).mock.calls.every((call) => call[0] === TASK_LEDGER_PATH)).toBe(true);
  });
});
