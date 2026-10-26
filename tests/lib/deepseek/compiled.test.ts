import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("native DeepSeek inside compiled Workflow 5", () => {
  it("retries a tool acknowledgement without repeating the completed model request", async () => {
    const { stdout } = await promisify(execFile)(process.execPath,
      [fileURLToPath(new URL("./compiled-runner.mjs", import.meta.url))], { timeout: 45000, maxBuffer: 2 * 1024 * 1024 });
    const line = stdout.split(/\r?\n/).find((value) => value.startsWith("NATIVE_WORKFLOW_RESULT="));
    expect(line).toBeDefined();
    const value = JSON.parse(line!.slice("NATIVE_WORKFLOW_RESULT=".length));
    expect(value.result).toEqual({ text: "completed", steps: 2 });
    expect(value.modelCalls).toBe(2);
    expect(value.unexpectedNetwork).toBe(0);
    expect(value.attempts).toBe(2);
    expect(value.record).toBe("saved");
    expect(value.toolSchemas).toMatchObject([
      { name: "save", parameters: { type: "object", oneOf: [{ type: "object" }, { type: "object" }] } },
      { name: "read", parameters: { type: "object", anyOf: [{ type: "object" }, { type: "object" }] } },
    ]);
    expect(value.secondMessages[1]).toMatchObject({ role: "assistant", reasoning_content: "fixture thought", tool_calls: [{ id: "stable-write" }, { id: "independent-read" }] });
    expect(value.secondMessages.slice(2).map((message: { tool_call_id: string }) => message.tool_call_id)).toEqual(["stable-write", "independent-read"]);
    expect(value.order.indexOf("read")).toBeLessThan(value.order.lastIndexOf("save"));
    expect(value.steps.filter((step: { name: string }) => step.name.endsWith("callModelStep"))).toEqual([
      expect.objectContaining({ attempt: 1, status: "completed" }), expect.objectContaining({ attempt: 1, status: "completed" }),
    ]);
    expect(value.steps).toContainEqual(expect.objectContaining({ name: expect.stringMatching(/save$/), attempt: 2, status: "completed" }));
    expect(value.steps).toContainEqual(expect.objectContaining({ name: expect.stringMatching(/read$/), attempt: 1, status: "completed" }));
  }, 60000);
  it("durably saves an interrupted model response before reporting its failure", async () => {
    const { stdout } = await promisify(execFile)(process.execPath,
      [fileURLToPath(new URL("./compiled-runner.mjs", import.meta.url)), "partial"], { timeout: 45000, maxBuffer: 2 * 1024 * 1024 });
    const line = stdout.split(/\r?\n/).find((value) => value.startsWith("NATIVE_WORKFLOW_RESULT="));
    expect(line).toBeDefined();
    const value = JSON.parse(line!.slice("NATIVE_WORKFLOW_RESULT=".length));
    expect(value.modelCalls).toBe(1);
    expect(value.unexpectedNetwork).toBe(0);
    expect(value.result.errorName).toBe("DeepSeekError");
    expect(value.result.snapshots).toHaveLength(1);
    expect(value.result.snapshots[0]).toMatchObject({ text: "partial durable answer", reasoningText: "partial durable thought", finishReason: "error", toolCalls: [], toolResults: [] });
    expect(value.result.snapshots[0].usage).toMatchObject({ inputTokens: 4, outputTokens: 3, totalTokens: 7 });
    expect(value.result.snapshots[0].response.messages[0].deepseek).toEqual({ role: "assistant", content: "partial durable answer", reasoning_content: "partial durable thought" });
    expect(value.steps.filter((step: { name: string }) => step.name.endsWith("callModelStep"))).toEqual([
      expect.objectContaining({ attempt: 1, status: "completed" }),
    ]);
    expect(value.steps.some((step: { name: string }) => step.name.endsWith("save"))).toBe(false);
  }, 60000);
});
