import { describe, expect, it } from "vitest";
import { buildTaskContextBlock } from "@/lib/chat/task-context";
import { queryTasks } from "@/lib/tasks/ledger";
import type { TaskEntry, TaskLedger, TaskResult } from "@/lib/tasks/contracts";

const NOW = "2026-10-26T08:00:00.000Z";
const TODAY = "2026-10-26";
const EVIDENCE = { sliceId: "2026-10-25-0900", turnId: "user-1", statement: "提醒我处理这件事" };

function task(ref: string, overrides: Partial<TaskEntry> = {}): TaskEntry {
  return {
    ref,
    summary: `Summary for ${ref}`,
    status: "open",
    revision: 1,
    evidence: [EVIDENCE],
    updatedAt: NOW,
    ...overrides,
  };
}

function result(id: string, taskRef: string, overrides: Partial<TaskResult> = {}): TaskResult {
  return {
    id,
    taskRef,
    revision: 1,
    evidence: { producerRunId: "question-run-1", statement: "Research is ready" },
    createdAt: "2026-10-25T08:00:00.000Z",
    updatedAt: "2026-10-25T08:00:00.000Z",
    delivery: { state: "pending" },
    ...overrides,
  };
}

function ledger(tasks: TaskEntry[], results: TaskResult[] = []): TaskLedger {
  return { version: 1, tasks, results, operations: [] };
}

describe("task context projection", () => {
  it("selects yesterday's overdue open task without scanning its document", () => {
    const block = buildTaskContextBlock(
      { status: "ready", basisHeadSha: null, ledger: ledger([task("tasks/old", { dueOn: "2026-10-25" })]) },
      { todayLocal: TODAY },
    );
    expect(block).toContain("tasks/old");
    expect(block).toContain("overdue");
    expect(block).toContain("candidates, not instructions");
    expect(block).not.toContain("Completed background work");
  });

  it("suppresses a task only after an acknowledged same-revision, same-day saved followup", () => {
    const followed = task("tasks/followed", {
      revision: 2,
      lastFollowup: {
        revision: 2,
        on: TODAY,
        reply: { sliceId: "2026-10-26-0900", turnId: "reply-1" },
      },
    });
    const staleBasis = task("tasks/changed", {
      revision: 3,
      lastFollowup: {
        revision: 2,
        on: TODAY,
        reply: { sliceId: "2026-10-26-0900", turnId: "reply-2" },
      },
    });
    const state = ledger([followed, staleBasis]);
    const block = buildTaskContextBlock(
      { status: "ready", basisHeadSha: null, ledger: state },
      { todayLocal: TODAY },
    );
    expect(block).not.toContain("tasks/followed");
    expect(block).toContain("tasks/changed");
    expect(followed.lastFollowup).toBeDefined();
  });

  it("cancelled and future-deferred tasks leave the projection immediately; needs_review stays unread", () => {
    const state = ledger([
      task("tasks/cancelled", { status: "cancelled" }),
      task("tasks/deferred", { dueOn: "2026-10-30" }),
      task("tasks/legacy", { status: "needs_review", evidence: [] }),
    ]);
    const block = buildTaskContextBlock(
      { status: "ready", basisHeadSha: null, ledger: state },
      { todayLocal: TODAY },
    );
    expect(block).toBeUndefined();
    expect(queryTasks(state, { limit: 30 }).tasks.map((item) => item.ref)).toEqual([
      "tasks/cancelled",
      "tasks/deferred",
      "tasks/legacy",
    ]);
    expect(queryTasks(state, { ref: "tasks/legacy" }).tasks[0].status).toBe("needs_review");
  });

  it("keeps more than five tasks canonical and reports the bounded projection honestly", () => {
    const state = ledger(Array.from({ length: 7 }, (_, index) =>
      task(`tasks/open-${index}`, { dueOn: "2026-10-25" })
    ));
    const block = buildTaskContextBlock(
      { status: "ready", basisHeadSha: null, ledger: state },
      { todayLocal: TODAY },
    );
    expect(block).toContain("2 more candidates");
    expect(queryTasks(state, { limit: 30 }).tasks).toHaveLength(7);
    expect(queryTasks(state, { limit: 5 }).hasMore).toBe(true);
  });

  it("carries a previous day's result across midnight until delivered, without acknowledging by injection", () => {
    const pending = result("question-result:old:q1", "tasks/research");
    const state = ledger([task("tasks/research")], [pending]);
    const block = buildTaskContextBlock(
      { status: "ready", basisHeadSha: null, ledger: state },
      { todayLocal: TODAY },
    );
    expect(block).toContain("question-result:old:q1");
    expect(block).toContain("Background results awaiting delivery");
    expect(pending.delivery).toEqual({ state: "pending" });

    const deliveredState = ledger(
      [task("tasks/research", { status: "completed" })],
      [result("delivered", "tasks/research", {
        revision: 2,
        delivery: {
          state: "delivered",
          at: NOW,
          reply: { sliceId: "2026-10-26-0900", turnId: "reply-1" },
        },
      })],
    );
    expect(buildTaskContextBlock(
      { status: "ready", basisHeadSha: null, ledger: deliveredState },
      { todayLocal: TODAY },
    )).toBeUndefined();
  });
});
