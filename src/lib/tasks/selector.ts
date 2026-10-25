import {
  TaskLedgerError,
  calendarDateSchema,
  isValidTaskRef,
  type TaskEntry,
  type TaskLedger,
  type TaskResult,
} from "./contracts";

export type TaskCandidateReason =
  | "overdue"
  | "due"
  | "check_due"
  | "due_soon"
  | "relevance"
  | "review";

export interface TaskCandidate {
  task: TaskEntry;
  reasons: TaskCandidateReason[];
}

export interface TaskSelection {
  candidates: TaskCandidate[];
  totalCandidates: number;
  hasMore: boolean;
  remaining: number;
}

export interface SelectTaskCandidatesInput {
  todayLocal: string;
  limit: number;
  relevance?: string;
}

function byText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function reasonRank(reasons: TaskCandidateReason[]): number {
  if (reasons.includes("overdue")) return 0;
  if (reasons.includes("due")) return 1;
  if (reasons.includes("check_due")) return 2;
  if (reasons.includes("due_soon")) return 3;
  if (reasons.includes("relevance")) return 4;
  return 5;
}

function matches(task: TaskEntry, relevance: string | undefined): boolean {
  if (!relevance) return false;
  const needle = relevance.toLocaleLowerCase();
  return [task.ref, task.summary, task.nextAction, task.waitingCondition]
    .filter((value): value is string => value !== undefined)
    .some((value) => value.toLocaleLowerCase().includes(needle));
}

function followedAtCurrentRevisionToday(
  task: TaskEntry,
  todayLocal: string,
): boolean {
  return (
    task.lastFollowup?.revision === task.revision &&
    task.lastFollowup.on === todayLocal
  );
}

function compareCandidates(a: TaskCandidate, b: TaskCandidate): number {
  const rank = reasonRank(a.reasons) - reasonRank(b.reasons);
  if (rank !== 0) return rank;
  if (a.reasons.includes("review") && b.reasons.includes("review")) {
    const aFollowup =
      a.task.lastFollowup?.revision === a.task.revision
        ? a.task.lastFollowup.on
        : "";
    const bFollowup =
      b.task.lastFollowup?.revision === b.task.revision
        ? b.task.lastFollowup.on
        : "";
    const followup = byText(aFollowup, bFollowup);
    if (followup !== 0) return followup;
  }
  const aDate = a.task.dueOn ?? a.task.nextCheckOn ?? "";
  const bDate = b.task.dueOn ?? b.task.nextCheckOn ?? "";
  return byText(aDate, bDate) || byText(a.task.ref, b.task.ref);
}

export function selectTaskCandidates(
  ledger: TaskLedger,
  input: SelectTaskCandidatesInput,
): TaskSelection {
  if (!calendarDateSchema.safeParse(input.todayLocal).success) {
    throw new TaskLedgerError(
      "invalid_operation",
      "todayLocal must be a real YYYY-MM-DD calendar date",
    );
  }
  if (!Number.isInteger(input.limit) || input.limit < 0) {
    throw new TaskLedgerError(
      "invalid_operation",
      "Task selection limit must be a non-negative integer",
    );
  }
  const tomorrow = new Date(`${input.todayLocal}T00:00:00.000Z`);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const tomorrowLocal = tomorrow.toISOString().slice(0, 10);
  const relevance = input.relevance?.trim() || undefined;
  const eligible: TaskCandidate[] = [];

  for (const task of ledger.tasks) {
    if (
      task.status === "completed" ||
      task.status === "cancelled" ||
      task.status === "needs_review" ||
      followedAtCurrentRevisionToday(task, input.todayLocal)
    ) {
      continue;
    }

    const reasons: TaskCandidateReason[] = [];
    if (task.dueOn) {
      if (task.dueOn < input.todayLocal) reasons.push("overdue");
      else if (task.dueOn === input.todayLocal) reasons.push("due");
      else if (task.dueOn === tomorrowLocal && task.status === "open") {
        reasons.push("due_soon");
      }
    }
    if (task.nextCheckOn && task.nextCheckOn <= input.todayLocal) {
      reasons.push("check_due");
    }
    const relevant = matches(task, relevance);

    if (task.status === "paused") {
      if (!reasons.includes("check_due")) continue;
      eligible.push({ task, reasons: ["check_due"] });
      continue;
    }

    if (task.status === "waiting") {
      if (relevant) reasons.push("relevance");
      if (reasons.length > 0) eligible.push({ task, reasons });
      continue;
    }

    if (relevant) reasons.push("relevance");
    if (!task.dueOn && !task.nextCheckOn) reasons.push("review");
    if (reasons.length > 0) eligible.push({ task, reasons });
  }

  eligible.sort(compareCandidates);
  const candidates = eligible.slice(0, input.limit);
  return {
    candidates,
    totalCandidates: eligible.length,
    hasMore: eligible.length > candidates.length,
    remaining: eligible.length - candidates.length,
  };
}

export interface PendingTaskResultPage {
  results: TaskResult[];
  total: number;
  hasMore: boolean;
}

export interface PendingTaskResultQuery {
  taskRef?: string;
  limit?: number;
}

export function listPendingTaskResults(
  ledger: TaskLedger,
  query: PendingTaskResultQuery = {},
): PendingTaskResultPage {
  if (query.taskRef !== undefined && !isValidTaskRef(query.taskRef)) {
    throw new TaskLedgerError("invalid_operation", "Invalid task ref");
  }
  if (
    query.limit !== undefined &&
    (!Number.isInteger(query.limit) || query.limit <= 0)
  ) {
    throw new TaskLedgerError(
      "invalid_operation",
      "Pending result limit must be a positive integer",
    );
  }
  const pending = ledger.results
    .filter((result) => result.delivery.state === "pending")
    .filter((result) => !query.taskRef || result.taskRef === query.taskRef)
    .sort(
      (a, b) =>
        byText(a.createdAt, b.createdAt) || byText(a.id, b.id),
    );
  const results = pending.slice(0, query.limit);
  return {
    results,
    total: pending.length,
    hasMore: results.length < pending.length,
  };
}
