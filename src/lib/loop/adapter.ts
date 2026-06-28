/**
 * Loop Adapter — wires ToolLoopAgent into Chat API with file checkpointing.
 *
 * When intent strategy.loop_mode is true, uses multi-step agent execution
 * with state persisted to tasks/task-{id}.md after each step.
 */
import { createTask, checkpoint, serializeTask, detectNoProgress, canResume } from "./engine";

export { createTask, checkpoint, serializeTask, detectNoProgress, canResume };

/**
 * Generate a task ID from the goal string.
 */
export function generateTaskId(goal: string): string {
  const slug = goal
    .slice(0, 40)
    .replace(/[^a-zA-Z0-9一-鿿]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
  return `task-${Date.now()}-${slug}`;
}

/**
 * Build the loop system prompt addition that instructs the agent
 * about file-driven task execution.
 */
export function buildLoopPrompt(taskId: string, goal: string): string {
  return `
You are working on a multi-step task. Your progress is tracked in \`tasks/${taskId}.md\`.

Task: ${goal}

Instructions:
- Break the task into logical steps and execute them one at a time
- After each step, the system automatically saves your progress
- If interrupted, you will resume from the last saved step
- Mark the task as complete when all objectives are met
- Report blockers clearly if you get stuck
`;
}
