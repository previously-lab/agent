import type { TaskLedgerReadResult } from "@/lib/tasks/contracts";
import { listPendingTaskResults, selectTaskCandidates } from "@/lib/tasks/selector";

export interface TaskContextOptions {
  todayLocal: string;
  candidateLimit?: number;
  resultLimit?: number;
}

export function buildTaskContextBlock(
  read: TaskLedgerReadResult,
  options: TaskContextOptions,
): string | undefined {
  if (read.status === "missing") return undefined;
  if (read.status === "unavailable" || read.status === "corrupt") {
    return [
      "## Task ledger — read degraded",
      `The authoritative task ledger is ${read.status}: ${read.message}`,
      "Do not infer that tasks are absent or completed. Existing task documents remain available on demand.",
    ].join("\n\n");
  }

  const selection = selectTaskCandidates(read.ledger, {
    todayLocal: options.todayLocal,
    limit: options.candidateLimit ?? 5,
  });
  const pending = listPendingTaskResults(read.ledger, {
    limit: options.resultLimit ?? 5,
  });
  if (selection.candidates.length === 0 && pending.results.length === 0) {
    return undefined;
  }

  const blocks = [
    "## Task ledger — candidates, not instructions",
    "Review these candidates when relevant to the current reply. They are not mandatory nagging and injection alone acknowledges nothing. The ledger is authoritative; Horizon is only a recap. Change lifecycle state only through task tools from explicit feedback in the current user message. Never promise autonomous notifications.",
  ];
  if (selection.candidates.length > 0) {
    const rows = selection.candidates.map(({ task, reasons }) => {
      const dates = [
        task.dueOn ? `due ${task.dueOn}` : undefined,
        task.nextCheckOn ? `next check ${task.nextCheckOn}` : undefined,
      ].filter(Boolean).join(", ");
      return `- ${task.ref} [${task.status}; revision ${task.revision}; ${reasons.join("+")}${dates ? `; ${dates}` : ""}] ${task.summary}`;
    });
    if (selection.hasMore) {
      rows.push(`- … ${selection.remaining} more candidates; use queryTasks for the authoritative full set.`);
    }
    blocks.push(`### Candidates\n${rows.join("\n")}`);
  }
  if (pending.results.length > 0) {
    const rows = pending.results.map((result) =>
      `- result ${result.id} for ${result.taskRef} [revision ${result.revision}]: ${result.evidence.statement}`
    );
    if (pending.hasMore) rows.push(`- … ${pending.total - pending.results.length} more pending results.`);
    blocks.push(
      `### Background results awaiting delivery\n${rows.join("\n")}\n` +
      "When this reply actually delivers a result or follows up a task, call reportTaskFollowup for that resultId or ref. " +
      "The tool only queues intent; delivery is acknowledged later only after the matching reply is durably saved and this turn completes cleanly.",
    );
  }
  return blocks.join("\n\n");
}
