import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DialogueInput, PublicUtterance } from "@/lib/chat/dialogue-contract";
import type { DialogueOfferEvent, DialogueWakeEvent } from "@/lib/dialogue/transport";
import type { DialogueWorldSnapshot } from "@/app/api/chat/dialogue-orchestrator-steps";
import type { DialogueRunState } from "@/lib/dialogue/coordination";
import { forwardedDialogueWakes } from "@/lib/dialogue/coordination";

const h = vi.hoisted(() => ({
  world: null as unknown as DialogueWorldSnapshot,
  conflicts: [] as Array<{ runId: string } | null>,
  createHook: vi.fn(),
  sleep: vi.fn(async () => {}),
  ownRunId: vi.fn(async () => "wrun_ORCHESTRATOR"),
  wait: vi.fn(),
  forward: vi.fn(),
  cancel: vi.fn(),
  runtime: [] as unknown[],
  published: [] as PublicUtterance[],
  prompts: 0,
  beforePublish: vi.fn(),
  prepare: vi.fn(),
}));
vi.mock("workflow", () => ({
  getWritable: vi.fn(() => ({})),
  sleep: h.sleep,
  createHook: h.createHook,
}));
vi.mock("@/app/api/chat/dialogue-orchestrator-steps", () => ({
  readDialogueWorldStep: vi.fn(async () => h.world),
  recordDialogueUtteranceStep: vi.fn(async () => {}),
  stampDialogueTriggerStep: vi.fn(async () => {}),
  cancelDialogueRunStep: h.cancel,
  continueDialogueOrchestratorStep: vi.fn(async () => "wrun_SUCCESSOR"),
  waitForDialogueRunTerminalStep: h.wait,
  forwardDialogueWakeStep: h.forward,
}));
vi.mock("@/app/api/chat/dialogue-transport-steps", () => ({
  dialogueOwnRunIdStep: h.ownRunId,
  openDialogueStreamStep: vi.fn(async () => {}),
  closeDialogueRunStreamStep: vi.fn(async () => {}),
  completeDialogueLapStep: vi.fn(async () => {}),
  writeDialogueRuntimeEventStep: vi.fn(async (event: unknown) => { h.runtime.push(event); }),
  prepareDialogueOfferStep: h.prepare,
  publishDialogueResultStep: vi.fn(async ({ input, text }) => {
    await h.beforePublish(input);
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
  createDialogueAgent: () => ({ stream: async () => { h.prompts++; return { text: "公开结果", finishReason: "stop" }; } }),
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
const initialWake: DialogueWakeEvent = {
  type: "dialogue_wake", runId: "", sessionId: "", parentRunId: "wrun_THOUGHT", sourceInputId: input.inputId,
  workId: "work-A", triggerKey: offer.offerId, candidateKeys: [offer.offerId], wakeAt: input.acceptedAt, reused: false,
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
  h.beforePublish.mockReset().mockResolvedValue(undefined);
  h.createHook.mockReset();
  h.sleep.mockReset().mockResolvedValue();
  h.ownRunId.mockReset().mockResolvedValue("wrun_ORCHESTRATOR");
  h.wait.mockReset();
  h.forward.mockReset().mockResolvedValue(true);
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

  it("delegates to a working same-session holder without cancelling or notifying it", async () => {
    const working = holder();
    working.createdAt = new Date(Date.now() - 3 * 60_000).toISOString();
    working.events = [{ type: "heartbeat", at: working.createdAt }];
    setup(working);
    h.conflicts = [{ runId: "holder" }];
    const result = await dialogueOrchestratorWorkflow({ scope: "scope", sessionId: "session" });
    expect(result.status).toBe("delegated");
    expect(h.cancel).not.toHaveBeenCalled();
    expect(h.forward).not.toHaveBeenCalled();
    expect(h.prompts).toBe(0);
    expect(h.published).toHaveLength(0);
    expect(h.runtime).toContainEqual({ type: "delegated", holderRunId: "holder" });
  });

  it("delegates a competing activation without forwarding a wake", async () => {
    setup(holder("owner-session"));
    h.world.dialogueRuns[0]!.events = [{ type: "heartbeat", at: new Date().toISOString() }];
    h.conflicts = [{ runId: "holder" }];
    const result = await dialogueOrchestratorWorkflow({ scope: "scope", initialWake });
    expect(h.forward).not.toHaveBeenCalled();
    expect(result).toEqual({ status: "delegated", laps: 0 });
    expect(h.runtime).toEqual([{ type: "delegated", holderRunId: "holder" }]);
    expect(forwardedDialogueWakes(h.runtime as DialogueRunState["events"])).toEqual([]);
    expect(h.cancel).not.toHaveBeenCalled();
    expect(h.wait).not.toHaveBeenCalled();
    expect(h.prompts).toBe(0);
    expect(h.published).toHaveLength(0);
  });

  it("pulls a result completed during the current reply without notifying or duplicating the Actor", async () => {
    setup(holder("holder"));
    let release!: () => void;
    let entered!: () => void;
    const publishing = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    h.beforePublish.mockImplementationOnce(async () => { entered(); await publishing; });
    h.ownRunId.mockResolvedValueOnce("holder").mockResolvedValueOnce("contender");
    const owner = dialogueOrchestratorWorkflow({ scope: "scope" });
    await started;

    const second = { ...offer, offerId: "B-final", sourceInputId: "input-B", workId: "work-B", text: "B result" };
    h.world.inputs.push({ ...input, inputId: "input-B", clientMessageId: "message-B" });
    h.world.works.push({ runId: "thought-B", workId: "work-B", inputId: "input-B", status: "completed" });
    h.world.offers.push(second);
    h.conflicts = [{ runId: "holder" }];
    const contender = dialogueOrchestratorWorkflow({ scope: "scope", initialWake: { ...initialWake, triggerKey: second.offerId } });
    await expect(contender).resolves.toMatchObject({ status: "delegated", laps: 0 });
    expect(h.forward).not.toHaveBeenCalled();
    expect(h.prompts).toBe(1);

    release();
    await expect(owner).resolves.toMatchObject({ status: "idle", laps: 2 });
    expect(h.published.map(p => p.sourceResults[0]!.resultId)).toEqual([offer.offerId, second.offerId]);
    expect(h.prompts).toBe(2);
  });

  it("takes the released lease after a holder announces exit", async () => {
    setup(holder());
    h.world.dialogueRuns[0]!.events = [{ type: "exit_intent", keys: [], at: new Date().toISOString() }];
    h.conflicts = [{ runId: "holder" }, null];
    await expect(dialogueOrchestratorWorkflow({ scope: "scope", sessionId: "session", initialWake })).resolves.toMatchObject({ status: "idle" });
    expect(h.forward).not.toHaveBeenCalled();
    expect(h.runtime).toContainEqual(expect.objectContaining({ type: "handoff_wait", waitingForRunId: "holder" }));
    expect(h.runtime).not.toContainEqual(expect.objectContaining({ type: "delegated" }));
    expect(h.published).toHaveLength(1);
  });

  it("does not exhaust the claim budget while a genuine predecessor is still making progress", async () => {
    setup(holder());
    h.conflicts = [...Array.from({ length: 4 }, () => ({ runId: "holder" })), null];
    h.wait.mockResolvedValue("running");
    await expect(dialogueOrchestratorWorkflow({ scope: "scope", sessionId: "session", handoffFrom: "holder", handoffReason: "budget" }))
      .resolves.toMatchObject({ status: "idle" });
    expect(h.wait).toHaveBeenCalledTimes(4);
    expect(h.cancel).not.toHaveBeenCalled();
    expect(h.published).toHaveLength(1);
  });

  it("does not delegate back to a holder whose exit is committed", async () => {
    setup(holder());
    h.world.dialogueRuns[0]!.events.push({ type: "exit_commit", at: new Date().toISOString() });
    h.conflicts = [{ runId: "holder" }, null];
    await expect(dialogueOrchestratorWorkflow({ scope: "scope", initialWake })).resolves.toMatchObject({ status: "idle" });
    expect(h.forward).not.toHaveBeenCalled();
    expect(h.published).toHaveLength(1);
  });

  it("waits for the registry to release a token still attributed to a terminal holder", async () => {
    setup({ ...holder(), status: "completed" });
    h.conflicts = [...Array.from({ length: 7 }, () => ({ runId: "holder" })), null];
    await expect(dialogueOrchestratorWorkflow({ scope: "scope", initialWake })).resolves.toMatchObject({ status: "idle" });
    expect(h.prompts).toBe(1);
    expect(h.sleep).toHaveBeenCalledWith(32_000);
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

  it("keeps waiting for a live predecessor even if its preparation has no recent heartbeat", async () => {
    setup(holder());
    h.conflicts = [{ runId: "holder" }, { runId: "holder" }, null];
    h.wait.mockImplementationOnce(async () => {
      h.world.dialogueRuns[0]!.events = [{ type: "heartbeat", at: "2020-01-01T00:00:00.000Z" }];
    });
    const result = await dialogueOrchestratorWorkflow({ scope: "scope", sessionId: "session", handoffFrom: "holder", handoffReason: "budget" });
    expect(result.status).toBe("idle");
    expect(h.cancel).not.toHaveBeenCalled();
    expect(h.wait).toHaveBeenCalledTimes(2);
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
