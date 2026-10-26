import { describe, expect, it } from "vitest";
import type {
  TaskEntry,
  TaskLedger,
  TaskLedgerReadResult,
  TaskResult,
  TaskStatus,
} from "@/lib/tasks/contracts";
import {
  parseTaskPanelQuery,
  projectTaskLedgerRead,
  projectTaskPanel,
} from "@/lib/tasks/panel";

function task(index: number, status: TaskStatus = "open"): TaskEntry {
  return {
    ref: `tasks/task-${index}`,
    summary: `Task ${index}`,
    status,
    revision: 1,
    nextAction: "Take the next recorded action",
    ...(status === "waiting" ? { waitingCondition: "Waiting for a reply" } : {}),
    evidence: status === "needs_review" ? [] : [{
      sliceId: "2026-10-26-1200",
      turnId: `turn-${index}`,
      statement: `Explicit commitment ${index}`,
    }],
    updatedAt: "2026-10-26T12:00:00.000Z",
  };
}

function ledger(tasks: TaskEntry[], results: TaskResult[] = []): TaskLedger {
  return { version: 1, tasks, results, operations: [] };
}

describe("task panel canonical projection", () => {
  it("uses ledger status for every filter and count, including needs_review and cancelled", () => {
    const value = ledger([
      task(1), task(2, "waiting"), task(3, "paused"),
      task(4, "completed"), task(5, "cancelled"), task(6, "needs_review"),
    ]);
    const active = projectTaskPanel(value, { filter: "active", offset: 0, limit: 50 });
    expect(active.items.map((item) => item.ref)).toEqual(["tasks/task-1", "tasks/task-6"]);
    expect(active.counts).toEqual({ active: 2, waiting: 1, paused: 1, finished: 2, all: 6 });
    for (const [filter, refs] of [
      ["waiting", ["tasks/task-2"]],
      ["paused", ["tasks/task-3"]],
      ["finished", ["tasks/task-4", "tasks/task-5"]],
    ] as const) {
      expect(projectTaskPanel(value, { filter, offset: 0, limit: 50 }).items.map((item) => item.ref)).toEqual(refs);
    }
  });

  it("pages the whole canonical list without a five-task cap", () => {
    const value = ledger(Array.from({ length: 27 }, (_, index) => task(index + 1)));
    const first = projectTaskPanel(value, { filter: "all", offset: 0, limit: 20 });
    expect(first.items).toHaveLength(20);
    expect(first.total).toBe(27);
    expect(first.hasMore).toBe(true);
    expect(first.nextOffset).toBe(20);
    const second = projectTaskPanel(value, { filter: "all", offset: first.nextOffset!, limit: 20 });
    expect(second.items).toHaveLength(7);
    expect(second.total).toBe(27);
    expect(second.hasMore).toBe(false);
    expect(second.nextOffset).toBeNull();
  });

  it("shows a pending result without completing or moving its task", () => {
    const open = task(1);
    const result: TaskResult = {
      id: "result-1",
      taskRef: open.ref,
      revision: 1,
      evidence: { producerRunId: "run-1", statement: "The result is ready" },
      createdAt: "2026-10-26T13:00:00.000Z",
      updatedAt: "2026-10-26T13:00:00.000Z",
      delivery: { state: "pending" },
    };
    const page = projectTaskPanel(ledger([open], [result]), { filter: "active", offset: 0, limit: 20 });
    expect(page.items[0].status).toBe("open");
    expect(page.items[0].pendingResults).toEqual([{
      id: "result-1", statement: "The result is ready", createdAt: result.createdAt,
    }]);
    expect(projectTaskPanel(ledger([open], [result]), { filter: "finished", offset: 0, limit: 20 }).total).toBe(0);
  });

  it("keeps exact valid evidence refs and makes invalid refs inert", () => {
    const value = task(1);
    value.evidence = [
      { sliceId: "2026-10-26-1200", turnId: "a", statement: "Valid" },
      { sliceId: "not a slice", turnId: "b", statement: "Invalid" },
    ];
    const page = projectTaskPanel(ledger([value]), { filter: "all", offset: 0, limit: 20 });
    expect(page.items[0].evidence.map((item) => item.docRef)).toEqual([
      "records/2026-10-26-1200", null,
    ]);
  });

  it("distinguishes missing, corrupt, and unavailable reads from a real empty ledger", () => {
    const query = { filter: "active" as const, offset: 0, limit: 20 };
    const empty = projectTaskLedgerRead({ status: "ready", ledger: ledger([]), basisHeadSha: null }, query);
    expect(empty.status).toBe("ready");
    if (empty.status === "ready") expect(empty.total).toBe(0);
    const reads: TaskLedgerReadResult[] = [
      { status: "missing", basisHeadSha: null },
      { status: "corrupt", message: "bad json" },
      { status: "unavailable", message: "offline" },
    ];
    expect(reads.map((read) => projectTaskLedgerRead(read, query).status)).toEqual([
      "missing", "corrupt", "unavailable",
    ]);
  });

  it("validates untrusted page input", () => {
    expect(parseTaskPanelQuery({ filter: "bogus", offset: -4, limit: 500 })).toEqual({
      filter: "active", offset: 0, limit: 50,
    });
    expect(parseTaskPanelQuery(null)).toEqual({ filter: "active", offset: 0, limit: 20 });
  });
});
