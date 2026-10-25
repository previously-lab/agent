import { describe, expect, it } from "vitest";
import {
  TASK_LEDGER_PATH,
  calendarDateSchema,
  createTaskToolSchema,
  isValidTaskRef,
  parseTaskRef,
  queryTasksToolSchema,
  taskDocumentPath,
  taskRefForCase,
} from "@/lib/tasks/contracts";
import {
  emptyTaskLedger,
  parseTaskLedger,
  queryTasks,
  serializeTaskLedger,
  validateTaskLedger,
  type TaskQueryPage,
} from "@/lib/tasks/ledger";
import type { TaskEntry } from "@/lib/tasks/contracts";

const NOW = "2026-10-26T12:00:00.000Z";

function makeTask(ref: string, overrides: Partial<TaskEntry> = {}): TaskEntry {
  return {
    ref,
    summary: `Summary for ${ref}`,
    status: "open",
    revision: 3,
    evidence: [
      {
        sliceId: "2026-10-26-1000",
        turnId: "turn-1",
        statement: "I will do this.",
      },
    ],
    updatedAt: NOW,
    ...overrides,
  };
}

function ledgerWith(tasks: TaskEntry[]) {
  return validateTaskLedger({
    ...emptyTaskLedger(),
    tasks,
  });
}

describe("task refs and prose paths", () => {
  it("accepts exactly tasks/<legalCaseName> and derives the separate prose path", () => {
    expect(isValidTaskRef("tasks/订机票")).toBe(true);
    expect(isValidTaskRef("tasks/2026-11-05-屏幕供应商")).toBe(true);
    expect(isValidTaskRef("tasks/100% complete")).toBe(true);
    expect(parseTaskRef("tasks/订机票")).toBe("订机票");
    expect(taskRefForCase("订机票")).toBe("tasks/订机票");
    expect(taskDocumentPath("tasks/订机票")).toBe(
      "memory/tasks/订机票/index.md",
    );
    expect(taskDocumentPath("tasks/100% complete")).toBe(
      "memory/tasks/100% complete/index.md",
    );
    expect(TASK_LEDGER_PATH).toBe("memory/config/task-state.json");
  });

  it.each([
    "memory/tasks/订机票",
    "tasks/订机票/index.md",
    "tasks/../config",
    "tasks/a/b",
    "tasks/a\\b",
    "tasks/.",
    "tasks/",
    "tasks/2026-02-30-bad-date",
    "tasks/%2e%2e%2fpeople%2fuser",
    "tasks/%2E%2E%5Cpeople%5Cuser",
    "tasks/%2e%2e",
    "tasks/%2fpeople",
    "tasks/%5cpeople",
    "tasks/%43%4f%4e",
    "tasks/CON",
    "tasks/aux.txt",
    "tasks/com1",
  ])("refuses traversal, encoded aliases, reserved names, and illegal refs: %s", (ref) => {
    expect(isValidTaskRef(ref)).toBe(false);
    expect(() => taskDocumentPath(ref)).toThrow();
  });
});

describe("calendar and ledger validation", () => {
  it("validates real calendar dates rather than date-shaped strings", () => {
    expect(calendarDateSchema.safeParse("2028-02-29").success).toBe(true);
    expect(calendarDateSchema.safeParse("2026-02-29").success).toBe(false);
    expect(calendarDateSchema.safeParse("2026-02-30").success).toBe(false);
    expect(calendarDateSchema.safeParse("2026-13-01").success).toBe(false);
    expect(calendarDateSchema.safeParse("2026-1-01").success).toBe(false);
  });

  it("round-trips valid state without changing raw evidence", () => {
    const evidence = {
      sliceId: "slice/raw",
      turnId: "turn/raw",
      statement: "  Preserve my exact words.  ",
    };
    const ledger = ledgerWith([
      makeTask("tasks/raw", { evidence: [evidence] }),
    ]);
    const restored = parseTaskLedger(serializeTaskLedger(ledger));
    expect(restored.tasks[0].evidence[0]).toEqual(evidence);
  });

  it("rejects unknown status, malformed revisions, duplicate refs, and unknown fields", () => {
    const task = makeTask("tasks/one");
    expect(() =>
      validateTaskLedger({
        ...emptyTaskLedger(),
        tasks: [{ ...task, status: "mystery" }],
      }),
    ).toThrow();
    expect(() =>
      validateTaskLedger({
        ...emptyTaskLedger(),
        tasks: [{ ...task, revision: 0 }],
      }),
    ).toThrow();
    expect(() => ledgerWith([task, { ...task }])).toThrow(/Duplicate task ref/);
    expect(() =>
      validateTaskLedger({
        ...emptyTaskLedger(),
        tasks: [{ ...task, inferredFromProse: true }],
      }),
    ).toThrow();
  });

  it("requires waiting conditions and permits evidence-free entries only for legacy review", () => {
    expect(() =>
      ledgerWith([
        makeTask("tasks/waiting", {
          status: "waiting",
          evidence: [],
        }),
      ]),
    ).toThrow();
    const legacy = ledgerWith([
      makeTask("tasks/legacy", {
        status: "needs_review",
        evidence: [],
      }),
    ]);
    expect(legacy.tasks[0].status).toBe("needs_review");
  });
});

describe("query and root tool schemas", () => {
  it("returns full revision information for candidates and non-candidates with explicit hasMore", () => {
    const tasks = Array.from({ length: 8 }, (_, index) =>
      makeTask(`tasks/task-${index}`, {
        status: index === 6 ? "completed" : index === 7 ? "cancelled" : "open",
        revision: index + 1,
      }),
    );
    const page: TaskQueryPage = queryTasks(ledgerWith(tasks), {
      offset: 5,
      limit: 2,
    });
    expect(page.total).toBe(8);
    expect(page.tasks).toHaveLength(2);
    expect(page.hasMore).toBe(true);
    expect(page.tasks.map((task) => task.revision)).toEqual([6, 7]);
    const completed = queryTasks(ledgerWith(tasks), {
      status: "completed",
    });
    expect(completed.total).toBe(1);
    expect(completed.hasMore).toBe(false);
    expect(completed.tasks[0]).toMatchObject({
      ref: "tasks/task-6",
      status: "completed",
      revision: 7,
      evidence: [
        {
          sliceId: "2026-10-26-1000",
          turnId: "turn-1",
          statement: "I will do this.",
        },
      ],
    });
  });

  it("supports exact-ref queries without approximate path aliases", () => {
    const ledger = ledgerWith([
      makeTask("tasks/one"),
      makeTask("tasks/one-more"),
    ]);
    expect(queryTasks(ledger, { ref: "tasks/one" }).total).toBe(1);
    expect(queryTasks(ledger, { query: "ONE" }).total).toBe(2);
  });

  it("keeps evidence attachment in the executor, not in model-authored tool input", () => {
    const input = {
      ref: "tasks/genuine",
      summary: "A genuine user commitment",
    };
    expect(createTaskToolSchema.safeParse(input).success).toBe(true);
    expect(
      createTaskToolSchema.safeParse({
        ...input,
        userCommitment: {
          sliceId: "invented",
          turnId: "invented",
          statement: "invented",
        },
      }).success,
    ).toBe(false);
    expect(queryTasksToolSchema.safeParse({ limit: 25 }).success).toBe(true);
  });
});
