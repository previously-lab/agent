import { createBatch, flushBatch, fsReadFile, fsWriteFile } from "@/lib/episodic/io-helpers";
import { withSliceLock } from "@/lib/episodic/slice-mutex";
import { parseSliceId } from "@/lib/episodic/turn-parser";
import { createCase, serializeCaseDoc } from "@/lib/docs/case-doc";
import { isValidDate } from "@/lib/docs/naming";
import { isRefConflictError } from "@/lib/tools/batch-write";
import {
  createTaskInputSchema, parseTaskRef, taskDocumentPath, TASK_LEDGER_PATH,
  TaskLedgerError, type CreateTaskInput, type TaskMutationResult,
} from "./contracts";
import { withTaskLedgerBatch } from "./store";

function isMissing(error: unknown): boolean {
  if (error && typeof error === "object" && "status" in error && error.status === 404) return true;
  if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return true;
  const message = error instanceof Error ? error.message : String(error);
  return /^(File not found|Directory not found):/.test(message) || /\bENOENT\b/.test(message);
}

/** Input evidence must originate in server-owned user text, never model-supplied claims. */
export async function registerTaskWithDocument(input: CreateTaskInput, body?: string): Promise<TaskMutationResult> {
  const parsed = createTaskInputSchema.safeParse(input);
  if (!parsed.success) throw new TaskLedgerError("invalid_operation", parsed.error.message);
  const value = parsed.data;
  const source = parseSliceId(value.userCommitment.sliceId);
  if (!source || !isValidDate(`${source.y}-${source.m}-${source.d}`) ||
      Number(source.hm.slice(0, 2)) > 23 || Number(source.hm.slice(2)) > 59) {
    throw new TaskLedgerError("invalid_operation", "Task registration needs the canonical raw-record slice id of the actual user statement");
  }
  if (body !== undefined && !body.trim()) throw new TaskLedgerError("invalid_operation", "Task document body must not be blank");
  const documentPath = taskDocumentPath(value.task.ref);
  const caseName = parseTaskRef(value.task.ref)!;

  for (let attempt = 1; ; attempt += 1) {
    const batch = createBatch();
    try {
      return await withTaskLedgerBatch(batch, (mutate) => withSliceLock(`doc:tasks/${caseName}`, async () => {
        const result = await mutate({ ...value, type: "create" });
        const task = result.ledger.tasks.find((entry) => entry.ref === value.task.ref);
        if (!task || !result.taskRefs.includes(value.task.ref)) {
          throw new TaskLedgerError("invalid_operation", "This operation id belongs to another task; registration was not applied");
        }
        let exists = true;
        try {
          await fsReadFile(documentPath, batch, { fresh: true });
        } catch (error) {
          if (!isMissing(error)) throw error;
          exists = false;
        }
        if (!exists) {
          const evidence = task.evidence[0];
          if (!evidence) throw new TaskLedgerError("invalid_operation", "A task document requires a direct user commitment");
          const defaultBody = `${task.summary}\n\n` +
            evidence.statement.split(/\r?\n/).map((line) => `> ${line}`).join("\n") +
            `\n\n(records/${evidence.sliceId} · ${evidence.turnId})`;
          const doc = createCase({ category: "tasks", caseName, opened: value.now.slice(0, 10), body: body?.trim() ?? defaultBody });
          // GitHub commits both atomically. Local sequential flushing writes the
          // new document first, so a failed document write cannot orphan ledger state.
          const ledger = batch.entries.get(TASK_LEDGER_PATH);
          batch.entries.delete(TASK_LEDGER_PATH);
          await fsWriteFile(documentPath, serializeCaseDoc({ ...doc, updated: value.now, bodyUpdated: value.now }), batch);
          if (ledger !== undefined) batch.entries.set(TASK_LEDGER_PATH, ledger);
        }
        const commitSha = batch.entries.size > 0
          ? await flushBatch(batch, `Task registration — ${value.operationId}`)
          : null;
        return { ...result, commitSha, queued: false, attempts: attempt };
      }));
    } catch (error) {
      if (!isRefConflictError(error)) throw error;
      if (attempt >= 3) throw new TaskLedgerError("head_conflict", "Task registration HEAD kept moving after 3 fresh attempts");
    }
  }
}
