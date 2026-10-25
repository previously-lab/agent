import { describe, expect, it } from "vitest";
import type { TaskEntry, TaskLedger } from "@/lib/tasks/contracts";
import { emptyTaskLedger, validateTaskLedger } from "@/lib/tasks/ledger";
import { selectTaskCandidates } from "@/lib/tasks/selector";

const TODAY = "2026-10-26";
const NOW = "2026-10-26T12:00:00.000Z";

function makeTask(ref: string, overrides: Partial<TaskEntry> = {}): TaskEntry {
  return {
    ref,
    summary: `Task ${ref}`,
    status: "open",
    revision: 1,
    evidence: [
      {
        sliceId: "2026-10-01-0900",
        turnId: "turn-1",
        statement: "I explicitly committed to this.",
      },
    ],
    updatedAt: NOW,
    ...overrides,
  };
}

function ledgerWith(tasks: TaskEntry[]): TaskLedger {
  return validateTaskLedger({ ...emptyTaskLedger(), tasks });
}

function selectedRefs(ledger: TaskLedger, limit = 20, relevance?: string) {
  return selectTaskCandidates(ledger, {
    todayLocal: TODAY,
    limit,
    relevance,
  }).candidates.map((candidate) => candidate.task.ref);
}

describe("due and check-date selection", () => {
  it("picks old due/check tasks regardless of updatedAt or a today-shaped prose statement", () => {
    const ledger = ledgerWith([
      makeTask("tasks/old-due", {
        dueOn: "2026-01-01",
        updatedAt: NOW,
        summary: "2026-10-26：这条今天尾部文字不是完成事件",
      }),
      makeTask("tasks/old-check", {
        nextCheckOn: "2026-10-25",
        updatedAt: "2020-01-01T00:00:00.000Z",
      }),
      makeTask("tasks/future", {
        dueOn: "2026-12-01",
        nextCheckOn: "2026-11-01",
      }),
    ]);
    const selection = selectTaskCandidates(ledger, {
      todayLocal: TODAY,
      limit: 10,
    });
    expect(selection.candidates.map((candidate) => candidate.task.ref)).toEqual([
      "tasks/old-due",
      "tasks/old-check",
    ]);
    expect(selection.candidates[0].reasons).toContain("overdue");
    expect(selection.candidates[1].reasons).toContain("check_due");
    expect(ledger.tasks[0].status).toBe("open");
    expect(ledger.tasks[0].dueOn).toBe("2026-01-01");
  });

  it("includes due today and overdue nextCheck dates without inventing dates", () => {
    const undated = makeTask("tasks/undated");
    const ledger = ledgerWith([
      makeTask("tasks/due-today", { dueOn: TODAY }),
      makeTask("tasks/check-overdue", { nextCheckOn: "2024-02-29" }),
      undated,
    ]);
    expect(selectedRefs(ledger)).toEqual([
      "tasks/due-today",
      "tasks/check-overdue",
      "tasks/undated",
    ]);
    expect(undated.dueOn).toBeUndefined();
    expect(undated.nextCheckOn).toBeUndefined();
  });

  it("includes tomorrow's open deadline as due_soon using calendar arithmetic, not document age", () => {
    const ledger = ledgerWith([
      makeTask("tasks/due-tomorrow", {
        dueOn: "2026-10-27",
        updatedAt: "2026-10-25T12:00:00.000Z",
      }),
      makeTask("tasks/far-future", { dueOn: "2026-11-15" }),
      makeTask("tasks/paused-tomorrow", {
        status: "paused",
        dueOn: "2026-10-27",
      }),
    ]);
    const selection = selectTaskCandidates(ledger, {
      todayLocal: TODAY,
      limit: 10,
    });
    expect(selection.candidates).toHaveLength(1);
    expect(selection.candidates[0]).toMatchObject({
      task: { ref: "tasks/due-tomorrow", dueOn: "2026-10-27" },
      reasons: ["due_soon"],
    });

    const monthBoundary = selectTaskCandidates(
      ledgerWith([makeTask("tasks/month-boundary", { dueOn: "2026-11-01" })]),
      { todayLocal: "2026-10-31", limit: 10 },
    );
    expect(monthBoundary.candidates[0].reasons).toContain("due_soon");
  });
});

describe("lifecycle suppression", () => {
  it("suppresses paused tasks until an explicit check date, even when another date is overdue", () => {
    const ledger = ledgerWith([
      makeTask("tasks/paused", {
        status: "paused",
        dueOn: "2020-01-01",
      }),
      makeTask("tasks/paused-check", {
        status: "paused",
        nextCheckOn: TODAY,
      }),
      makeTask("tasks/paused-relevant", {
        status: "paused",
        summary: "explicitly relevant but still paused",
      }),
    ]);
    expect(selectedRefs(ledger, 20, "relevant")).toEqual([
      "tasks/paused-check",
    ]);
  });

  it("does not nag for undated waiting tasks, but allows dates or explicit relevance", () => {
    const ledger = ledgerWith([
      makeTask("tasks/waiting-undated", {
        status: "waiting",
        waitingCondition: "Waiting for the supplier",
      }),
      makeTask("tasks/waiting-due", {
        status: "waiting",
        waitingCondition: "Waiting for a reply",
        dueOn: "2026-10-01",
      }),
      makeTask("tasks/waiting-relevant", {
        status: "waiting",
        waitingCondition: "Waiting for visa documents",
      }),
    ]);
    expect(selectedRefs(ledger)).toEqual(["tasks/waiting-due"]);
    expect(selectedRefs(ledger, 20, "visa")).toEqual([
      "tasks/waiting-due",
      "tasks/waiting-relevant",
    ]);
  });

  it("excludes completed, cancelled, and unreviewed legacy tasks on every day", () => {
    const ledger = ledgerWith([
      makeTask("tasks/completed", {
        status: "completed",
        dueOn: "2020-01-01",
        nextCheckOn: "2020-01-01",
      }),
      makeTask("tasks/cancelled", {
        status: "cancelled",
        dueOn: TODAY,
      }),
      makeTask("tasks/legacy", {
        status: "needs_review",
        evidence: [],
        dueOn: TODAY,
      }),
    ]);
    expect(selectedRefs(ledger)).toEqual([]);
  });

  it("uses lastFollowup only for the same revision and day", () => {
    const followed = makeTask("tasks/followed", {
      dueOn: "2020-01-01",
      lastFollowup: {
        revision: 1,
        on: TODAY,
        reply: { sliceId: "slice", turnId: "reply" },
      },
    });
    expect(selectedRefs(ledgerWith([followed]))).toEqual([]);
    expect(
      selectedRefs(
        ledgerWith([
          {
            ...followed,
            revision: 2,
          },
        ]),
      ),
    ).toEqual(["tasks/followed"]);
    expect(
      selectedRefs(
        ledgerWith([
          {
            ...followed,
            lastFollowup: {
              ...followed.lastFollowup!,
              on: "2026-10-25",
            },
          },
        ]),
      ),
    ).toEqual(["tasks/followed"]);
  });
});

describe("durable undated review and scale", () => {
  it("keeps more than five undated tasks, reports exact remaining counts, and never assigns dates", () => {
    const tasks = Array.from({ length: 9 }, (_, index) =>
      makeTask(`tasks/open-${index}`),
    );
    const selection = selectTaskCandidates(ledgerWith(tasks), {
      todayLocal: TODAY,
      limit: 4,
    });
    expect(selection.candidates).toHaveLength(4);
    expect(selection.totalCandidates).toBe(9);
    expect(selection.hasMore).toBe(true);
    expect(selection.remaining).toBe(5);
    expect(
      selection.candidates.every((candidate) => candidate.reasons.includes("review")),
    ).toBe(true);
    expect(tasks.every((task) => !task.dueOn && !task.nextCheckOn)).toBe(true);
  });

  it("rotates undated review by the last confirmed follow-up, not by injection", () => {
    const ledger = ledgerWith([
      makeTask("tasks/a", {
        lastFollowup: {
          revision: 1,
          on: "2026-10-25",
          reply: { sliceId: "slice-a", turnId: "reply-a" },
        },
      }),
      makeTask("tasks/b"),
      makeTask("tasks/c", {
        lastFollowup: {
          revision: 1,
          on: "2026-10-24",
          reply: { sliceId: "slice-c", turnId: "reply-c" },
        },
      }),
    ]);
    expect(selectedRefs(ledger, 3)).toEqual(["tasks/b", "tasks/c", "tasks/a"]);
    expect(selectedRefs(ledger, 3)).toEqual(["tasks/b", "tasks/c", "tasks/a"]);
  });

  it("adds relevance rank while retaining unrelated bounded review", () => {
    const ledger = ledgerWith([
      makeTask("tasks/passport", { summary: "Renew the passport" }),
      makeTask("tasks/other"),
    ]);
    const selection = selectTaskCandidates(ledger, {
      todayLocal: TODAY,
      limit: 10,
      relevance: "passport",
    });
    expect(selection.candidates.map((candidate) => candidate.task.ref)).toEqual([
      "tasks/passport",
      "tasks/other",
    ]);
    expect(selection.candidates[0].reasons).toContain("relevance");
    expect(selection.candidates[1].reasons).toEqual(["review"]);
  });

  it("keeps bounded review when nonempty relevance does not match 整理账单", () => {
    const ledger = ledgerWith([makeTask("tasks/bills", { summary: "整理账单" })]);
    const selection = selectTaskCandidates(ledger, {
      todayLocal: TODAY,
      limit: 1,
      relevance: "今天过得怎么样",
    });
    expect(selection.totalCandidates).toBe(1);
    expect(selection.candidates).toHaveLength(1);
    expect(selection.candidates[0]).toMatchObject({
      task: { ref: "tasks/bills", summary: "整理账单" },
      reasons: ["review"],
    });
  });
});
