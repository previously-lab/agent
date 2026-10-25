import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelMessage } from "@/lib/deepseek/types";
import type { InnerTurnInput } from "@/lib/chat/turn-types";

const h = vi.hoisted(() => ({
  stream: vi.fn(), report: vi.fn(async (_token: string, _payload: unknown) => {}), close: vi.fn(async () => {}),
  runs: new Map<string, unknown>(),
}));
vi.mock("workflow", () => ({
  getWritable: () => ({}),
  getWorkflowMetadata: () => ({ workflowRunId: "source-child" }),
  setAttributes: vi.fn(async () => {}),
}));
vi.mock("workflow/api", () => ({
  getRun: (runId: string) => ({ status: Promise.resolve("completed"), returnValue: Promise.resolve(h.runs.get(runId)) }),
  start: vi.fn(), resumeHook: vi.fn(),
}));
vi.mock("@/app/api/agent/agent", () => ({ createChatAgent: () => ({ stream: h.stream }) }));
vi.mock("@/app/api/agent/tools", () => ({ buildChatToolsContext: (ctx: unknown) => ({ reportTaskFollowup: ctx }) }));
vi.mock("@/app/api/evolution/reflection-wake", () => ({ deliverReflectionWake: vi.fn() }));
vi.mock("@/app/api/chat/steps", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/app/api/chat/steps")>(),
  reportInnerBubble: h.report, closeChildStream: h.close,
}));

import { innerTurnWorkflow } from "@/app/api/chat/inner-turn-workflow";
import { pollInnerRunReports } from "@/app/api/chat/steps";
import { parseTaskAckMetadata } from "@/lib/chat/task-followups";
import { normalizeEpisodeInboxEvent } from "@/lib/chat/nested-bubble";

const INTENT = { kind: "result" as const, resultId: "child-result", expectedRevision: 1 };
const INPUT: InnerTurnInput = {
  inboxToken: "episode:parent", turnId: "nchild", replyTo: "child",
  messages: [{ role: "user", content: "告诉我研究结果" }], systemPrompt: "Fixture",
  model: "deepseek-v4-flash", thinking: true, reasoningEffort: "high",
  modelConfig: {
    id: "deepseek-v4-flash", name: "Fixture", provider: "deepseek", providerName: "DeepSeek",
    sdk: "deepseek", envKey: "DEEPSEEK_API_KEY",
    capabilities: { thinking: true, vision: false, maxTokens: 1000 }, defaultThinking: true, defaultEffort: "high",
  },
  toolsContext: {
    repo: "local", owner: "local", useGithub: false, useDemo: false,
    sliceId: "2026-10-26-0900", turnId: "child", readScopeId: "child-scope",
    currentUserText: "告诉我研究结果", recentTurns: [],
  },
};

function response(): ModelMessage[] {
  return [
    { role: "system", content: "Fixture" }, ...INPUT.messages,
    { role: "assistant", content: [{ type: "tool-call", toolCallId: "report-1", toolName: "reportTaskFollowup", input: { resultId: "child-result" } }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId: "report-1", toolName: "reportTaskFollowup", output: { type: "json", value: { ok: true, ackIntent: INTENT } } }] },
    { role: "assistant", content: "这里是研究结果。" },
  ];
}

beforeEach(() => {
  vi.clearAllMocks(); h.runs.clear();
  h.stream.mockResolvedValue({ messages: response(), finishReason: "stop" });
});

describe("nested task acknowledgment metadata", () => {
  it("carries the server-produced intent through child return, hook metadata and registry poll", async () => {
    const report = await innerTurnWorkflow(INPUT);
    expect(report).toMatchObject({
      turnId: "nchild", replyTo: "child", sourceRunId: "source-child",
      finishReason: "stop", taskAckIntents: [INTENT], text: "这里是研究结果。",
    });
    const hookReport = h.report.mock.calls[0]?.[1];
    expect(normalizeEpisodeInboxEvent(hookReport)).toMatchObject({ turnId: "nchild", kind: "bubble" });
    expect(parseTaskAckMetadata(hookReport)).toEqual({ taskAckIntents: [INTENT] });
    h.runs.set("source-child", { ...report, sourceRunId: "untrusted-reported-id" });
    const polled = await pollInnerRunReports(["source-child"]);
    expect(polled).toEqual([{
      runId: "source-child", state: "done", report: { ...report, sourceRunId: "source-child" },
    }]);
  });

  it("keeps errors explicit and never invents an intent when the child stream fails", async () => {
    h.stream.mockRejectedValue(new Error("Fixture child failure"));
    const report = await innerTurnWorkflow(INPUT);
    expect(report).toMatchObject({ finishReason: "error", error: "Fixture child failure", text: "" });
    expect(report.taskAckIntents).toBeUndefined();
  });
});
