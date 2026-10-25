import { z } from "zod";
import { isValidCaseName } from "@/lib/docs/case-naming";
import { isValidDate } from "@/lib/docs/naming";
import { caseIndexPath } from "@/lib/docs/paths";

export const TASK_LEDGER_VERSION = 1;
export const TASK_LEDGER_PATH = "memory/config/task-state.json";
export const TASK_LEDGER_LOCK_KEY = "task-ledger";

const text = z
  .string()
  .min(1)
  .max(4000)
  .refine((value) => value.trim().length > 0, "Must not be blank");
const operationIdSchema = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => value.trim().length > 0, "Must not be blank");
const revisionSchema = z.number().int().positive();
const isoDateTimeSchema = z.string().datetime({ offset: true });

export const calendarDateSchema = z
  .string()
  .refine(isValidDate, "Expected a real calendar date in YYYY-MM-DD form");

function isValidTaskCaseName(caseName: string): boolean {
  return !/%[0-9A-Fa-f]{2}/.test(caseName) && isValidCaseName(caseName);
}

export function parseTaskRef(ref: string): string | null {
  if (!ref.startsWith("tasks/")) return null;
  const caseName = ref.slice("tasks/".length);
  return isValidTaskCaseName(caseName) ? caseName : null;
}

export function isValidTaskRef(ref: string): boolean {
  return parseTaskRef(ref) !== null;
}

export function taskRefForCase(caseName: string): string {
  if (!isValidTaskCaseName(caseName)) {
    throw new TaskLedgerError(
      "invalid_operation",
      `Illegal task case name: ${JSON.stringify(caseName)}`,
    );
  }
  return `tasks/${caseName}`;
}

export function taskDocumentPath(ref: string): string {
  const caseName = parseTaskRef(ref);
  if (caseName === null) {
    throw new TaskLedgerError(
      "invalid_operation",
      `Illegal task ref: ${JSON.stringify(ref)}; expected exactly tasks/<caseName>`,
    );
  }
  return caseIndexPath("tasks", caseName);
}

export const taskRefSchema = z
  .string()
  .refine(isValidTaskRef, "Expected exactly tasks/<legalCaseName>");

export const taskStatusSchema = z.enum([
  "open",
  "waiting",
  "paused",
  "completed",
  "cancelled",
  "needs_review",
]);
export const mutableTaskStatusSchema = z.enum([
  "open",
  "waiting",
  "paused",
  "completed",
  "cancelled",
]);
export const createTaskStatusSchema = z.enum(["open", "waiting", "paused"]);

export const taskEvidenceSchema = z
  .object({
    sliceId: text,
    turnId: text,
    statement: text,
  })
  .strict();

export const replyEvidenceSchema = z
  .object({
    sliceId: text,
    turnId: text,
  })
  .strict();

export const persistedReplySchema = replyEvidenceSchema.extend({
  status: z.literal("persisted"),
});
export const replyOutcomeSchema = z.discriminatedUnion("status", [
  persistedReplySchema,
  z
    .object({
      status: z.literal("failed"),
      detail: text.optional(),
    })
    .strict(),
  z
    .object({
      status: z.literal("cancelled"),
      detail: text.optional(),
    })
    .strict(),
]);

export const lastFollowupSchema = z
  .object({
    revision: revisionSchema,
    on: calendarDateSchema,
    reply: replyEvidenceSchema,
  })
  .strict();

export const taskEntrySchema = z
  .object({
    ref: taskRefSchema,
    summary: text,
    status: taskStatusSchema,
    revision: revisionSchema,
    dueOn: calendarDateSchema.optional(),
    nextCheckOn: calendarDateSchema.optional(),
    waitingCondition: text.optional(),
    nextAction: text.optional(),
    evidence: z.array(taskEvidenceSchema),
    updatedAt: isoDateTimeSchema,
    lastFollowup: lastFollowupSchema.optional(),
  })
  .strict()
  .superRefine((task, ctx) => {
    if (task.status === "waiting" && !task.waitingCondition) {
      ctx.addIssue({
        code: "custom",
        path: ["waitingCondition"],
        message: "A waiting task requires an explicit waiting condition",
      });
    }
    if (task.status !== "waiting" && task.waitingCondition !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["waitingCondition"],
        message: "Only a waiting task may carry a waiting condition",
      });
    }
    if (task.status !== "needs_review" && task.evidence.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["evidence"],
        message: "A reviewed task requires explicit user-statement evidence",
      });
    }
    if (task.lastFollowup && task.lastFollowup.revision > task.revision) {
      ctx.addIssue({
        code: "custom",
        path: ["lastFollowup", "revision"],
        message: "Follow-up revision cannot exceed the task revision",
      });
    }
  });

export const createTaskDraftSchema = z
  .object({
    ref: taskRefSchema.describe("Exact task identity: tasks/<legalCaseName>"),
    summary: text,
    status: createTaskStatusSchema.optional(),
    dueOn: calendarDateSchema.optional(),
    nextCheckOn: calendarDateSchema.optional(),
    waitingCondition: text.optional(),
    nextAction: text.optional(),
  })
  .strict();

export const taskChangesSchema = z
  .object({
    summary: text.optional(),
    status: mutableTaskStatusSchema.optional().describe(
      "To correct a completed/cancelled task, choose a different status and also set reopen:true.",
    ),
    dueOn: calendarDateSchema.nullable().optional(),
    nextCheckOn: calendarDateSchema.nullable().optional(),
    waitingCondition: text.nullable().optional(),
    nextAction: text.nullable().optional(),
    reopen: z.literal(true).optional().describe(
      "Explicit user correction only: required with a different status to reopen a completed/cancelled task. Requires fresh expectedRevision and new direct user evidence; never use for HQ inference from historical prose.",
    ),
  })
  .strict();

export const createTaskInputSchema = z
  .object({
    operationId: operationIdSchema,
    now: isoDateTimeSchema,
    task: createTaskDraftSchema,
    userCommitment: taskEvidenceSchema,
  })
  .strict();

export const updateTaskInputSchema = z
  .object({
    operationId: operationIdSchema,
    now: isoDateTimeSchema,
    ref: taskRefSchema,
    expectedRevision: revisionSchema,
    changes: taskChangesSchema,
    evidence: taskEvidenceSchema,
  })
  .strict();

export const taskFollowupSchema = z
  .object({
    ref: taskRefSchema,
    expectedRevision: revisionSchema,
  })
  .strict();

export const acknowledgeTaskFollowupsInputSchema = z
  .object({
    operationId: operationIdSchema,
    now: isoDateTimeSchema,
    todayLocal: calendarDateSchema,
    outcome: replyOutcomeSchema,
    followups: z.array(taskFollowupSchema).min(1),
  })
  .strict();

export const taskResultEvidenceSchema = z
  .object({
    producerRunId: text,
    statement: text,
    sliceId: text.optional(),
    turnId: text.optional(),
  })
  .strict()
  .superRefine((evidence, ctx) => {
    if ((evidence.sliceId === undefined) !== (evidence.turnId === undefined)) {
      ctx.addIssue({
        code: "custom",
        message: "sliceId and turnId must be supplied together",
      });
    }
  });

export const taskResultDeliverySchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("pending") }).strict(),
  z
    .object({
      state: z.literal("delivered"),
      at: isoDateTimeSchema,
      reply: replyEvidenceSchema,
    })
    .strict(),
]);

export const taskResultSchema = z
  .object({
    id: operationIdSchema,
    taskRef: taskRefSchema,
    revision: revisionSchema,
    evidence: taskResultEvidenceSchema,
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
    delivery: taskResultDeliverySchema,
  })
  .strict();

export const recordTaskResultInputSchema = z
  .object({
    operationId: operationIdSchema,
    now: isoDateTimeSchema,
    result: z
      .object({
        id: operationIdSchema,
        taskRef: taskRefSchema,
        evidence: taskResultEvidenceSchema,
      })
      .strict(),
  })
  .strict();

export const confirmTaskResultDeliveryInputSchema = z
  .object({
    operationId: operationIdSchema,
    now: isoDateTimeSchema,
    resultId: operationIdSchema,
    expectedRevision: revisionSchema,
    outcome: replyOutcomeSchema,
  })
  .strict();

export const legacyTaskManifestEntrySchema = z
  .object({
    ref: taskRefSchema,
    summary: text.optional(),
  })
  .strict();

export const reconcileLegacyTasksInputSchema = z
  .object({
    operationId: operationIdSchema,
    now: isoDateTimeSchema,
    entries: z.array(legacyTaskManifestEntrySchema),
  })
  .strict();

export const taskOperationSchema = z.discriminatedUnion("type", [
  createTaskInputSchema.extend({ type: z.literal("create") }),
  updateTaskInputSchema.extend({ type: z.literal("update") }),
  z
    .object({
      type: z.literal("acknowledge_followups"),
      operationId: operationIdSchema,
      now: isoDateTimeSchema,
      todayLocal: calendarDateSchema,
      reply: persistedReplySchema,
      followups: z.array(taskFollowupSchema).min(1),
    })
    .strict(),
  recordTaskResultInputSchema.extend({ type: z.literal("record_result") }),
  z
    .object({
      type: z.literal("deliver_result"),
      operationId: operationIdSchema,
      now: isoDateTimeSchema,
      resultId: operationIdSchema,
      expectedRevision: revisionSchema,
      reply: persistedReplySchema,
    })
    .strict(),
  reconcileLegacyTasksInputSchema.extend({
    type: z.literal("reconcile_legacy"),
  }),
]);

export const taskOperationReceiptSchema = z
  .object({
    operationId: operationIdSchema,
    kind: z.enum([
      "create",
      "update",
      "acknowledge_followups",
      "record_result",
      "deliver_result",
      "reconcile_legacy",
    ]),
    appliedAt: isoDateTimeSchema,
    taskRefs: z.array(taskRefSchema),
    resultIds: z.array(operationIdSchema),
  })
  .strict();

export const taskLedgerSchema = z
  .object({
    version: z.literal(TASK_LEDGER_VERSION),
    tasks: z.array(taskEntrySchema),
    results: z.array(taskResultSchema),
    operations: z.array(taskOperationReceiptSchema),
  })
  .strict();

export const taskQuerySchema = z
  .object({
    ref: taskRefSchema.optional(),
    status: taskStatusSchema.optional(),
    query: text.optional(),
    offset: z.number().int().nonnegative().optional(),
    limit: z.number().int().positive().optional(),
  })
  .strict();

export const createTaskToolSchema = createTaskDraftSchema.describe(
  "Create a task only when the CURRENT user message is a genuine commitment, never for an agent proposal. The executor attaches that verbatim user message as evidence.",
);
export const updateTaskToolSchema = z
  .object({
    ref: taskRefSchema,
    expectedRevision: revisionSchema,
    changes: taskChangesSchema,
  })
  .strict()
  .describe(
    "Narrowly update a task only from explicit user feedback in the current turn. Use the revision returned by the task query tool. Reopening completed/cancelled requires changes.reopen:true, a different status, fresh expectedRevision, and new direct user evidence; never reopen from guessed history.",
  );
export const queryTasksToolSchema = taskQuerySchema.describe(
  "List or query the authoritative task ledger. Results include every lifecycle field and revision, including non-candidates; omit status to include completed, cancelled, and needs_review tasks.",
);

export type CalendarDate = z.infer<typeof calendarDateSchema>;
export type TaskStatus = z.infer<typeof taskStatusSchema>;
export type TaskEvidence = z.infer<typeof taskEvidenceSchema>;
export type ReplyOutcome = z.infer<typeof replyOutcomeSchema>;
export type PersistedReply = z.infer<typeof persistedReplySchema>;
export type TaskEntry = z.infer<typeof taskEntrySchema>;
export type TaskResult = z.infer<typeof taskResultSchema>;
export type TaskLedger = z.infer<typeof taskLedgerSchema>;
export type TaskOperation = z.infer<typeof taskOperationSchema>;
export type TaskOperationReceipt = z.infer<typeof taskOperationReceiptSchema>;
export type CreateTaskInput = z.infer<typeof createTaskInputSchema>;
export type UpdateTaskInput = z.infer<typeof updateTaskInputSchema>;
export type AcknowledgeTaskFollowupsInput = z.infer<
  typeof acknowledgeTaskFollowupsInputSchema
>;
export type RecordTaskResultInput = z.infer<typeof recordTaskResultInputSchema>;
export type ConfirmTaskResultDeliveryInput = z.infer<
  typeof confirmTaskResultDeliveryInputSchema
>;
export type ReconcileLegacyTasksInput = z.infer<
  typeof reconcileLegacyTasksInputSchema
>;
export type TaskQuery = z.infer<typeof taskQuerySchema>;

export type TaskLedgerReadResult =
  | { status: "ready"; ledger: TaskLedger; basisHeadSha: string | null }
  | { status: "missing"; basisHeadSha: string | null }
  | { status: "unavailable"; message: string }
  | { status: "corrupt"; message: string };

export interface TaskApplication {
  outcome: "applied" | "deduped";
  ledger: TaskLedger;
  taskRefs: string[];
  resultIds: string[];
}

export interface TaskMutationResult extends TaskApplication {
  commitSha: string | null;
  queued: boolean;
  attempts: number;
}

export type TaskLedgerErrorCode =
  | "invalid_operation"
  | "read_only"
  | "ledger_unavailable"
  | "ledger_corrupt"
  | "task_exists"
  | "task_not_found"
  | "stale_revision"
  | "terminal_task"
  | "result_exists"
  | "result_not_found"
  | "result_already_delivered"
  | "head_conflict";

export class TaskLedgerError extends Error {
  readonly code: TaskLedgerErrorCode;

  constructor(code: TaskLedgerErrorCode, message: string) {
    super(message);
    this.name = "TaskLedgerError";
    this.code = code;
  }
}
