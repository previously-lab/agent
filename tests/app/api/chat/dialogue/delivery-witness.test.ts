import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DialogueEnsureRequest } from "@/app/api/chat/dialogue-orchestrator-steps";

type Row = {
  runId: string;
  status: string;
  createdAt: string;
  attributes: Record<string, string>;
  chunks: unknown[];
};

const h = vi.hoisted(() => ({
  rows: [] as Row[],
  start: vi.fn(),
  getRun: vi.fn(),
  wait: vi.fn(),
  resume: vi.fn(async (_token: string, wake: { runId: string }) => ({ runId: wake.runId })),
  wake: vi.fn(async () => {}),
  publish: vi.fn(async () => {}),
  publishOnStart: true,
  workflow: vi.fn(),
}));
vi.mock("workflow/runtime", () => ({
  getWorld: async () => ({ runs: { list: async () => ({ data: h.rows, hasMore: false, cursor: null }), waitForTerminalStatus: h.wait } }),
}));
vi.mock("workflow/api", () => ({ getRun: h.getRun, start: h.start, resumeHook: h.resume }));
vi.mock("@/lib/dialogue/workflow-offers", () => ({ listDialogueEvents: vi.fn(async () => []) }));
vi.mock("@/app/api/chat/dialogue-transport-steps", () => ({
  recordDialogueWakeStep: h.wake,
  publishThoughtDeliveryStep: h.publish,
}));
vi.mock("@/app/api/chat/dialogue-orchestrator-workflow", () => ({ dialogueOrchestratorWorkflow: h.workflow }));

import { witnessDialogueDeliveryStep } from "@/app/api/chat/dialogue-orchestrator-steps";

const candidate = "candidate-A";
function request(): DialogueEnsureRequest {
  return {
    scope: "scope", parentRunId: "wrun_THOUGHT", sourceInputId: "input-A", workId: "work-A",
    triggerKey: candidate, candidateKeys: [candidate],
  };
}
function publication() {
  return {
    type: "data-dialogue-publication",
    data: { utteranceId: "public-A", publicSeq: 1, committedAt: new Date().toISOString(), inputIds: ["input-A"], sourceResults: [{ resultId: candidate, productRevision: 1, claimIds: [] }], blocks: [] },
  };
}
function row(status = "completed", chunks: unknown[] = []): Row {
  return {
    runId: "run-initial", status, createdAt: new Date().toISOString(),
    attributes: { role: "dialogueOrchestrator", scope: "scope" }, chunks,
  };
}
function readable(chunks: unknown[]) {
  return {
    getTailIndex: async () => chunks.length - 1,
    getReader: () => {
      const stream = new ReadableStream({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(chunk);
          controller.close();
        },
      });
      return stream.getReader();
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.rows = [];
  h.publishOnStart = true;
  h.start.mockImplementation(() => {
    const runId = `run-new-${h.start.mock.calls.length}`;
    h.rows.push({
      runId, status: "completed", createdAt: new Date().toISOString(),
      attributes: { role: "dialogueOrchestrator", scope: "scope" },
      chunks: h.publishOnStart ? [publication()] : [],
    });
    return Promise.resolve({ runId });
  });
  h.wait.mockImplementation(async () => {});
  h.getRun.mockImplementation((runId: string) => {
    const current = h.rows.find(item => item.runId === runId);
    return {
      status: Promise.resolve(current?.status ?? "completed"),
      returnValue: Promise.resolve({}),
      cancel: vi.fn(async () => { if (current) current.status = "cancelled"; }),
      getReadable: () => readable(current?.chunks ?? []),
    };
  });
});

afterEach(() => vi.restoreAllMocks());

describe("thought-side dialogue delivery witness", () => {
  it("finishes delivered from an existing canonical publication without waking another run", async () => {
    h.rows = [row("completed", [publication()])];
    await expect(witnessDialogueDeliveryStep(request(), "run-initial", candidate)).resolves.toBe("delivered");
    expect(h.start).not.toHaveBeenCalled();
    expect(h.publish).toHaveBeenCalledWith(expect.objectContaining({ status: "delivered", candidateId: candidate }));
  });

  it("recovers a terminal responsible run with no publication", async () => {
    h.rows = [row()];
    await expect(witnessDialogueDeliveryStep(request(), "run-initial", candidate)).resolves.toBe("delivered");
    expect(h.start).toHaveBeenCalledOnce();
  });

  it("uses an explicit expression failure as the terminal outcome", async () => {
    h.rows = [row("failed", [{ type: "data-dialogue-expression_outcome", data: {
      type: "expression_outcome", status: "failed", candidateIds: [candidate], inputIds: ["input-A"], planId: candidate,
    } }])];
    await expect(witnessDialogueDeliveryStep(request(), "run-initial", candidate)).resolves.toBe("failed");
    expect(h.start).not.toHaveBeenCalled();
    expect(h.publish).toHaveBeenCalledWith(expect.objectContaining({ status: "failed" }));
  });

  it("waits natively for a live run and then observes its commit", async () => {
    h.rows = [row("running")];
    h.wait.mockImplementation(async (runId: string) => {
      const current = h.rows.find(item => item.runId === runId)!;
      current.status = "completed";
      current.chunks = [publication()];
    });
    await expect(witnessDialogueDeliveryStep(request(), "run-initial", candidate)).resolves.toBe("delivered");
    expect(h.wait).toHaveBeenCalledWith("run-initial", expect.objectContaining({ resolveData: "none" }));
  });

  it("gives a sleeping Actor time to acknowledge each wake and bounds a missing delivery", async () => {
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const idleAt = new Date(now - 3 * 60_000).toISOString();
    const idle = row("running", [{ data: { type: "exit_intent", at: idleAt, keys: [] } }]);
    idle.createdAt = idleAt;
    h.rows = [idle];
    h.wait.mockImplementation(async () => { now += 2 * 60_000; });
    await expect(witnessDialogueDeliveryStep(request(), "run-initial", candidate)).resolves.toBe("failed");
    expect(h.wait).toHaveBeenCalledTimes(3);
    expect(h.resume).toHaveBeenCalledTimes(2);
    expect(h.start).not.toHaveBeenCalled();
  });

  it("bounds terminal-without-delivery replacements", async () => {
    h.rows = [row()];
    h.publishOnStart = false;
    await expect(witnessDialogueDeliveryStep(request(), "run-initial", candidate)).resolves.toBe("failed");
    expect(h.start).toHaveBeenCalledTimes(2);
    expect(h.publish).toHaveBeenCalledWith(expect.objectContaining({ status: "failed" }));
  });

  it("turns a responsibility cycle into an explicit failure", async () => {
    const a = row("completed", [{ type: "data-dialogue-delegated", data: { type: "delegated", holderRunId: "run-b" } }]);
    const b = { ...row("completed", [{ type: "data-dialogue-delegated", data: { type: "delegated", holderRunId: "run-initial" } }]), runId: "run-b" };
    h.rows = [a, b];
    await expect(witnessDialogueDeliveryStep(request(), "run-initial", candidate)).resolves.toBe("failed");
    expect(h.start).not.toHaveBeenCalled();
  });
});
