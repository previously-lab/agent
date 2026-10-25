import { tool } from "@/lib/deepseek/tools";
import { parseTurns } from "@/lib/episodic/turn-parser";
import { fsReadFile, type WriteBatch } from "@/lib/episodic/io-helpers";
import { applyCaseWriteIntent } from "@/lib/episodic/flash/librarian";
import { enumerateTreePaths } from "@/lib/episodic/timeline/enumerate";
import { readTaskLedger, type BatchTaskMutation } from "@/lib/tasks/store";
import {
  createTaskToolSchema, updateTaskToolSchema, queryTasksToolSchema,
  taskEvidenceSchema, isValidTaskRef, taskDocumentPath, parseTaskRef,
  TASK_LEDGER_PATH, type TaskEvidence,
} from "@/lib/tasks/contracts";
import { queryTasks } from "@/lib/tasks/ledger";
import { listPendingTaskResults } from "@/lib/tasks/selector";
import { stableTaskOperationId } from "@/lib/chat/task-identity";

const MAX_LEGACY_RECONCILE = 100;

function evidenceError(rawRecords: Map<string, string>, evidence: TaskEvidence): string | null {
  const raw = rawRecords.get(evidence.sliceId);
  if (raw === undefined) return `readRound ${evidence.sliceId} before using its user evidence`;
  const turn = parseTurns(raw).turns.find((item) => item.turnId === evidence.turnId && /\(user\)/.test(item.header));
  if (!turn || !evidence.statement.trim() || !turn.content.includes(evidence.statement)) {
    return "task evidence must quote the identified RAW USER turn; agent prose and summaries do not authorize lifecycle changes";
  }
  return null;
}

function missing(error: unknown): boolean {
  if (error && typeof error === "object" &&
      (("status" in error && error.status === 404) || ("code" in error && error.code === "ENOENT"))) return true;
  return error instanceof Error && (/^File not found:/.test(error.message) || /\bENOENT\b/.test(error.message));
}

export function buildReflectionTaskTools(input: {
  date: string;
  batch: WriteBatch;
  rawRecords: Map<string, string>;
  mutateTask: BatchTaskMutation;
}) {
  const { date, batch, rawRecords, mutateTask } = input;
  let pending = Promise.resolve();
  function serial(work: () => Promise<string>): Promise<string> {
    const result = pending.then(work).catch((error: unknown) => `REJECTED: ${error instanceof Error ? error.message : String(error)}`);
    pending = result.then(() => {});
    return result;
  }
  async function withTaskDocument(ref: string, evidence: TaskEvidence, summary: string | undefined, mutate: () => Promise<unknown>): Promise<string> {
    const path = taskDocumentPath(ref);
    const tracked = [TASK_LEDGER_PATH, path];
    const before = new Map(tracked.map((key) => [key, { has: batch.entries.has(key), value: batch.entries.get(key) }]));
    try {
      const result = await mutate();
      try { await fsReadFile(path, batch, { fresh: true }); }
      catch (error) {
        if (!missing(error)) throw error;
        await applyCaseWriteIntent({
          action: "open", category: "tasks", caseName: parseTaskRef(ref)!,
          body: `${summary ?? parseTaskRef(ref)}\n\n> ${evidence.statement.replace(/\n/g, "\n> ")}\n\n${date} · records/${evidence.sliceId} · ${evidence.turnId}`,
        }, date, batch);
      }
      return JSON.stringify(result);
    } catch (error) {
      for (const [key, original] of before) {
        if (original.has) batch.entries.set(key, original.value!); else batch.entries.delete(key);
      }
      throw error;
    }
  }
  return {
    queryTasks: tool({
      description: "Query the authoritative task ledger with current refs/revisions and pending results. Bounded discovery of old task documents registers only unknown refs as needs_review, never as open or completed. Reuse existing refs rather than creating another task for the same action.",
      inputSchema: queryTasksToolSchema,
      execute: (query) => serial(async () => {
        let read = await readTaskLedger({ batch, fresh: true });
        if (read.status === "corrupt" || read.status === "unavailable") return JSON.stringify(read);
        let legacyDiagnostic: string | undefined;
        try {
          const paths = new Set(await enumerateTreePaths("memory/tasks"));
          for (const [path, content] of batch.entries) if (content !== null && path.startsWith("memory/tasks/")) paths.add(path);
          const known = new Set(read.status === "ready" ? read.ledger.tasks.map((task) => task.ref) : []);
          const unknown = [...paths].filter((path) => path.endsWith("/index.md"))
            .map((path) => path.replace(/^memory\//, "").replace(/\/index\.md$/, ""))
            .filter((ref) => isValidTaskRef(ref) && !known.has(ref)).sort();
          const refs = [...new Set(unknown)].slice(0, MAX_LEGACY_RECONCILE);
          if (refs.length > 0) {
            await mutateTask({
              type: "reconcile_legacy", operationId: stableTaskOperationId("hq:legacy-tasks", refs),
              now: new Date().toISOString(), entries: refs.map((ref) => ({ ref })),
            });
            read = await readTaskLedger({ batch, fresh: true });
          }
          if (unknown.length > refs.length) legacyDiagnostic = `${unknown.length - refs.length} additional legacy refs remain for a later bounded query`;
        } catch (error) { legacyDiagnostic = `legacy discovery degraded: ${error instanceof Error ? error.message : String(error)}`; }
        if (read.status !== "ready") return JSON.stringify({ ...read, legacyDiagnostic });
        const page = queryTasks(read.ledger, { ...query, limit: Math.min(query.limit ?? 20, 50) });
        return JSON.stringify({ status: "ready", ...page, pendingResults: listPendingTaskResults(read.ledger, { limit: 20 }), legacyDiagnostic });
      }),
    }),
    createTask: tool({
      description: "Create a user commitment, never an agent suggestion. userEvidence must quote a RAW USER turn already returned by readRound. The stable task ref, document and ledger queue in the same round commit; query existing refs first.",
      inputSchema: createTaskToolSchema.extend({ userEvidence: taskEvidenceSchema }).strict(),
      execute: ({ userEvidence, ...task }) => serial(async () => {
        const error = evidenceError(rawRecords, userEvidence);
        if (error) return `REJECTED: ${error}`;
        return withTaskDocument(task.ref, userEvidence, task.summary, () => mutateTask({
          type: "create", operationId: stableTaskOperationId("hq:create-task", [task.ref, JSON.stringify(userEvidence)]),
          now: new Date().toISOString(), task, userCommitment: userEvidence,
        }));
      }),
    }),
    updateTask: tool({
      description: "Apply explicit user feedback from a RAW USER turn already read with readRound. Use the fresh ledger revision; never infer completed/cancelled from historical research prose. A terminal-state correction needs reopen:true and new direct user evidence.",
      inputSchema: updateTaskToolSchema.extend({ userEvidence: taskEvidenceSchema }).strict(),
      execute: ({ userEvidence, ...update }) => serial(async () => {
        const error = evidenceError(rawRecords, userEvidence);
        if (error) return `REJECTED: ${error}`;
        return withTaskDocument(update.ref, userEvidence, update.changes.summary, () => mutateTask({
          type: "update", ...update,
          operationId: stableTaskOperationId("hq:update-task", [update.ref, String(update.expectedRevision), JSON.stringify(update.changes), JSON.stringify(userEvidence)]),
          now: new Date().toISOString(), evidence: userEvidence,
        }));
      }),
    }),
  };
}
