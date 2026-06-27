import { describe, it, expect } from "vitest";
import { createTask, serializeTask, checkpoint, detectNoProgress, canResume } from "@/lib/loop/engine";

describe("Loop Engine", () => {
  it("creates a task with initial state", () => {
    const task = createTask("Fix login bug");
    expect(task.status).toBe("researching");
    expect(task.goal).toBe("Fix login bug");
    expect(task.iterations).toBe(0);
    expect(task.maxIterations).toBe(10);
    expect(task.steps).toHaveLength(0);
  });

  it("serializes task to Markdown with YAML frontmatter", () => {
    const task = createTask("Test task");
    checkpoint(task, "Read file", "Found issue");

    const md = serializeTask(task);
    expect(md).toContain("status: ");
    expect(md).toContain("Test task");
    expect(md).toContain("Step 1");
    expect(md).toContain("Found issue");
  });

  it("checkpoint increments iterations", () => {
    const task = createTask("Test");
    const { shouldContinue, state } = checkpoint(task, "Step 1", "Result 1");
    expect(state.iterations).toBe(1);
    expect(shouldContinue).toBe(true);
  });

  it("terminates when max iterations reached", () => {
    const task = createTask("Test", 3);
    checkpoint(task, "1", "r1");
    checkpoint(task, "2", "r2");
    const { shouldContinue, state } = checkpoint(task, "3", "r3");
    expect(shouldContinue).toBe(false);
    expect(state.status).toBe("timeout");
  });

  it("detects no-progress when last 3 results are identical", () => {
    const task = createTask("Test");
    checkpoint(task, "a", "same");
    checkpoint(task, "b", "same");
    checkpoint(task, "c", "same");
    expect(detectNoProgress(task)).toBe(true);
  });

  it("no-progress false when results differ", () => {
    const task = createTask("Test");
    checkpoint(task, "a", "result-a");
    checkpoint(task, "b", "result-b");
    checkpoint(task, "c", "result-c");
    expect(detectNoProgress(task)).toBe(false);
  });

  it("canResume for running task", () => {
    const task = createTask("Test");
    expect(canResume(task)).toBe(true);
  });

  it("cannot resume done/stuck/timeout tasks", () => {
    const task = createTask("Test");
    task.status = "done";
    expect(canResume(task)).toBe(false);

    task.status = "stuck";
    expect(canResume(task)).toBe(false);

    task.status = "timeout";
    expect(canResume(task)).toBe(false);
  });
});
