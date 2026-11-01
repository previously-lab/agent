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
});
