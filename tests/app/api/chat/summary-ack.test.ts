import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SummaryRunPayload, SummaryRunOutcome, VerifiedTaskReply } from "@/lib/chat/turn-types";
import type { TaskAckIntent } from "@/lib/chat/task-followups";

vi.hoisted(() => {
  process.env.MEMORY_ROOT = `${process.env.MEMORY_ROOT}/summary-ack`;
  process.env.PREVIOUSLY_HOME = `${process.env.PREVIOUSLY_HOME}/summary-ack`;
});

const h = vi.hoisted(() => ({
  persist: vi.fn(),
  sourceStatus: vi.fn(),
  close: vi.fn(async () => {}),
  sleep: vi.fn(async () => {}),
}));

vi.mock("workflow", async (importOriginal) => {
  const actual = await importOriginal<typeof import("workflow")>();
  return { ...actual, sleep: h.sleep };
});

vi.mock("@/app/api/chat/steps", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/app/api/chat/steps")>();
  return {
    ...actual,
    persistTurnSummary: h.persist,
    readSourceRunStatusForAck: h.sourceStatus,
    closeChildStream: h.close,
  };
});

import { summaryRun } from "@/app/api/chat/summary-run";
import {
  createTask,
  readTaskLedger,
  recordTaskResult,
} from "@/lib/tasks/store";

const NOW = "2026-10-26T08:00:00.000Z";
const EVIDENCE = {
  sliceId: "2026-10-26-0900",
  turnId: "turn-user",
  statement: "请调查并告诉我结果",
};

function payload(options: {
  sourceRunId: string;
  taskRef: string;
  resultId: string;
  finishReason?: string;
}): SummaryRunPayload {
  const intents: TaskAckIntent[] = [
    {
      kind: "task",
      followup: { ref: options.taskRef, expectedRevision: 1 },
    },
    { kind: "result", resultId: options.resultId, expectedRevision: 1 },
  ];
  return {
    sliceId: "2026-10-26-0900",
    date: "2026-10-26",
    own: {
      turnId: "turn-reply",
      sourceRunId: options.sourceRunId,
      finishReason: options.finishReason ?? "stop",
      taskAckIntents: intents,
      sliceId: "2026-10-26-0900",
      at: NOW,
      userText: EVIDENCE.statement,
      replyText: "The research result is ready.",
      cognition: "",
    },
    slicing: { idleGapMinutes: 30, maxSliceMinutes: 30, maxTurnsPerSlice: 40 },
    clientTimezone: "UTC",
    modelConfig: { id: "test-model", sdk: "deepseek" } as SummaryRunPayload["modelConfig"],
    useGithub: false,
    useDemo: false,
    owner: "local",
    repo: "local",
    locale: "en",
  };
}

async function seed(taskRef: string, resultId: string): Promise<void> {
  const created = await createTask({
    operationId: `seed:${taskRef}`,
    now: NOW,
    task: { ref: taskRef, summary: "Research task" },
    userCommitment: EVIDENCE,
  });
  if (created.outcome !== "applied") throw new Error("task seed failed");
  await recordTaskResult({
    operationId: `seed:${resultId}`,
    now: NOW,
    result: {
      id: resultId,
      taskRef,
      evidence: { producerRunId: "question-run", statement: "Research is ready" },
    },
  });
}

function savedOutcome(payload: SummaryRunPayload, save = true): SummaryRunOutcome {
  return {
    kind: "deduped",
    ...(save ? {
      ownReply: {
        status: "persisted",
        sliceId: payload.sliceId,
        turnId: payload.own.turnId,
      },
    } : {}),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.persist.mockImplementation(async (input: SummaryRunPayload) => savedOutcome(input));
  h.sourceStatus.mockResolvedValue("completed");
});

describe("summary task acknowledgment", () => {
  it("acknowledges once after saved reply plus completed source, and an exact retry adds no operation", async () => {
    const input = payload({
      sourceRunId: "source-complete",
      taskRef: "tasks/ack-complete",
      resultId: "result-ack-complete",
    });
    await seed("tasks/ack-complete", "result-ack-complete");

    const first = await summaryRun(input);
    expect(first.acknowledgements).toEqual([
      expect.objectContaining({ kind: "task", status: "acknowledged" }),
      expect.objectContaining({ kind: "result", status: "acknowledged" }),
    ]);
    const read = await readTaskLedger({ fresh: true });
    if (read.status !== "ready") throw new Error("ledger not ready");
    const before = read.ledger.operations.length;
    expect(read.ledger.tasks.find((task) => task.ref === "tasks/ack-complete")?.lastFollowup?.reply).toEqual({
      sliceId: input.sliceId,
      turnId: input.own.turnId,
    });
    expect(read.ledger.results.find((result) => result.id === "result-ack-complete")?.delivery).toMatchObject({ state: "delivered" });

    const retry = await summaryRun(input);
    expect(retry.acknowledgements).toEqual([
      expect.objectContaining({ status: "acknowledged" }),
      expect.objectContaining({ status: "acknowledged" }),
    ]);
    const after = await readTaskLedger({ fresh: true });
    if (after.status !== "ready") throw new Error("ledger not ready");
    expect(after.ledger.operations).toHaveLength(before);
    expect(after.ledger.results.filter((result) => result.id === "result-ack-complete")).toHaveLength(1);
    expect(h.sleep).not.toHaveBeenCalled();
  });

  it("leaves a bounded pending ack while the source runs, then repairs it on the persisted duplicate path", async () => {
    const input = payload({
      sourceRunId: "source-repair",
      taskRef: "tasks/ack-repair",
      resultId: "result-ack-repair",
    });
    await seed("tasks/ack-repair", "result-ack-repair");
    h.sourceStatus.mockResolvedValue("running");

    const pending = await summaryRun(input);
    expect(pending.acknowledgements).toEqual([
      expect.objectContaining({ kind: "source", status: "pending" }),
    ]);
    expect(h.sourceStatus).toHaveBeenCalledTimes(5);
    expect(h.sleep).toHaveBeenCalledTimes(4);

    h.sourceStatus.mockResolvedValue("completed");
    h.sourceStatus.mockClear();
    const repaired = await summaryRun(input);
    expect(repaired.acknowledgements).toEqual([
      expect.objectContaining({ kind: "task", status: "acknowledged" }),
      expect.objectContaining({ kind: "result", status: "acknowledged" }),
    ]);
    const read = await readTaskLedger({ fresh: true });
    if (read.status !== "ready") throw new Error("ledger not ready");
    expect(read.ledger.results.find((result) => result.id === "result-ack-repair")?.delivery).toMatchObject({ state: "delivered" });
    expect(read.ledger.operations.filter((operation) =>
      operation.kind === "deliver_result" && operation.resultIds.includes("result-ack-repair")
    )).toHaveLength(1);
  });

  it.each([
    { finishReason: "error", sourceStatus: "completed" },
    { finishReason: "length", sourceStatus: "completed" },
    { finishReason: "stop", sourceStatus: "failed" },
    { finishReason: "stop", sourceStatus: "cancelled" },
  ])("does not consume after finish=$finishReason source=$sourceStatus", async ({ finishReason, sourceStatus }) => {
    const suffix = `${finishReason}-${sourceStatus}`;
    const input = payload({
      sourceRunId: `source-${suffix}`,
      taskRef: `tasks/ack-${suffix}`,
      resultId: `result-ack-${suffix}`,
      finishReason,
    });
    await seed(`tasks/ack-${suffix}`, `result-ack-${suffix}`);
    h.sourceStatus.mockResolvedValue(sourceStatus);

    const outcome = await summaryRun(input);
    expect(outcome.acknowledgements).toEqual([
      expect.objectContaining({ kind: "source", status: "skipped" }),
    ]);
    const read = await readTaskLedger({ fresh: true });
    if (read.status !== "ready") throw new Error("ledger not ready");
    expect(read.ledger.tasks.find((task) => task.ref === `tasks/ack-${suffix}`)?.lastFollowup).toBeUndefined();
    expect(read.ledger.results.find((result) => result.id === `result-ack-${suffix}`)?.delivery).toEqual({ state: "pending" });
    expect(read.ledger.operations.filter((operation) =>
      (operation.kind === "acknowledge_followups" || operation.kind === "deliver_result") &&
      (operation.taskRefs.includes(`tasks/ack-${suffix}`) || operation.resultIds.includes(`result-ack-${suffix}`))
    )).toHaveLength(0);
  });

  it("does not consume when the exact reply was not saved", async () => {
    const input = payload({
      sourceRunId: "source-unsaved",
      taskRef: "tasks/ack-unsaved",
      resultId: "result-ack-unsaved",
    });
    await seed("tasks/ack-unsaved", "result-ack-unsaved");
    h.persist.mockImplementation(async (input: SummaryRunPayload) => savedOutcome(input, false));

    const outcome = await summaryRun(input);
    expect(outcome.acknowledgements).toBeUndefined();
    expect(h.sourceStatus).not.toHaveBeenCalled();
    const read = await readTaskLedger({ fresh: true });
    if (read.status !== "ready") throw new Error("ledger not ready");
    expect(read.ledger.results.find((result) => result.id === "result-ack-unsaved")?.delivery).toEqual({ state: "pending" });
  });

  it("settles a saved sibling when the last survivor has no intent of its own", async () => {
    const input = payload({ sourceRunId: "last-survivor", taskRef: "tasks/burst-sibling", resultId: "result-burst-sibling" });
    await seed("tasks/burst-sibling", "result-burst-sibling");
    const sibling: VerifiedTaskReply = {
      reply: { status: "persisted", sliceId: input.sliceId, turnId: "earlier-sibling" },
      sourceRunId: "source-earlier-sibling", finishReason: "stop",
      taskAckIntents: input.own.taskAckIntents!,
    };
    input.own.taskAckIntents = [];
    h.persist.mockResolvedValue({ ...savedOutcome(input), verifiedTaskReplies: [sibling] });

    const outcome = await summaryRun(input);
    expect(outcome.acknowledgements).toEqual([
      expect.objectContaining({ kind: "task", status: "acknowledged" }),
      expect.objectContaining({ kind: "result", status: "acknowledged" }),
    ]);
    expect(h.sourceStatus).toHaveBeenCalledWith("source-earlier-sibling");
    expect(h.sourceStatus).not.toHaveBeenCalledWith("last-survivor");
    const read = await readTaskLedger({ fresh: true });
    if (read.status !== "ready") throw new Error("ledger not ready");
    expect(read.ledger.results.find((result) => result.id === "result-burst-sibling")?.delivery).toMatchObject({
      state: "delivered", reply: { sliceId: sibling.reply.sliceId, turnId: sibling.reply.turnId },
    });
  });

  it("handles each verified member independently, leaving cancelled, partial and error replies unconsumed", async () => {
    const input = payload({ sourceRunId: "mixed-last", taskRef: "tasks/mixed-clean", resultId: "result-mixed-clean" });
    input.own.taskAckIntents = [];
    const members: VerifiedTaskReply[] = [];
    for (const suffix of ["clean", "cancelled", "partial", "error"]) {
      await seed(`tasks/mixed-${suffix}`, `result-mixed-${suffix}`);
      members.push({
        reply: { status: "persisted", sliceId: input.sliceId, turnId: `reply-${suffix}` },
        sourceRunId: `source-${suffix}`, finishReason: suffix === "partial" ? "length" : "stop",
        ...(suffix === "error" ? { error: "The final write failed" } : {}),
        taskAckIntents: [{ kind: "result", resultId: `result-mixed-${suffix}`, expectedRevision: 1 }],
      });
    }
    h.persist.mockResolvedValue({ ...savedOutcome(input), verifiedTaskReplies: members });
    h.sourceStatus.mockImplementation(async (id: string) => id === "source-cancelled" ? "cancelled" : "completed");

    const outcome = await summaryRun(input);
    expect(outcome.acknowledgements?.filter((ack) => ack.status === "acknowledged")).toHaveLength(1);
    expect(outcome.acknowledgements?.filter((ack) => ack.status === "skipped")).toHaveLength(3);
    expect(h.sourceStatus).not.toHaveBeenCalledWith("source-partial");
    expect(h.sourceStatus).not.toHaveBeenCalledWith("source-error");
    const read = await readTaskLedger({ fresh: true });
    if (read.status !== "ready") throw new Error("ledger not ready");
    for (const suffix of ["clean", "cancelled", "partial", "error"]) {
      expect(read.ledger.results.find((result) => result.id === `result-mixed-${suffix}`)?.delivery.state)
        .toBe(suffix === "clean" ? "delivered" : "pending");
    }
  });
});
