import { getRepoConfig } from "@/lib/capabilities";
import { resolveDataSource, type DataSource } from "@/lib/data-source/resolve";
import {
  createBatch,
  flushBatch,
  fsReadFile,
  fsWriteFile,
  type WriteBatch,
} from "@/lib/episodic/io-helpers";
import { withSliceLock } from "@/lib/episodic/slice-mutex";
import { getGitHubReadHead } from "@/lib/github/read-view";
import { isRefConflictError } from "@/lib/tools/batch-write";
import {
  TASK_LEDGER_LOCK_KEY,
  TASK_LEDGER_PATH,
  TaskLedgerError,
  acknowledgeTaskFollowupsInputSchema,
  confirmTaskResultDeliveryInputSchema,
  taskOperationSchema,
  type AcknowledgeTaskFollowupsInput,
  type ConfirmTaskResultDeliveryInput,
  type CreateTaskInput,
  type ReconcileLegacyTasksInput,
  type RecordTaskResultInput,
  type TaskApplication,
  type TaskLedger,
  type TaskLedgerReadResult,
  type TaskMutationResult,
  type TaskOperation,
  type UpdateTaskInput,
} from "./contracts";
import {
  applyTaskOperation,
  emptyTaskLedger,
  mutationResult,
  parseTaskLedger,
  serializeTaskLedger,
} from "./ledger";

export interface ReadTaskLedgerOptions {
  batch?: WriteBatch;
  fresh?: boolean;
}

export interface TaskMutationOptions {
  /** Number of fresh re-read/replay attempts after the first CAS failure. */
  maxHeadRetries?: number;
}

export interface TaskPersistenceSkipped {
  outcome: "skipped";
  reason: "reply_not_persisted";
}

export type BatchTaskMutation = (
  operation: TaskOperation,
) => Promise<TaskMutationResult>;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissingError(error: unknown): boolean {
  if (error && typeof error === "object" && "status" in error) {
    if ((error as { status?: unknown }).status === 404) return true;
  }
  const message = errorMessage(error);
  return /\bENOENT\b/.test(message) || /^File not found:/i.test(message);
}

async function readBasisHead(
  source: DataSource,
  batch: WriteBatch | undefined,
  fresh: boolean,
): Promise<string | null> {
  if (batch?.baseHeadSha) return batch.baseHeadSha;
  if (source !== "github" || !fresh) return null;
  const { owner, repo } = getRepoConfig();
  return (await getGitHubReadHead(repo, owner, { fresh: true })).headSha;
}

async function readLedger(
  options: ReadTaskLedgerOptions,
): Promise<TaskLedgerReadResult> {
  const source = resolveDataSource();
  const fresh = options.fresh === true;
  let basisHeadSha: string | null = options.batch?.baseHeadSha ?? null;
  let raw: string;
  try {
    const pending = options.batch?.entries.has(TASK_LEDGER_PATH) === true;
    basisHeadSha = pending
      ? basisHeadSha
      : await readBasisHead(source, options.batch, fresh);
    raw = await fsReadFile(
      TASK_LEDGER_PATH,
      options.batch,
      fresh ? { fresh: true } : undefined,
    );
  } catch (error) {
    if (isMissingError(error)) {
      return {
        status: "missing",
        basisHeadSha,
      };
    }
    return { status: "unavailable", message: errorMessage(error) };
  }
  try {
    return {
      status: "ready",
      ledger: parseTaskLedger(raw),
      basisHeadSha,
    };
  } catch (error) {
    return { status: "corrupt", message: errorMessage(error) };
  }
}

export function readTaskLedger(
  options: ReadTaskLedgerOptions = {},
): Promise<TaskLedgerReadResult> {
  return readLedger(options);
}

function ledgerForMutation(read: TaskLedgerReadResult): TaskLedger {
  switch (read.status) {
    case "ready":
      return read.ledger;
    case "missing":
      return emptyTaskLedger();
    case "corrupt":
      throw new TaskLedgerError(
        "ledger_corrupt",
        `Refusing to mutate corrupt task ledger: ${read.message}`,
      );
    case "unavailable":
      throw new TaskLedgerError(
        "ledger_unavailable",
        `Refusing to mutate unavailable task ledger: ${read.message}`,
      );
  }
}

async function applyAndQueue(
  operation: TaskOperation,
  batch: WriteBatch,
): Promise<TaskApplication> {
  const parsedOperation = taskOperationSchema.safeParse(operation);
  if (!parsedOperation.success) {
    throw new TaskLedgerError(
      "invalid_operation",
      `Invalid task operation: ${parsedOperation.error.message}`,
    );
  }
  if (resolveDataSource() === "demo") {
    throw new TaskLedgerError(
      "read_only",
      "Task state is read-only in demo mode",
    );
  }
  const read = await readLedger({ batch, fresh: true });
  const basisHeadSha =
    read.status === "ready" || read.status === "missing"
      ? read.basisHeadSha
      : null;
  const current = ledgerForMutation(read);
  const application = applyTaskOperation(current, parsedOperation.data);
  if (application.outcome === "deduped") return application;
  if (batch.baseHeadSha === undefined && basisHeadSha !== null) {
    batch.baseHeadSha = basisHeadSha;
  }
  await fsWriteFile(
    TASK_LEDGER_PATH,
    serializeTaskLedger(application.ledger),
    batch,
  );
  return application;
}

export async function mutateTaskLedger(
  operation: TaskOperation,
  options: TaskMutationOptions = {},
): Promise<TaskMutationResult> {
  const maxHeadRetries = options.maxHeadRetries ?? 2;
  if (
    !Number.isInteger(maxHeadRetries) ||
    maxHeadRetries < 0 ||
    maxHeadRetries > 5
  ) {
    throw new TaskLedgerError(
      "invalid_operation",
      "maxHeadRetries must be an integer from 0 through 5",
    );
  }
  return withSliceLock(TASK_LEDGER_LOCK_KEY, async () => {
    for (let attempt = 1; ; attempt += 1) {
      const batch = createBatch();
      try {
        const application = await applyAndQueue(operation, batch);
        if (application.outcome === "deduped") {
          return mutationResult(application, {
            commitSha: null,
            queued: false,
            attempts: attempt,
          });
        }
        const commitSha = await flushBatch(
          batch,
          `Task ledger — ${operation.operationId}`,
        );
        return mutationResult(application, {
          commitSha,
          queued: false,
          attempts: attempt,
        });
      } catch (error) {
        if (!isRefConflictError(error)) throw error;
        if (attempt > maxHeadRetries) {
          throw new TaskLedgerError(
            "head_conflict",
            `Task ledger HEAD kept moving after ${attempt} attempts: ${errorMessage(error)}`,
          );
        }
      }
    }
  });
}

/**
 * HQ same-round helper. The callback receives a mutation function that reads
 * the ledger once, then reads its own queued state for later operations. The
 * caller flushes its existing batch INSIDE this callback so the local lock
 * covers the write too. This helper never flushes or commits on its own.
 */
export function withTaskLedgerBatch<T>(
  batch: WriteBatch,
  fn: (mutate: BatchTaskMutation) => Promise<T>,
): Promise<T> {
  return withSliceLock(TASK_LEDGER_LOCK_KEY, () =>
    fn(async (operation) => {
      const application = await applyAndQueue(operation, batch);
      return mutationResult(application, {
        commitSha: null,
        queued: application.outcome === "applied",
        attempts: 1,
      });
    }),
  );
}

export function createTask(
  input: CreateTaskInput,
  options?: TaskMutationOptions,
): Promise<TaskMutationResult> {
  return mutateTaskLedger({ ...input, type: "create" }, options);
}

export function updateTaskFromUserFeedback(
  input: UpdateTaskInput,
  options?: TaskMutationOptions,
): Promise<TaskMutationResult> {
  return mutateTaskLedger({ ...input, type: "update" }, options);
}

export function acknowledgeTaskFollowups(
  input: AcknowledgeTaskFollowupsInput,
  options?: TaskMutationOptions,
): Promise<TaskMutationResult | TaskPersistenceSkipped> {
  const parsed = acknowledgeTaskFollowupsInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new TaskLedgerError(
      "invalid_operation",
      `Invalid follow-up acknowledgment: ${parsed.error.message}`,
    );
  }
  if (parsed.data.outcome.status !== "persisted") {
    return Promise.resolve({
      outcome: "skipped",
      reason: "reply_not_persisted",
    });
  }
  const { outcome, ...rest } = parsed.data;
  return mutateTaskLedger(
    { ...rest, reply: outcome, type: "acknowledge_followups" },
    options,
  );
}

export function recordTaskResult(
  input: RecordTaskResultInput,
  options?: TaskMutationOptions,
): Promise<TaskMutationResult> {
  return mutateTaskLedger({ ...input, type: "record_result" }, options);
}

export function confirmTaskResultDelivery(
  input: ConfirmTaskResultDeliveryInput,
  options?: TaskMutationOptions,
): Promise<TaskMutationResult | TaskPersistenceSkipped> {
  const parsed = confirmTaskResultDeliveryInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new TaskLedgerError(
      "invalid_operation",
      `Invalid result delivery confirmation: ${parsed.error.message}`,
    );
  }
  if (parsed.data.outcome.status !== "persisted") {
    return Promise.resolve({
      outcome: "skipped",
      reason: "reply_not_persisted",
    });
  }
  const { outcome, ...rest } = parsed.data;
  return mutateTaskLedger(
    { ...rest, reply: outcome, type: "deliver_result" },
    options,
  );
}

export function reconcileLegacyTasks(
  input: ReconcileLegacyTasksInput,
  options?: TaskMutationOptions,
): Promise<TaskMutationResult> {
  return mutateTaskLedger({ ...input, type: "reconcile_legacy" }, options);
}
