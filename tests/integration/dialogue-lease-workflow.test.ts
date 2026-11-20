import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DialogueInput, PublicUtterance } from "@/lib/chat/dialogue-contract";
import type { DialogueOfferEvent } from "@/lib/dialogue/transport";
import type { DialogueWorldSnapshot } from "@/app/api/chat/dialogue-orchestrator-steps";
import type { DialogueRunState } from "@/lib/dialogue/coordination";

const h = vi.hoisted(() => ({
  world: null as unknown as DialogueWorldSnapshot,
  conflicts: [] as Array<{ runId: string } | null>,
  createHook: vi.fn(),
  wait: vi.fn(),
  cancel: vi.fn(),
  runtime: [] as unknown[],
  published: [] as PublicUtterance[],
  prompts: 0,
  prepare: vi.fn(),
}));
vi.mock("workflow", () => ({
  getWritable: vi.fn(() => ({})),
  sleep: vi.fn(async () => {}),
  createHook: h.createHook,
}));
vi.mock("@/app/api/chat/dialogue-orchestrator-steps", () => ({
  readDialogueWorldStep: vi.fn(async () => h.world),
  recordDialogueUtteranceStep: vi.fn(async () => {}),
  stampDialogueTriggerStep: vi.fn(async () => {}),
  cancelDialogueRunStep: h.cancel,
  continueDialogueOrchestratorStep: vi.fn(async () => "wrun_SUCCESSOR"),
  waitForDialogueRunTerminalStep: h.wait,
}));
vi.mock("@/app/api/chat/dialogue-transport-steps", () => ({
  dialogueOwnRunIdStep: vi.fn(async () => "wrun_ORCHESTRATOR"),
  openDialogueStreamStep: vi.fn(async () => {}),
  closeDialogueRunStreamStep: vi.fn(async () => {}),
  completeDialogueLapStep: vi.fn(async () => {}),
  writeDialogueRuntimeEventStep: vi.fn(async (event: unknown) => { h.runtime.push(event); }),
  prepareDialogueOfferStep: h.prepare,
  publishDialogueResultStep: vi.fn(async ({ input, text }) => {
    const utterance: PublicUtterance = {
      utteranceId: input.publicationId ?? input.offerId, publicSeq: 1, committedAt: new Date().toISOString(),
      inputIds: [input.context.sourceInputId], sourceResults: [{ resultId: input.offerId, productRevision: 1, claimIds: [] }],
      phase: "final_answer", blocks: [{ kind: "markdown", blockId: "text", text }],
    };
    h.published.push(utterance);
    h.world.publications.push(utterance);
    return utterance;
  }),
}));
vi.mock("@/app/api/agent/agent", () => ({
  createDialogueAgent: () => ({ stream: async () => { h.prompts++; return { text: "公开结果" }; } }),
}));

import { dialogueOrchestratorWorkflow } from "@/app/api/chat/dialogue-orchestrator-workflow";

const input: DialogueInput = {
  inputId: "input-A", clientMessageId: "message-A", userSeq: 1, eventSeq: 1,
  acceptedAt: "2026-11-15T00:00:00.000Z", text: "Question A",
};
const offer: DialogueOfferEvent = {
  type: "offer", offerId: "A-final", runId: "wrun_THOUGHT", parentRunId: "wrun_THOUGHT",
  sourceInputId: "input-A", workId: "work-A", stage: "final", publicSeq: 1, text: "A result", locale: "zh",
  record: { useGithub: false, useDemo: false, owner: "local", repo: "local", timezone: "UTC", slicing: { idleGapMinutes: 30, maxSliceMinutes: 30, maxTurnsPerSlice: 50 } },
};
function holder(sessionId = "session"): DialogueRunState {
  return {
    runId: "holder", sessionId, status: "running", createdAt: new Date().toISOString(),
    events: [{ type: "heartbeat", at: new Date().toISOString() }],
  };
}
function setup(holderRun: DialogueRunState) {
  h.world = {
    scope: "scope", works: [{ runId: "wrun_THOUGHT", workId: "work-A", inputId: "input-A", status: "running" }],
    inputs: [input], starts: [], wakes: [], offers: [offer], publications: [], dialogueRuns: [holderRun],
  };
}

beforeEach(() => {
  h.conflicts = [];
  h.runtime = [];
  h.published = [];
  h.prompts = 0;
  h.createHook.mockReset();
  h.wait.mockReset();
  h.cancel.mockReset();
  h.prepare.mockReset().mockResolvedValue({ artifacts: [], prompt: "result", superseded: false });
  // Like the real runtime, a conflict is cached permanently by its own hook.
  h.createHook.mockImplementation(() => {
    const conflict = h.conflicts.shift() ?? null;
    return {
      getConflict: vi.fn(async () => conflict), dispose: vi.fn(),
      [Symbol.asyncIterator]: () => ({ next: vi.fn(async () => ({ done: true, value: undefined })) }),
    };
  });
  h.wait.mockImplementation(async () => {
    const current = h.world.dialogueRuns.find(run => run.runId === "holder");
    if (current) current.status = "completed";
  });
  h.cancel.mockImplementation(async () => {
    const current = h.world.dialogueRuns.find(run => run.runId === "holder");
    if (current) current.status = "cancelled";
  });
});

describe("dialogue lease and handoff execution", () => {
  it("retries a released token with a fresh hook instead of reusing the conflict", async () => {
    const terminal = holder();
    terminal.status = "completed";
    setup(terminal);
    h.conflicts = [{ runId: "holder" }, null];
    const result = await dialogueOrchestratorWorkflow({ scope: "scope", sessionId: "session" });
    expect(result.status).toBe("idle");
    expect(h.createHook).toHaveBeenCalledTimes(2);
    expect(h.runtime).toContainEqual(expect.objectContaining({ type: "lease_acquired" }));
    expect(h.published).toHaveLength(1);
  });

  it("passes the selected response mode from the work candidate into public wording", async () => {
    setup(holder());
    h.world.offers = [{ ...offer, responseMode: "chat" }];
    await dialogueOrchestratorWorkflow({ scope: "scope", sessionId: "session" });
    expect(h.prepare).toHaveBeenCalledWith(expect.objectContaining({ responseMode: "chat" }), "wrun_ORCHESTRATOR");
  });

  it("delegates to a healthy idle same-session holder without cancelling it", async () => {
    const idle = holder();
    idle.createdAt = new Date(Date.now() - 3 * 60_000).toISOString();
    idle.events = [{ type: "exit_intent", at: idle.createdAt, keys: [] }];
    setup(idle);
    h.conflicts = [{ runId: "holder" }];
    const result = await dialogueOrchestratorWorkflow({ scope: "scope", sessionId: "session" });
    expect(result.status).toBe("delegated");
    expect(h.cancel).not.toHaveBeenCalled();
    expect(h.prompts).toBe(0);
    expect(h.published).toHaveLength(0);
    expect(h.runtime).toContainEqual({ type: "delegated", holderRunId: "holder" });
  });

  it("waits for the predecessor before a budget successor publishes", async () => {
    setup(holder());
    h.conflicts = [{ runId: "holder" }, { runId: "holder" }, null];
    // First wait observes a still-running predecessor; the second conflict is reclaimed after cancellation.
    h.wait.mockImplementationOnce(async () => {}).mockImplementationOnce(async () => {
      h.world.dialogueRuns[0]!.status = "completed";
    });
    // The second conflict is terminal, so no cancellation is needed.
    h.world.dialogueRuns[0]!.status = "running";
    h.conflicts = [{ runId: "holder" }, null];
    const result = await dialogueOrchestratorWorkflow({ scope: "scope", sessionId: "session", handoffFrom: "holder", handoffReason: "budget" });
    expect(result.status).toBe("idle");
    expect(h.wait).toHaveBeenCalledWith("holder");
    expect(h.published).toHaveLength(1);
    expect(h.runtime).not.toContainEqual({ type: "delegated", holderRunId: "holder" });
  });

  it("rechecks and cancels a predecessor that becomes stale during handoff waiting", async () => {
    setup(holder());
    h.conflicts = [{ runId: "holder" }, { runId: "holder" }, null];
    h.wait.mockImplementationOnce(async () => {
      h.world.dialogueRuns[0]!.events = [{ type: "heartbeat", at: "2020-01-01T00:00:00.000Z" }];
    });
    const result = await dialogueOrchestratorWorkflow({ scope: "scope", sessionId: "session", handoffFrom: "holder", handoffReason: "budget" });
    expect(result.status).toBe("idle");
    expect(h.cancel).toHaveBeenCalledWith("holder");
    expect(h.published).toHaveLength(1);
  });

  it("waits for a healthy old-session holder instead of delegating the new session back", async () => {
    setup(holder("old-session"));
    h.conflicts = [{ runId: "holder" }, null];
    const result = await dialogueOrchestratorWorkflow({ scope: "scope", sessionId: "new-session", handoffReason: "session_expiry" });
    expect(result.status).toBe("idle");
    expect(h.wait).toHaveBeenCalledWith("holder");
    expect(h.runtime).toContainEqual(expect.objectContaining({ type: "handoff_wait", waitingForRunId: "holder" }));
    expect(h.published).toHaveLength(1);
  });
});
