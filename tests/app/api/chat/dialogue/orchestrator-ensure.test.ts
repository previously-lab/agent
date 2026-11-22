import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DialogueControlEvent } from "@/lib/dialogue/transport";

const h = vi.hoisted(() => ({
  list: vi.fn(),
  row: vi.fn(),
  events: vi.fn(async (_runId: string): Promise<DialogueControlEvent[]> => []),
  getRun: vi.fn(),
  start: vi.fn(),
  wake: vi.fn(async () => {}),
  workflow: vi.fn(),
  resume: vi.fn(async (_token: string, wake: { runId: string }) => ({ runId: wake.runId })),
}));
vi.mock("workflow/api", () => ({ getRun: h.getRun, start: h.start, resumeHook: h.resume }));
vi.mock("workflow/runtime", () => ({ getWorld: async () => ({ runs: { list: h.list, get: h.row } }) }));
vi.mock("@/lib/dialogue/workflow-offers", () => ({ listDialogueEvents: h.events }));
vi.mock("@/app/api/chat/dialogue-transport-steps", () => ({
  recordDialogueWakeStep: h.wake,
  publishThoughtDeliveryStep: vi.fn(async () => {}),
}));
vi.mock("@/app/api/chat/dialogue-orchestrator-workflow", () => ({ dialogueOrchestratorWorkflow: h.workflow }));

import { ensureDialogueOrchestratorStep, forwardDialogueWakeStep, readDialogueWorldStep, waitForDialogueRunTerminalStep, type DialogueEnsureRequest } from "@/app/api/chat/dialogue-orchestrator-steps";

const now = Date.parse("2026-11-15T01:00:00.000Z");
function run(status: string, triggeredAt: string, scope = "scope") {
  return {
    runId: `run-${status}-${triggeredAt}`,
    status,
    createdAt: triggeredAt,
    attributes: { role: "dialogueOrchestrator", scope, triggeredAt },
  };
}
function request(candidate = "candidate-A"): DialogueEnsureRequest {
  return {
    scope: "scope", parentRunId: "wrun_THOUGHT", sourceInputId: "input-A", workId: "work-A",
    triggerKey: candidate, candidateKeys: [candidate],
  };
}
function readable(events: unknown[] = []) {
  return {
    getTailIndex: async () => events.length - 1,
    getReader: () => {
      const stream = new ReadableStream({
        start(controller) {
          for (const event of events) controller.enqueue(event);
          controller.close();
        },
      });
      return stream.getReader();
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(Date, "now").mockReturnValue(now);
  h.list.mockResolvedValue({ data: [] });
  h.start.mockResolvedValue({ runId: "run-new" });
  h.getRun.mockImplementation(() => ({
    returnValue: Promise.resolve({}), status: Promise.resolve("completed"), cancel: vi.fn(async () => {}),
    getReadable: () => readable(),
  }));
});
afterEach(() => vi.restoreAllMocks());

describe("API dialogue activation with wake events", () => {
  it("leaves legacy reply offers with their original owner after an upgrade", async () => {
    const attributes = { role: "thinking", scope: "scope", turn: "old-input", dialogue: "1" };
    const acceptedAt = new Date(now).toISOString();
    h.list.mockResolvedValue({ data: [
      { runId: "legacy", status: "completed", attributes },
      { runId: "legacy-stamped", status: "completed", attributes: { ...attributes, acceptedAt } },
      { runId: "current", status: "running", attributes: { ...attributes, turn: "new-input", acceptedAt, delivery: "orchestrator" } },
    ] });
    h.events.mockResolvedValueOnce([{ type: "offer", runId: "legacy-reply", offerId: "already-delivered", sourceInputId: "old-input" }]);
    const world = await readDialogueWorldStep("scope");
    expect(h.events).not.toHaveBeenCalledWith("legacy");
    expect(world.offers).toEqual([]);
    expect(world.works.map(work => work.inputId)).toEqual(["new-input"]);
  });
  it("resumes a healthy Actor and records the wake", async () => {
    h.list.mockResolvedValue({ data: [run("running", new Date(now - 60_000).toISOString())] });
    const runId = `run-running-${new Date(now - 60_000).toISOString()}`;
    await expect(ensureDialogueOrchestratorStep(request())).resolves.toMatchObject({ runId, sessionId: runId, reused: true });
    expect(h.start).not.toHaveBeenCalled();
    expect(h.resume).toHaveBeenCalledWith("dialogue-execution:scope", expect.objectContaining({ runId, reused: true }));
    expect(h.wake).toHaveBeenCalledWith(expect.objectContaining({ runId, reused: true, triggerKey: "candidate-A" }));
  });

  it("records the actual new owner's session if the lease changed after discovery", async () => {
    h.list.mockResolvedValue({ data: [run("running", new Date(now - 1_000).toISOString())] });
    h.resume.mockResolvedValueOnce({ runId: "new-owner" });
    h.row.mockResolvedValueOnce({ attributes: { role: "dialogueOrchestrator", scope: "scope", session: "new-session" } });
    await expect(ensureDialogueOrchestratorStep(request())).resolves.toMatchObject({ runId: "new-owner", sessionId: "new-session" });
    expect(h.wake).toHaveBeenCalledWith(expect.objectContaining({ runId: "new-owner", sessionId: "new-session" }));
  });

  it("only acknowledges a forwarded wake accepted by the observed owner", async () => {
    const wake = { ...request(), type: "dialogue_wake" as const, runId: "holder", sessionId: "session",
      wakeAt: new Date(now).toISOString(), reused: true };
    h.resume.mockResolvedValueOnce({ runId: "holder" }).mockResolvedValueOnce({ runId: "other" })
      .mockRejectedValueOnce(Object.assign(new Error("missing"), { name: "HookNotFoundError" }))
      .mockRejectedValueOnce(new Error("queue unavailable"));
    await expect(forwardDialogueWakeStep("scope", wake)).resolves.toBe(true);
    await expect(forwardDialogueWakeStep("scope", wake)).resolves.toBe(false);
    await expect(forwardDialogueWakeStep("scope", wake)).resolves.toBe(false);
    await expect(forwardDialogueWakeStep("scope", wake)).rejects.toThrow("queue unavailable");
  });

  it("waits for the first Actor to register its hook instead of duplicating it", async () => {
    const existing = run("running", new Date(now - 60_000).toISOString());
    h.list.mockResolvedValue({ data: [existing] });
    let attempts = 0;
    h.resume.mockImplementation(async () => {
      attempts++;
      if (attempts < 3) throw Object.assign(new Error("registering"), { name: "HookNotFoundError" });
      return { runId: existing.runId };
    });
    await expect(ensureDialogueOrchestratorStep(request())).resolves.toMatchObject({ runId: existing.runId, reused: true });
    expect(attempts).toBe(3);
    expect(h.start).not.toHaveBeenCalled();
  });

  it("starts fresh for a terminal run while retaining its in-window session", async () => {
    const existing = run("completed", new Date(now - 1_000).toISOString());
    h.list.mockResolvedValue({ data: [existing] });
    await expect(ensureDialogueOrchestratorStep(request())).resolves.toMatchObject({
      runId: "run-new", sessionId: existing.runId, reused: false,
    });
    expect(h.start).toHaveBeenCalledWith(h.workflow, [expect.objectContaining({ scope: "scope", sessionId: existing.runId })], expect.objectContaining({
      attributes: expect.objectContaining({ role: "dialogueOrchestrator", scope: "scope" }),
    }));
  });

  it("starts a new session for an expired run and fences its stale heartbeat", async () => {
    h.list.mockResolvedValue({ data: [run("running", new Date(now - 31 * 60_000).toISOString())] });
    await expect(ensureDialogueOrchestratorStep(request())).resolves.toMatchObject({ runId: "run-new", sessionId: "run-new", reused: false });
    expect(h.getRun).toHaveBeenCalledWith(`run-running-${new Date(now - 31 * 60_000).toISOString()}`);
  });

  it("resumes the healthy sleeping Actor after three minutes without a heartbeat", async () => {
    const existing = run("running", new Date(now - 3 * 60_000).toISOString());
    h.list.mockResolvedValue({ data: [existing] });
    h.getRun.mockImplementation(() => ({
      returnValue: Promise.resolve({}), status: Promise.resolve("completed"), cancel: vi.fn(async () => {}),
      getReadable: () => readable([{ type: "data-dialogue-exit_intent", data: { type: "exit_intent", keys: [], at: existing.createdAt } }]),
    }));
    await expect(ensureDialogueOrchestratorStep(request())).resolves.toMatchObject({
      runId: existing.runId, sessionId: existing.runId, reused: true,
    });
    expect(h.start).not.toHaveBeenCalled();
  });

  it("expires a sleeping Actor at the end of the session", async () => {
    const existing = run("running", new Date(now - 31 * 60_000).toISOString());
    h.list.mockResolvedValue({ data: [existing] });
    const cancel = vi.fn(async () => {});
    h.getRun.mockImplementation(() => ({
      status: Promise.resolve("cancelled"), cancel,
      getReadable: () => readable([{ data: { type: "exit_intent", keys: [], at: existing.createdAt } }]),
    }));
    await expect(ensureDialogueOrchestratorStep(request())).resolves.toMatchObject({ runId: "run-new", sessionId: "run-new" });
    expect(cancel).toHaveBeenCalledOnce();
    expect(h.resume).not.toHaveBeenCalled();
  });

  it("can recheck a live run on a World without native long polling", async () => {
    vi.useFakeTimers();
    try {
      h.getRun.mockReturnValue({ status: Promise.resolve("running"), returnValue: new Promise(() => {}) });
      const waiting = waitForDialogueRunTerminalStep("running", 250);
      await vi.advanceTimersByTimeAsync(250);
      await expect(waiting).resolves.toBe("running");
    } finally {
      vi.useRealTimers();
    }
  });

  it("starts with the first wake when no hook can be resumed", async () => {
    const existing = run("running", new Date(now - 60_000).toISOString());
    h.list.mockResolvedValue({ data: [existing] });
    h.resume.mockRejectedValue(Object.assign(new Error("no active hook"), { name: "HookNotFoundError" }));
    await expect(ensureDialogueOrchestratorStep(request())).resolves.toMatchObject({
      runId: "run-new", sessionId: existing.runId, reused: false,
    });
    const args = h.start.mock.calls[0]![1][0] as { initialWake: { triggerKey: string; runId: string } };
    expect(args.initialWake).toMatchObject({ triggerKey: "candidate-A" });
    expect(h.wake).toHaveBeenCalledWith(expect.objectContaining({ runId: "run-new", reused: false }));
  });

  it("does not reuse another conversation's run", async () => {
    h.list.mockResolvedValue({ data: [run("running", new Date(now - 1_000).toISOString(), "other")] });
    await expect(ensureDialogueOrchestratorStep(request())).resolves.toMatchObject({ runId: "run-new", sessionId: "run-new", reused: false });
  });

  it("does not start blindly when the registry cannot be read", async () => {
    h.list.mockRejectedValue(new Error("registry unavailable"));
    await expect(ensureDialogueOrchestratorStep(request())).rejects.toThrow("registry unavailable");
    expect(h.start).not.toHaveBeenCalled();
  });
});
