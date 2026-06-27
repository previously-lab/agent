/**
 * File-Driven Loop Engine
 *
 * Each multi-step task is persisted to tasks/task-{id}.md
 * State flows through the file across HTTP requests.
 *
 * Task file format (YAML frontmatter + Markdown body):
 * ---
 * status: researching | analyzing | implementing | testing | done | stuck | timeout
 * goal: "what we're trying to achieve"
 * current_step: "what we're working on now"
 * iterations: 2
 * max_iterations: 10
 * last_error: ""
 * ---
 *
 * Each step writes a checkpoint to the file.
 * Next request reads the file and continues.
 */

export type TaskStatus =
  | "researching"
  | "analyzing"
  | "implementing"
  | "testing"
  | "done"
  | "stuck"
  | "timeout";

export interface TaskState {
  status: TaskStatus;
  goal: string;
  currentStep: string;
  iterations: number;
  maxIterations: number;
  lastError: string;
  steps: TaskStep[];
}

export interface TaskStep {
  step: number;
  action: string;
  result: string;
  time: string;
}

/**
 * Create a new task state.
 */
export function createTask(
  goal: string,
  maxIterations: number = 10
): TaskState {
  const id = `task-${Date.now()}-${goal.slice(0, 30).replace(/[^a-zA-Z0-9一-鿿]/g, "-")}`;
  return {
    status: "researching",
    goal,
    currentStep: "Initializing",
    iterations: 0,
    maxIterations,
    lastError: "",
    steps: [],
  };
}

/**
 * Serialize task state to a Markdown string with YAML frontmatter.
 */
export function serializeTask(state: TaskState): string {
  const yaml = [
    "---",
    `status: "${state.status}"`,
    `goal: "${state.goal}"`,
    `current_step: "${state.currentStep}"`,
    `iterations: ${state.iterations}`,
    `max_iterations: ${state.maxIterations}`,
    `last_error: "${state.lastError}"`,
    "---",
    "",
    `# Task: ${state.goal}`,
    "",
    `**Status**: ${state.status} | **Step**: ${state.iterations}/${state.maxIterations}`,
    "",
    "## Steps",
    "",
  ];

  for (const step of state.steps) {
    yaml.push(
      `- **Step ${step.step}**: ${step.action}`,
      `  - Result: ${step.result}`,
      `  - Time: ${step.time}`,
      ""
    );
  }

  return yaml.join("\n");
}

/**
 * Checkpoint: add a step and increment iterations.
 * Returns false if the task should terminate.
 */
export function checkpoint(
  state: TaskState,
  action: string,
  result: string
): { shouldContinue: boolean; state: TaskState } {
  state.iterations++;
  state.steps.push({
    step: state.iterations,
    action,
    result,
    time: new Date().toISOString(),
  });
  state.currentStep = action;

  // Check max iterations
  if (state.iterations >= state.maxIterations) {
    state.status = "timeout";
    return { shouldContinue: false, state };
  }

  return { shouldContinue: true, state };
}

/**
 * Check for no-progress: compare last 3 step results.
 */
export function detectNoProgress(state: TaskState): boolean {
  if (state.steps.length < 3) return false;
  const last3 = state.steps.slice(-3).map((s) => s.result);
  // All three have identical results → stuck
  return last3.every((r) => r === last3[0]);
}

/**
 * Determine if a task can be resumed (status is not terminal).
 */
export function canResume(state: TaskState): boolean {
  return !["done", "stuck", "timeout"].includes(state.status);
}
