import {
  TASK_LEDGER_VERSION,
  TaskLedgerError,
  taskEntrySchema,
  taskLedgerSchema,
  taskOperationSchema,
  taskQuerySchema,
  taskResultSchema,
  type TaskApplication,
  type TaskEntry,
  type TaskEvidence,
  type TaskLedger,
  type TaskMutationResult,
  type TaskOperation,
  type TaskQuery,
  type TaskResult,
} from "./contracts";

function byText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort(byText);
}

function schemaMessage(error: { issues: Array<{ path: PropertyKey[]; message: string }> }): string {
  return error.issues
    .map((issue) => `${issue.path.map(String).join(".") || "root"}: ${issue.message}`)
    .join("; ");
}

function assertLedgerInvariants(ledger: TaskLedger): void {
  const refs = new Set<string>();
  for (const task of ledger.tasks) {
    if (refs.has(task.ref)) {
      throw new TaskLedgerError("ledger_corrupt", `Duplicate task ref: ${task.ref}`);
    }
    refs.add(task.ref);
  }
  const resultIds = new Set<string>();
  for (const result of ledger.results) {
    if (resultIds.has(result.id)) {
      throw new TaskLedgerError("ledger_corrupt", `Duplicate result id: ${result.id}`);
    }
    resultIds.add(result.id);
    if (!refs.has(result.taskRef)) {
      throw new TaskLedgerError(
        "ledger_corrupt",
        `Result ${result.id} points to unknown task ${result.taskRef}`,
      );
    }
  }
  const operationIds = new Set<string>();
  for (const receipt of ledger.operations) {
    if (operationIds.has(receipt.operationId)) {
      throw new TaskLedgerError(
        "ledger_corrupt",
        `Duplicate operation id: ${receipt.operationId}`,
      );
    }
    operationIds.add(receipt.operationId);
  }
}

export function emptyTaskLedger(): TaskLedger {
  return {
    version: TASK_LEDGER_VERSION,
    tasks: [],
    results: [],
    operations: [],
  };
}

export function validateTaskLedger(value: unknown): TaskLedger {
  const parsed = taskLedgerSchema.safeParse(value);
  if (!parsed.success) {
    throw new TaskLedgerError("ledger_corrupt", schemaMessage(parsed.error));
  }
  assertLedgerInvariants(parsed.data);
  return parsed.data;
}

export function parseTaskLedger(raw: string): TaskLedger {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new TaskLedgerError(
      "ledger_corrupt",
      `Task ledger is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return validateTaskLedger(value);
}

export function serializeTaskLedger(ledger: TaskLedger): string {
  const valid = validateTaskLedger(ledger);
  const ordered: TaskLedger = {
    version: valid.version,
    tasks: [...valid.tasks].sort((a, b) => byText(a.ref, b.ref)),
    results: [...valid.results].sort((a, b) => byText(a.id, b.id)),
    operations: [...valid.operations].sort((a, b) =>
      byText(a.operationId, b.operationId),
    ),
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

export interface TaskQueryPage {
  tasks: TaskEntry[];
  total: number;
  offset: number;
  hasMore: boolean;
}

export function queryTasks(
  ledger: TaskLedger,
  input: TaskQuery = {},
): TaskQueryPage {
  const parsed = taskQuerySchema.safeParse(input);
  if (!parsed.success) {
    throw new TaskLedgerError(
      "invalid_operation",
      `Invalid task query: ${schemaMessage(parsed.error)}`,
    );
  }
  const query = parsed.data;
  const needle = query.query?.toLocaleLowerCase();
  const filtered = ledger.tasks
    .filter((task) => query.ref === undefined || task.ref === query.ref)
    .filter((task) => query.status === undefined || task.status === query.status)
    .filter((task) => {
      if (needle === undefined) return true;
      return [task.ref, task.summary, task.nextAction, task.waitingCondition]
        .filter((value): value is string => value !== undefined)
        .some((value) => value.toLocaleLowerCase().includes(needle));
    })
    .sort((a, b) => byText(a.ref, b.ref));
  const offset = query.offset ?? 0;
  const tasks = filtered.slice(
    offset,
    query.limit === undefined ? undefined : offset + query.limit,
  );
  return {
    tasks,
    total: filtered.length,
    offset,
    hasMore: offset + tasks.length < filtered.length,
  };
}

function invalidOperation(message: string): never {
  throw new TaskLedgerError("invalid_operation", message);
}

function sameEvidence(a: TaskEvidence, b: TaskEvidence): boolean {
  return (
    a.sliceId === b.sliceId &&
    a.turnId === b.turnId &&
    a.statement === b.statement
  );
}

function appendEvidence(task: TaskEntry, evidence: TaskEvidence): {
  evidence: TaskEvidence[];
  added: boolean;
} {
  if (task.evidence.some((item) => sameEvidence(item, evidence))) {
    return { evidence: task.evidence, added: false };
  }
  return { evidence: [...task.evidence, evidence], added: true };
}

function optionalChanged(
  before: string | undefined,
  change: string | null | undefined,
): boolean {
  if (change === undefined) return false;
  return before !== (change === null ? undefined : change);
}

function applyCreate(ledger: TaskLedger, operation: Extract<TaskOperation, { type: "create" }>): {
  tasks: TaskEntry[];
  taskRefs: string[];
} {
  if (ledger.tasks.some((task) => task.ref === operation.task.ref)) {
    throw new TaskLedgerError(
      "task_exists",
      `Task already exists: ${operation.task.ref}`,
    );
  }
  const candidate = {
    ref: operation.task.ref,
    summary: operation.task.summary,
    status: operation.task.status ?? "open",
    revision: 1,
    dueOn: operation.task.dueOn,
    nextCheckOn: operation.task.nextCheckOn,
    waitingCondition: operation.task.waitingCondition,
    nextAction: operation.task.nextAction,
    evidence: [operation.userCommitment],
    updatedAt: operation.now,
  };
  const parsed = taskEntrySchema.safeParse(candidate);
  if (!parsed.success) invalidOperation(schemaMessage(parsed.error));
  return {
    tasks: [...ledger.tasks, parsed.data],
    taskRefs: [parsed.data.ref],
  };
}

function applyUpdate(ledger: TaskLedger, operation: Extract<TaskOperation, { type: "update" }>): {
  tasks: TaskEntry[];
  taskRefs: string[];
} {
  const current = ledger.tasks.find((task) => task.ref === operation.ref);
  if (!current) {
    throw new TaskLedgerError("task_not_found", `Task not found: ${operation.ref}`);
  }
  if (current.revision !== operation.expectedRevision) {
    throw new TaskLedgerError(
      "stale_revision",
      `Task ${operation.ref} is at revision ${current.revision}, not ${operation.expectedRevision}; query it again before updating`,
    );
  }
  const terminal = current.status === "completed" || current.status === "cancelled";
  const changesTerminalStatus =
    terminal &&
    operation.changes.status !== undefined &&
    operation.changes.status !== current.status;
  const evidence = appendEvidence(current, operation.evidence);
  if (operation.changes.reopen === true && !changesTerminalStatus) {
    invalidOperation(
      "reopen:true is valid only when a completed/cancelled task moves to a different status",
    );
  }
  if (
    changesTerminalStatus &&
    (operation.changes.reopen !== true || !evidence.added)
  ) {
    throw new TaskLedgerError(
      "terminal_task",
      `Task ${current.ref} is ${current.status}; reopening requires reopen:true and new explicit user evidence`,
    );
  }

  let waitingCondition = operation.changes.waitingCondition === null
    ? undefined
    : operation.changes.waitingCondition ?? current.waitingCondition;
  if (
    operation.changes.status !== undefined &&
    operation.changes.status !== "waiting" &&
    operation.changes.waitingCondition === undefined
  ) {
    waitingCondition = undefined;
  }
  const lifecycleChanged =
    (operation.changes.summary !== undefined &&
      operation.changes.summary !== current.summary) ||
    (operation.changes.status !== undefined &&
      operation.changes.status !== current.status) ||
    optionalChanged(current.dueOn, operation.changes.dueOn) ||
    optionalChanged(current.nextCheckOn, operation.changes.nextCheckOn) ||
    optionalChanged(current.waitingCondition, operation.changes.waitingCondition) ||
    optionalChanged(current.nextAction, operation.changes.nextAction) ||
    waitingCondition !== current.waitingCondition;

  let next = current;
  if (lifecycleChanged || evidence.added) {
    const candidate = {
      ...current,
      summary: operation.changes.summary ?? current.summary,
      status: operation.changes.status ?? current.status,
      dueOn: operation.changes.dueOn === null
        ? undefined
        : operation.changes.dueOn ?? current.dueOn,
      nextCheckOn: operation.changes.nextCheckOn === null
        ? undefined
        : operation.changes.nextCheckOn ?? current.nextCheckOn,
      waitingCondition,
      nextAction: operation.changes.nextAction === null
        ? undefined
        : operation.changes.nextAction ?? current.nextAction,
      evidence: evidence.evidence,
      revision: current.revision + 1,
      updatedAt: operation.now,
    };
    const parsed = taskEntrySchema.safeParse(candidate);
    if (!parsed.success) invalidOperation(schemaMessage(parsed.error));
    next = parsed.data;
  }
  return {
    tasks: ledger.tasks.map((task) => (task.ref === current.ref ? next : task)),
    taskRefs: [current.ref],
  };
}

function applyAcknowledgments(
  ledger: TaskLedger,
  operation: Extract<TaskOperation, { type: "acknowledge_followups" }>,
): { tasks: TaskEntry[]; taskRefs: string[] } {
  const acknowledged = new Map<string, TaskEntry>();
  for (const followup of operation.followups) {
    const task = ledger.tasks.find((item) => item.ref === followup.ref);
    if (!task) {
      throw new TaskLedgerError(
        "task_not_found",
        `Cannot acknowledge unknown task: ${followup.ref}`,
      );
    }
    if (
      task.revision !== followup.expectedRevision ||
      task.status === "completed" ||
      task.status === "cancelled" ||
      (task.lastFollowup?.revision === task.revision &&
        task.lastFollowup.on >= operation.todayLocal)
    ) {
      continue;
    }
    acknowledged.set(task.ref, {
      ...task,
      lastFollowup: {
        revision: task.revision,
        on: operation.todayLocal,
        reply: {
          sliceId: operation.reply.sliceId,
          turnId: operation.reply.turnId,
        },
      },
    });
  }
  return {
    tasks: ledger.tasks.map((task) => acknowledged.get(task.ref) ?? task),
    taskRefs: [...acknowledged.keys()],
  };
}

function sameResultDefinition(
  result: TaskResult,
  input: Extract<TaskOperation, { type: "record_result" }>["result"],
): boolean {
  return (
    result.taskRef === input.taskRef &&
    result.evidence.producerRunId === input.evidence.producerRunId &&
    result.evidence.statement === input.evidence.statement &&
    result.evidence.sliceId === input.evidence.sliceId &&
    result.evidence.turnId === input.evidence.turnId
  );
}

function applyRecordResult(
  ledger: TaskLedger,
  operation: Extract<TaskOperation, { type: "record_result" }>,
): { results: TaskResult[]; resultIds: string[] } {
  const existing = ledger.results.find((result) => result.id === operation.result.id);
  if (existing) {
    if (!sameResultDefinition(existing, operation.result)) {
      throw new TaskLedgerError(
        "result_exists",
        `Result id ${existing.id} already belongs to a different completion event`,
      );
    }
    return { results: ledger.results, resultIds: [existing.id] };
  }
  if (!ledger.tasks.some((task) => task.ref === operation.result.taskRef)) {
    throw new TaskLedgerError(
      "task_not_found",
      `Cannot record a result for unknown task: ${operation.result.taskRef}`,
    );
  }
  const candidate = {
    id: operation.result.id,
    taskRef: operation.result.taskRef,
    revision: 1,
    evidence: operation.result.evidence,
    createdAt: operation.now,
    updatedAt: operation.now,
    delivery: { state: "pending" },
  };
  const parsed = taskResultSchema.safeParse(candidate);
  if (!parsed.success) invalidOperation(schemaMessage(parsed.error));
  return {
    results: [...ledger.results, parsed.data],
    resultIds: [parsed.data.id],
  };
}

function applyDeliverResult(
  ledger: TaskLedger,
  operation: Extract<TaskOperation, { type: "deliver_result" }>,
): { results: TaskResult[]; resultIds: string[] } {
  const current = ledger.results.find((result) => result.id === operation.resultId);
  if (!current) {
    throw new TaskLedgerError(
      "result_not_found",
      `Task result not found: ${operation.resultId}`,
    );
  }
  if (current.revision !== operation.expectedRevision) {
    throw new TaskLedgerError(
      "stale_revision",
      `Result ${current.id} is at revision ${current.revision}, not ${operation.expectedRevision}`,
    );
  }
  if (current.delivery.state === "delivered") {
    throw new TaskLedgerError(
      "result_already_delivered",
      `Task result ${current.id} is already delivered`,
    );
  }
  const next: TaskResult = {
    ...current,
    revision: current.revision + 1,
    updatedAt: operation.now,
    delivery: {
      state: "delivered",
      at: operation.now,
      reply: {
        sliceId: operation.reply.sliceId,
        turnId: operation.reply.turnId,
      },
    },
  };
  return {
    results: ledger.results.map((result) =>
      result.id === current.id ? next : result
    ),
    resultIds: [current.id],
  };
}

function applyLegacyReconciliation(
  ledger: TaskLedger,
  operation: Extract<TaskOperation, { type: "reconcile_legacy" }>,
): { tasks: TaskEntry[]; taskRefs: string[] } {
  const existing = new Set(ledger.tasks.map((task) => task.ref));
  const additions: TaskEntry[] = [];
  for (const ref of uniqueSorted(operation.entries.map((entry) => entry.ref))) {
    if (existing.has(ref)) continue;
    const manifest = operation.entries.find((entry) => entry.ref === ref);
    if (!manifest) continue;
    const candidate = {
      ref,
      summary: manifest.summary ?? "Unreviewed legacy task; lifecycle status is unknown.",
      status: "needs_review",
      revision: 1,
      nextAction: "Review the task document and raw records, then set the lifecycle explicitly.",
      evidence: [],
      updatedAt: operation.now,
    };
    const parsed = taskEntrySchema.safeParse(candidate);
    if (!parsed.success) invalidOperation(schemaMessage(parsed.error));
    additions.push(parsed.data);
    existing.add(ref);
  }
  return {
    tasks: [...ledger.tasks, ...additions],
    taskRefs: additions.map((task) => task.ref),
  };
}

export function applyTaskOperation(
  current: TaskLedger,
  operationInput: TaskOperation,
): TaskApplication {
  const parsed = taskOperationSchema.safeParse(operationInput);
  if (!parsed.success) {
    invalidOperation(`Invalid task operation: ${schemaMessage(parsed.error)}`);
  }
  const operation = parsed.data;
  const prior = current.operations.find(
    (receipt) => receipt.operationId === operation.operationId,
  );
  if (prior) {
    return {
      outcome: "deduped",
      ledger: current,
      taskRefs: [...prior.taskRefs],
      resultIds: [...prior.resultIds],
    };
  }

  let tasks = current.tasks;
  let results = current.results;
  let taskRefs: string[] = [];
  let resultIds: string[] = [];
  switch (operation.type) {
    case "create":
      ({ tasks, taskRefs } = applyCreate(current, operation));
      break;
    case "update":
      ({ tasks, taskRefs } = applyUpdate(current, operation));
      break;
    case "acknowledge_followups":
      ({ tasks, taskRefs } = applyAcknowledgments(current, operation));
      break;
    case "record_result":
      ({ results, resultIds } = applyRecordResult(current, operation));
      break;
    case "deliver_result":
      ({ results, resultIds } = applyDeliverResult(current, operation));
      break;
    case "reconcile_legacy":
      ({ tasks, taskRefs } = applyLegacyReconciliation(current, operation));
      break;
  }

  const next: TaskLedger = {
    version: TASK_LEDGER_VERSION,
    tasks,
    results,
    operations: [
      ...current.operations,
      {
        operationId: operation.operationId,
        kind: operation.type,
        appliedAt: operation.now,
        taskRefs: uniqueSorted(taskRefs),
        resultIds: uniqueSorted(resultIds),
      },
    ],
  };
  assertLedgerInvariants(next);
  return {
    outcome: "applied",
    ledger: next,
    taskRefs: uniqueSorted(taskRefs),
    resultIds: uniqueSorted(resultIds),
  };
}

export function mutationResult(
  application: TaskApplication,
  details: Pick<TaskMutationResult, "commitSha" | "queued" | "attempts">,
): TaskMutationResult {
  return { ...application, ...details };
}
