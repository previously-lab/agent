import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { AgentOptions, ModelCallStreamPart } from "@/lib/deepseek/types";
import type { RunSubAgentOptions } from "@/lib/agents/sub-agent-runner";

const native = vi.hoisted(() => ({ streamText: vi.fn() }));
vi.mock("@/lib/deepseek/generate", () => ({ streamText: native.streamText }));
const evolution = vi.hoisted(() => ({ readSelfSop: vi.fn(async (): Promise<string | null> => null) }));
vi.mock("@/lib/evolution/store", () => evolution);
const workflow = vi.hoisted(() => {
  const writer = { write: vi.fn(async () => {}), releaseLock: vi.fn() };
  return { writer, getWritable: vi.fn(() => ({ getWriter: () => writer })) };
});
vi.mock("workflow", () => ({ getWritable: workflow.getWritable }));
const deadline = vi.hoisted(() => ({ withStepTimeout: vi.fn(async (work: () => Promise<unknown>) => ({ ok: true, result: await work(), elapsedMs: 0 })) }));
vi.mock("@/lib/chat/step-timeout", () => deadline);

import { createProgressEmitter, extractToolReport, resolveSubAgentModel, runSubAgent } from "@/lib/agents/sub-agent-runner";
import { FIXED_MODEL } from "@/lib/models/registry";
const reportSchema = z.object({ verdict: z.string(), count: z.number() });
type Report = z.infer<typeof reportSchema>;
const options = (overrides: Partial<RunSubAgentOptions<Report>> = {}): RunSubAgentOptions<Report> => ({
  system: "fixed system", prompt: "fixture task", tools: {}, reportToolName: "report", reportSchema, ...overrides,
});
function fakeStream(spec: { chunks?: ModelCallStreamPart[]; text?: string; reasoning?: string; calls?: Array<{ toolName: string; input: unknown }>; sources?: Array<{ sourceType: string; url?: string; title?: string }> } = {}) {
  native.streamText.mockImplementation(async (opts: AgentOptions) => {
    for (const chunk of spec.chunks ?? []) await opts.onChunk?.({ chunk });
    const joined = (type: string) => (spec.chunks ?? []).filter((chunk) => chunk.type === type).map((chunk) => chunk.text ?? chunk.delta ?? "").join("");
    return { text: Promise.resolve(spec.text ?? joined("text-delta")), reasoningText: Promise.resolve(spec.reasoning ?? joined("reasoning-delta")),
      toolCalls: Promise.resolve(spec.calls ?? []), sources: Promise.resolve(spec.sources ?? []), warnings: Promise.resolve([]) };
  });
}
const lastCall = () => native.streamText.mock.calls.at(-1)![0] as AgentOptions;
beforeEach(() => { vi.clearAllMocks(); evolution.readSelfSop.mockResolvedValue(null); });

describe("native sub-agent runner", () => {
  it("validates the named structured report", async () => {
    fakeStream({ calls: [{ toolName: "other", input: {} }, { toolName: "report", input: { verdict: "yes", count: 3 } }] });
    expect(await runSubAgent(options())).toMatchObject({ ok: true, report: { verdict: "yes", count: 3 } });
  });
  it("returns missing reports honestly without a second model request", async () => {
    fakeStream({ text: "unfiled prose", reasoning: "thinking retained" });
    expect(await runSubAgent(options())).toMatchObject({ ok: true, text: "unfiled prose", reasoning: "thinking retained", report: undefined });
    expect(native.streamText).toHaveBeenCalledTimes(1);
  });
  it("rejects malformed reports without discarding text", async () => {
    fakeStream({ text: "usable partial result", calls: [{ toolName: "report", input: { verdict: 42 } }] });
    expect(await runSubAgent(options())).toMatchObject({ ok: true, text: "usable partial result", report: undefined });
  });
  it("uses the fixed model and passes only server-owned role settings", async () => {
    expect(await resolveSubAgentModel()).toEqual(FIXED_MODEL);
    fakeStream(); await runSubAgent(options());
    expect(lastCall()).toMatchObject({ role: "recall", thinking: true, toolChoice: "auto" });
    expect(lastCall()).not.toHaveProperty("providerOptions");
    expect(lastCall()).not.toHaveProperty("maxOutputTokens");
    expect(lastCall()).not.toHaveProperty("temperature");
    await runSubAgent(options({ role: "reflection" }));
    expect(lastCall().role).toBe("reflection");
  });
  it("keeps exact source citations returned by the native tool run", async () => {
    const sources = [{ sourceType: "url", url: "https://example.test", title: "fixture" }];
    fakeStream({ sources }); expect((await runSubAgent(options())).sources).toEqual(sources);
  });
  it("keeps complete accumulated thinking and text on timeout", async () => {
    native.streamText.mockImplementation(async (opts: AgentOptions) => {
      await opts.onChunk?.({ chunk: { type: "reasoning-delta", text: "half a thought" } });
      await opts.onChunk?.({ chunk: { type: "text-delta", delta: "partial answer" } });
      throw new DOMException("fixture timeout", "TimeoutError");
    });
    expect(await runSubAgent(options({ timeoutMs: 5000 }))).toMatchObject({ ok: false, timedOut: true, text: "partial answer", reasoning: "half a thought", error: "Sub-agent did not finish within 5s." });
    expect(native.streamText).toHaveBeenCalledTimes(1);
  });
  it("returns provider failures as structured failures", async () => {
    native.streamText.mockRejectedValue(new Error("provider unavailable"));
    expect(await runSubAgent(options())).toMatchObject({ ok: false, text: "", error: "provider unavailable" });
  });
  it("installs both deadline and backstop only for an explicit wall-clock bound", async () => {
    fakeStream(); await runSubAgent(options({ timeoutMs: 12000 }));
    expect(lastCall().timeout).toBe(12000);
    expect(deadline.withStepTimeout).toHaveBeenCalledWith(expect.any(Function), 15000);
  });
  it("does not invent a timeout when the caller omitted one", async () => {
    fakeStream(); await runSubAgent(options());
    expect(lastCall()).not.toHaveProperty("timeout"); expect(deadline.withStepTimeout).not.toHaveBeenCalled();
  });
  it("applies the requested round limit", async () => {
    fakeStream(); await runSubAgent(options({ maxSteps: 4 }));
    const stop = lastCall().stopWhen;
    expect(typeof stop).toBe("function");
    if (typeof stop !== "function") throw new Error("expected stop condition");
    expect(stop({ steps: new Array(4).fill({}) })).toBe(true);
    expect(stop({ steps: new Array(3).fill({}) })).toBe(false);
  });
  it("leaves unspecified limits to the native call contract", async () => {
    fakeStream(); await runSubAgent(options()); expect(lastCall()).not.toHaveProperty("stopWhen");
  });
  it("loads the complete SOP without truncating it", async () => {
    const sop = `# SOP\n${"guidance\n".repeat(300)}`;
    evolution.readSelfSop.mockResolvedValueOnce(sop);
    fakeStream(); await runSubAgent(options({ selfSop: "search" }));
    expect(lastCall().system).toContain(sop.trim()); expect(lastCall().system?.startsWith("fixed system")).toBe(true);
  });
  it("degrades a missing or unreadable SOP without failing the run", async () => {
    fakeStream(); await runSubAgent(options({ selfSop: "search" }));
    expect(lastCall().system).toMatch(/^fixed system\n\nFinish by calling report/);
    expect(lastCall().system).not.toContain("Your SOP");
    evolution.readSelfSop.mockRejectedValueOnce(new Error("fixture unavailable"));
    await runSubAgent(options({ selfSop: "search" }));
    expect(lastCall().system).toMatch(/^fixed system\n\nFinish by calling report/);
    expect(lastCall().system).not.toContain("Your SOP");
  });
  it("requests a report without an unsupported forced choice or thinking-off retry", async () => {
    fakeStream({ text: "missing report" });
    await runSubAgent(options({ toolChoice: "required" }));
    expect(lastCall()).toMatchObject({ toolChoice: "auto", thinking: true, role: "recall" });
    expect(lastCall().system).toContain("Finish by calling report with the structured report.");
    expect(native.streamText).toHaveBeenCalledTimes(1);
  });
  it("streams live reasoning then writing progress and releases its writer", async () => {
    fakeStream({ chunks: [{ type: "reasoning-delta", text: "first thought" }, { type: "reasoning-delta", text: "\nnext" }, { type: "text-delta", text: "answer" }] });
    const onLine = vi.fn();
    await runSubAgent(options({ progress: { toolCallId: "tc", toolName: "thinkDeep" }, startLine: "Starting", onLine }));
    expect(onLine.mock.calls).toEqual([["first thought", "thinking"], ["next", "thinking"], ["answer", "writing"]]);
    expect(workflow.writer.write).toHaveBeenCalledWith(expect.objectContaining({ type: "data-tool-progress", id: "tool-tc", data: expect.objectContaining({ text: "answer", stage: "writing" }) }));
    expect(workflow.writer.releaseLock).toHaveBeenCalled();
  });
  it("delivers onLine outside a tool without accessing Workflow streams", async () => {
    fakeStream({ chunks: [{ type: "reasoning-delta", delta: "thought" }, { type: "text-delta", delta: "answer" }] });
    const onLine = vi.fn(); await runSubAgent(options({ onLine }));
    expect(onLine.mock.calls).toEqual([["thought", "thinking"], ["answer", "writing"]]); expect(workflow.getWritable).not.toHaveBeenCalled();
  });
  it("maps nested tool starts to progress during the active run", async () => {
    native.streamText.mockImplementation(async (opts: AgentOptions) => {
      await opts.onToolExecutionStart?.({ toolCall: { toolCallId: "nested", toolName: "web_search", input: {} } });
      return { text: Promise.resolve(""), reasoningText: Promise.resolve(""), toolCalls: Promise.resolve([]), sources: Promise.resolve([]) };
    });
    const onToolProgress = vi.fn(() => ({ line: "Searching", stage: "running" as const }));
    await runSubAgent(options({ progress: { toolCallId: "search", toolName: "research" }, onToolProgress }));
    expect(onToolProgress).toHaveBeenCalledWith(expect.objectContaining({ toolName: "web_search", input: {} }));
    expect(workflow.writer.write).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ text: "Searching" }) }));
  });
});
describe("report and progress helpers", () => {
  it("validates reports and rejects absent, null or malformed inputs", () => {
    expect(extractToolReport([{ toolName: "report", input: { verdict: "yes", count: 1 } }], "report", reportSchema)).toEqual({ verdict: "yes", count: 1 });
    expect(extractToolReport(undefined, "report", reportSchema)).toBeUndefined();
    expect(extractToolReport([{ toolName: "report", input: null }], "report", reportSchema)).toBeUndefined();
    expect(extractToolReport([{ toolName: "report", input: { verdict: true } }], "report", reportSchema)).toBeUndefined();
  });
  it("never opens a stream without a tool identity", () => {
    const emitter = createProgressEmitter({ toolName: "test" }); emitter.emit("line", "running"); emitter.close("done");
    expect(workflow.getWritable).not.toHaveBeenCalled();
  });
  it("degrades progress outside a Workflow step", () => {
    workflow.getWritable.mockImplementationOnce(() => { throw new Error("not a step"); });
    const emitter = createProgressEmitter({ toolCallId: "test", toolName: "test" }); emitter.emit("line", "running"); emitter.close("done");
    expect(workflow.writer.write).not.toHaveBeenCalled();
  });
});
