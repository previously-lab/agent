import type { SessionState } from "@/lib/session/manager";
import type { TaskState } from "@/lib/loop/engine";

/**
 * Fire-and-forget archive: push session/task data to GitHub
 * without blocking the user response.
 */
export async function archiveSession(
  sessionId: string,
  session: SessionState,
  writeFn: (path: string, content: string) => Promise<unknown>
): Promise<void> {
  const payload = {
    session_id: sessionId,
    start_time: session.startTime,
    end_time: new Date().toISOString(),
    intent: session.currentIntent,
    summary: session.accumulatedSummary,
    key_turns: session.recentTurns.map((t) => ({
      role: t.role,
      snippet: t.content.slice(0, 200),
    })),
    linked_memories: session.linkedMemories,
  };

  await withRetry(() =>
    writeFn(
      `sessions/${sessionId}.json`,
      JSON.stringify(payload, null, 2)
    )
  );
}

/**
 * Archive task loop records to GitHub.
 */
export async function archiveTask(
  taskId: string,
  state: TaskState,
  writeFn: (path: string, content: string) => Promise<unknown>
): Promise<void> {
  await withRetry(() =>
    writeFn(
      `tasks/${taskId}.loop/summary.json`,
      JSON.stringify(
        {
          task_id: taskId,
          goal: state.goal,
          final_status: state.status,
          iterations: state.iterations,
          steps: state.steps,
        },
        null,
        2
      )
    )
  );
}

/**
 * Retry a function up to 3 times with exponential backoff.
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3
): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
      if (attempt < maxRetries - 1) {
        const delay = Math.pow(2, attempt) * 1000; // 1s, 2s, 4s
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError ?? new Error("Archive failed after retries");
}
