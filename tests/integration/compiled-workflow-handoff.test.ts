import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("compiled Workflow handoff recovery", () => {
  it("retries a lost child-start acknowledgement without running the completed model step again", async () => {
    // A separate Node process keeps real Workflow compiler globals and local queue
    // resources isolated from Vitest's mocks. No production fixture route.
    const runner = fileURLToPath(new URL("../helpers/run-compiled-workflow.mjs", import.meta.url));
    const { stdout } = await execFileAsync(process.execPath, [runner], {
      cwd: resolve(fileURLToPath(new URL("../..", import.meta.url))),
      timeout: 45_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    const line = stdout.split(/\r?\n/).find(value => value.startsWith("COMPILED_WORKFLOW_RESULT="));
    expect(line).toBeDefined();
    const result = JSON.parse(line!.slice("COMPILED_WORKFLOW_RESULT=".length)) as {
      modelCalls: number;
      childStarts: number;
      uniqueChildren: number;
      summaryAttempts: number;
      records: number;
      recordText: string;
      networkAttempts: number;
      eventTypes: string[];
      steps: Array<{ name: string; attempt: number; status: string }>;
      childSteps: Array<Array<{ name: string; attempt: number; status: string }>>;
    };
    expect(result.modelCalls).toBe(1);
    expect(result.childStarts).toBe(2);
    expect(result.uniqueChildren).toBe(2);
    // Queue delivery is at least once. Additional child-step retries are safe;
    // both independently started children must finish against the one ledger.
    expect(result.summaryAttempts).toBeGreaterThanOrEqual(2);
    expect(result.childSteps).toHaveLength(2);
    for (const child of result.childSteps) expect(child).toContainEqual(
      expect.objectContaining({ name: expect.stringMatching(/persist$/), status: "completed" }),
    );
    expect(result.records).toBe(1);
    expect(result.recordText).toBe("fixture answer");
    expect(result.networkAttempts).toBe(0);
    expect(result.eventTypes).toContain("step_retrying");
    expect(result.eventTypes.at(-1)).toBe("run_completed");
    expect(result.steps.filter(step => step.name.endsWith("callModelStep"))).toEqual([
      expect.objectContaining({ attempt: 1, status: "completed" }),
    ]);
    expect(result.steps).toContainEqual(expect.objectContaining({ name: expect.stringMatching(/handoff$/), attempt: 2, status: "completed" }));
  }, 60_000);
});
