import { beforeEach, describe, expect, it, vi } from "vitest";

const recall = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("@/lib/agents/scenario-recall", () => ({ runScenarioRecall: recall.run }));
vi.mock("workflow", () => ({
  getWritable: () => ({
    getWriter: () => ({ write: vi.fn(async () => {}), releaseLock: vi.fn() }),
  }),
}));

import { recallScenarioExecute, type ToolContext } from "@/app/api/agent/tool-executors";
import { FIXED_MODEL } from "@/lib/models/registry";
import type { ModelMessage } from "@/lib/deepseek/types";
import { createThinkingReadReceipt, wrapThinkingRead } from "@/lib/agents/thinking-read-receipt";

const context = {
  repo: "local",
  owner: "local",
  useGithub: false,
  useDemo: false,
  sliceId: "2026-10-20-1000",
  turnId: "turn-test",
  readScopeId: "turn-test",
  currentUserText: "question",
  recentTurns: [],
  mainModel: { ...FIXED_MODEL, id: "untrusted-main-override" },
} satisfies ToolContext;

describe("recallScenarioExecutor model and abort contract", () => {
  beforeEach(() => {
    recall.run.mockReset();
    recall.run.mockResolvedValue({
      status: "insufficient_evidence",
      answer: "",
      evidence: [],
      coverage: { discovered: 0, searched: [], read: [], omitted: 0, notes: [] },
      truncated: true,
      uncertainty: ["fixture"],
    });
  });

  it("pins the fixed DeepSeek Flash config and forwards the caller abort signal", async () => {
    const controller = new AbortController();
    await recallScenarioExecute(
      { question: "What did the user decide?", refs: ["records/2026-10-20-0930"] },
      { context, toolCallId: "recall-call", abortSignal: controller.signal },
    );
    expect(recall.run).toHaveBeenCalledTimes(1);
    const input = recall.run.mock.calls[0][0];
    expect(input.model).toBe(FIXED_MODEL);
    expect(input.model.id).toBe("deepseek-flash");
    expect(input.signal).toBe(controller.signal);
  });

  it("supplies a prior revision only for a paired full original read from the same thinking work", async () => {
    const ref = "records/2026-10-20-0930";
    const revision = "a".repeat(64);
    const opts = { context: { ...context, thinkingFlow: true }, toolCallId: "verify" };
    const request = { question: "Who said what?", refs: [ref] };
    const messages = (scopeId: string, toolName: string, coverage: "full" | "range"): ModelMessage[] => {
      const receipt = createThinkingReadReceipt(scopeId, "original", [{ ref, revision, sourceKind: "original_turn",
        edition: "original", coverage, asOf: "2026-10-20T10:00:00Z" }]);
      return [{ role: "assistant", content: [{ type: "tool-call", toolCallId: "original", toolName, input: { ref, direct: true } }] },
        { role: "tool", content: [{ type: "tool-result", toolCallId: "original", toolName,
          output: { type: "json", value: { kind: "public_record_v1", scopeId, toolCallId: "original", ref, text: "Public originals.", thinkingReceipt: receipt } } }] }];
    };
    const valid = messages(context.readScopeId, "recallRead", "full");
    await recallScenarioExecute(request, { ...opts, messages: valid });
    expect(recall.run.mock.lastCall?.[0].priorFullRecord).toEqual({ ref, revision });
    for (const history of [messages("another-work", "recallRead", "full"), messages(context.readScopeId, "webFetch", "full"),
      messages(context.readScopeId, "recallRead", "range"), valid.slice(1), [...valid, valid[1]]]) {
      await recallScenarioExecute(request, { ...opts, messages: history });
      expect(recall.run.mock.lastCall?.[0].priorFullRecord).toBeUndefined();
    }
  });

  it("lets the first case passage inform broad recollection without delaying a targeted or independent read", async () => {
    const ref = "research/设计记录";
    const original = "records/2026-10-20-0930";
    const question = { question: "What did the test establish?", refs: [original] };
    const batch: ModelMessage = { role: "assistant", content: [
      { type: "tool-call", toolName: "recallScenario", toolCallId: "fallback", input: question },
      { type: "tool-call", toolName: "recallRead", toolCallId: "doc", input: { ref } },
    ] };
    const opts = { context: { ...context, thinkingFlow: true }, toolCallId: "fallback", messages: [batch] };
    expect(await recallScenarioExecute(question, opts)).toMatchObject({ status: "deferred", evidence: [] });
    expect(recall.run).not.toHaveBeenCalled();
    await recallScenarioExecute({ ...question, searchTerms: ["test"] }, opts);
    await recallScenarioExecute({ ...question, targets: [{ ref: original, turnId: "a", role: "user" }] }, opts);
    await recallScenarioExecute(question, { ...opts, messages: [] });
    expect(recall.run).toHaveBeenCalledTimes(3);

    const receipt = createThinkingReadReceipt(context.readScopeId, "doc", [{
      ref, sourceKind: "semantic_document", coverage: "range", revision: "v1", asOf: "2026-10-20T00:00:00Z",
    }]);
    const received: ModelMessage[] = [
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "doc", toolName: "recallRead", input: { ref } }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "doc", toolName: "recallRead",
        output: { type: "text", value: wrapThinkingRead(receipt, "Observed the intermediate response.") } }] },
      { role: "assistant", content: [
        { type: "tool-call", toolName: "recallRead", toolCallId: "more", input: { ref } },
        { type: "tool-call", toolName: "recallScenario", toolCallId: "fallback", input: question },
      ] },
    ];
    await recallScenarioExecute(question, { ...opts, messages: received });
    expect(recall.run).toHaveBeenCalledTimes(4);
  });
});
