import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DialogueControlEvent } from "@/lib/dialogue/transport";

const h = vi.hoisted(() => ({
  list: vi.fn(),
  row: vi.fn(),
  events: vi.fn(async (_runId: string): Promise<DialogueControlEvent[]> => []),
  getRun: vi.fn(),
  start: vi.fn(),
  hook: vi.fn(),
  wake: vi.fn(async () => {}),
  workflow: vi.fn(),
  turn: vi.fn(),
  resume: vi.fn(async (_token: string | { runId: string }, wake: { runId: string }) => ({ runId: wake.runId })),
}));
vi.mock("workflow/api", () => ({ getRun: h.getRun, getHookByToken: h.hook, start: h.start, resumeHook: h.resume }));
vi.mock("workflow/runtime", () => ({ getWorld: async () => ({ runs: { list: h.list, get: h.row } }) }));
vi.mock("@/lib/dialogue/workflow-offers", () => ({ listDialogueEvents: h.events }));
vi.mock("@/app/api/chat/dialogue-transport-steps", () => ({
  recordDialogueWakeStep: h.wake,
  publishThoughtDeliveryStep: vi.fn(async () => {}),
}));
vi.mock("@/app/api/chat/dialogue-orchestrator-workflow", () => ({ dialogueOrchestratorWorkflow: h.workflow }));
vi.mock("@/app/api/chat/turn-workflow", () => ({ turnWorkflow: h.turn }));

import { ensureDialogueOrchestratorStep, forwardDialogueWakeStep, readDialogueWorldStep, readDialogueAdmissionStep, readWorkSnapshotStep, waitForDialogueRunTerminalStep, type DialogueEnsureRequest } from "@/app/api/chat/dialogue-orchestrator-steps";

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
  it("skips the current thought stream on cold activation and still discovers other works", async () => {
    const thought = (id: string) => ({ runId: id, status: "running", createdAt: new Date(now), attributes: {
      role: "thinking", scope: "scope", turn: id, work: id, delivery: "orchestrator", acceptedAt: new Date(now).toISOString(),
    } });
    h.list.mockResolvedValue({ data: [thought("other"), thought("input-A")] });
    const result = await ensureDialogueOrchestratorStep(request());
    expect(result.otherWorks).toMatchObject([{ workId: "other" }]);
    expect(h.events.mock.calls.map(([id]) => id)).toEqual(["other"]);
    expect(h.start).toHaveBeenCalledTimes(1);
  });

  it("wakes only the checked scoped hook and reads no registry or other streams", async () => {
    const current = run("running", new Date(now - 10_000).toISOString());
    const holder = { runId: current.runId, sessionId: "session" };
    const hook = { runId: current.runId, hookId: "hook-A" };
    h.row.mockResolvedValue({ ...current, attributes: { ...current.attributes, session: holder.sessionId } });
    h.hook.mockResolvedValue(hook);
    h.getRun.mockReturnValue({ getReadable: () => readable([{ data: { type: "exit_intent", at: current.createdAt, keys: [] } }]) });
    await expect(ensureDialogueOrchestratorStep(request(), holder)).resolves.toMatchObject({ ...holder, reused: true });
    expect(h.getRun.mock.calls.map(([id]) => id)).toEqual([holder.runId]);
    expect(h.hook).toHaveBeenCalledWith("dialogue-execution:scope");
    expect(h.resume).toHaveBeenCalledWith(hook, expect.objectContaining({ ...holder, triggerKey: "candidate-A" }));
    expect(h.wake).toHaveBeenCalledWith(expect.objectContaining(holder));
    expect(h.list).not.toHaveBeenCalled();
    expect(h.events).not.toHaveBeenCalled();
    expect(h.start).not.toHaveBeenCalled();

    // Same healthy owner and trigger via the historical discovery path.
    const histories = Array.from({ length: 24 }, (_, i) => ({
      runId: `work-${i}`, status: "running", createdAt: new Date(now - i), attributes: {
        role: "thinking", scope: "scope", turn: `input-${i}`, delivery: "orchestrator",
      },
    }));
    h.list.mockResolvedValue({ data: [{ ...current, attributes: { ...current.attributes, session: holder.sessionId } }, ...histories] });
    await expect(ensureDialogueOrchestratorStep(request())).resolves.toMatchObject({ ...holder, reused: true });
    expect(h.list).toHaveBeenCalledTimes(2);
    expect(h.events).toHaveBeenCalledTimes(histories.length);
    expect(h.wake.mock.calls[0]).toEqual(h.wake.mock.calls[1]);
  });

  it.each([
    ["session", { session: "old" }], ["scope", { scope: "other" }], ["role", { role: "thinking" }],
    ["terminal", { status: "completed" }], ["changed hook", { owner: "new" }], ["missing hook", { missing: true }],
    ["expired session", { age: 1_810_000 }], ["stale heartbeat", { age: 121_000 }],
    ["idle wake history needed", { event: { type: "exit_intent", at: new Date(now - 125_000).toISOString(), keys: [] } }],
    ["handoff", { event: { type: "continued", nextRunId: "next" } }],
    ["handoff wait", { event: { type: "handoff_wait", waitingForRunId: "other", at: new Date(now).toISOString() } }],
    ["exit", { event: { type: "exit_commit", at: new Date(now).toISOString() } }],
    ["failure", { event: { type: "expression_outcome", status: "failed", candidateIds: ["candidate-A"] } }],
    ["large stream", { large: true }], ["partial stream", { partial: true }],
  ] as Array<[string, { session?: string; scope?: string; role?: string; status?: string; age?: number; owner?: string;
    missing?: boolean; event?: unknown; large?: boolean; partial?: boolean }]>)("uses discovery for %s", async (_reason, change) => {
    const holder = { runId: "wrun_OLD", sessionId: "session" };
    const current = run(change.status ?? "running", new Date(now - (change.age ?? 10_000)).toISOString());
    h.row.mockResolvedValue({ ...current, runId: holder.runId, attributes: {
      role: change.role ?? "dialogueOrchestrator", scope: change.scope ?? "scope", session: change.session ?? holder.sessionId,
    } });
    const hook = { runId: change.owner ?? holder.runId, hookId: "hook-A" };
    if (change.missing) h.hook.mockRejectedValueOnce(Object.assign(new Error("missing"), { name: "HookNotFoundError" }));
    else h.hook.mockResolvedValue(hook);
    const stream = readable(change.event ? [{ data: change.event }] : []);
    if (change.large || change.partial) stream.getTailIndex = async () => change.large ? 1500 : 2;
    h.getRun.mockReturnValue({ getReadable: () => stream });
    await expect(ensureDialogueOrchestratorStep(request(), holder)).resolves.toMatchObject({ runId: "run-new" });
    expect(h.list).toHaveBeenCalled();
    expect(h.resume).not.toHaveBeenCalled();
    expect(h.wake).not.toHaveBeenCalledWith(expect.objectContaining({ runId: holder.runId }));
  });

  it("discovers a successor after the checked hook disappears, but does not resend an ambiguous wake", async () => {
    const current = run("running", new Date(now - 10_000).toISOString());
    const holder = { runId: current.runId, sessionId: current.runId };
    const hook = { runId: holder.runId, hookId: "old-hook" };
    h.row.mockResolvedValue(current);
    h.hook.mockResolvedValue(hook);
    h.resume.mockRejectedValueOnce(Object.assign(new Error("replaced"), { name: "HookNotFoundError" }));
    const successor = run("running", new Date(now).toISOString());
    h.list.mockResolvedValue({ data: [successor] });
    await expect(ensureDialogueOrchestratorStep(request(), holder)).resolves.toMatchObject({ runId: successor.runId, reused: true });
    expect(h.wake).toHaveBeenCalledTimes(1);
    expect(h.wake).toHaveBeenCalledWith(expect.objectContaining({ runId: successor.runId }));
    h.list.mockClear();
    h.wake.mockClear();
    h.resume.mockRejectedValueOnce(new Error("queue unavailable"));
    await expect(ensureDialogueOrchestratorStep(request(), holder)).rejects.toThrow("queue unavailable");
    expect(h.list).not.toHaveBeenCalled();
    expect(h.wake).not.toHaveBeenCalled();
    expect(h.start).not.toHaveBeenCalled();
  });
  it("paginates by entry point and observes changed or newly arrived runs on each read", async () => {
    const turn = "workflow//./src/app/api/chat/turn-workflow//turnWorkflow";
    const actor = "workflow//./src/app/api/chat/dialogue-orchestrator-workflow//dialogueOrchestratorWorkflow";
    const historical = { runId: "old", status: "running", createdAt: new Date(now - 1000), attributes: {
      scope: "other", role: "thinking", turn: "old-input", delivery: "orchestrator",
    } };
    const recent = { ...historical, runId: "new", status: "pending", createdAt: new Date(now), attributes: {
      ...historical.attributes, scope: "scope", turn: "new-input",
    } };
    const firstPage = [historical];
    h.list.mockImplementation(async ({ workflowName, pagination: { cursor } }) => {
      if (workflowName === actor) return { data: [run("running", new Date(now).toISOString())] };
      if (workflowName !== turn) throw new Error("Unscoped registry enumeration");
      return cursor ? { data: [historical] } : { data: firstPage, cursor: "older", hasMore: true };
    });
    expect((await readDialogueWorldStep("scope")).works).toEqual([]);
    historical.attributes.scope = "scope";
    historical.status = "completed";
    firstPage.splice(0, 1, recent);
    const next = await readDialogueWorldStep("scope");
    expect(next.works.map(work => [work.runId, work.status])).toEqual([["new", "pending"], ["old", "completed"]]);
    expect(next.dialogueRuns).toHaveLength(1);
    h.list.mockClear();
    expect(await readWorkSnapshotStep("scope", "old-input")).toMatchObject({ workId: "old-input" });
    expect(h.list.mock.calls.map(([params]) => [params.workflowName, params.pagination.cursor])).toEqual([
      [turn, undefined], [turn, "older"],
    ]);
  });

  it("retains historical IDs when a compiler assigns new entry point IDs", async () => {
    const oldTurn = "workflow//./src/app/api/chat/turn-workflow//turnWorkflow";
    const oldActor = "workflow//./src/app/api/chat/dialogue-orchestrator-workflow//dialogueOrchestratorWorkflow";
    Object.assign(h.turn, { workflowId: "new-turn-id" });
    Object.assign(h.workflow, { workflowId: "new-actor-id" });
    try {
      await readDialogueWorldStep("scope");
      expect(h.list.mock.calls.map(([params]) => params.workflowName).sort()).toEqual([
        oldTurn, oldActor, "new-turn-id", "new-actor-id",
      ].sort());
    } finally {
      Reflect.deleteProperty(h.turn, "workflowId");
      Reflect.deleteProperty(h.workflow, "workflowId");
    }
  });

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

  it("starts a new session once the original session window expires", async () => {
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

  it("starts the next session without cancelling its idle predecessor", async () => {
    const existing = run("running", new Date(now - 31 * 60_000).toISOString());
    h.list.mockResolvedValue({ data: [existing] });
    const cancel = vi.fn(async () => {});
    h.getRun.mockImplementation(() => ({
      status: Promise.resolve("cancelled"), cancel,
      getReadable: () => readable([{ data: { type: "exit_intent", keys: [], at: existing.createdAt } }]),
    }));
    await expect(ensureDialogueOrchestratorStep(request())).resolves.toMatchObject({ runId: "run-new", sessionId: "run-new" });
    expect(cancel).not.toHaveBeenCalled();
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

it("admits thinking without replaying completed history or starting a public actor", async () => {
  const active = { runId: "peer", status: "running", createdAt: new Date(now).toISOString(),
    attributes: { role: "thinking", scope: "scope", turn: "sibling", work: "work-sibling" } };
  h.list.mockImplementation(async ({ status }) => {
    expect(["running", "pending"]).toContain(status);
    return { data: status === "running" ? [active, { ...active, runId: "private-peer",
      attributes: { ...active.attributes, scope: "unrelated" } }] : [], hasMore: false };
  });
  h.hook.mockRejectedValueOnce(Object.assign(new Error("no holder"), { name: "HookNotFoundError" }));
  const admitted = await readDialogueAdmissionStep("scope", "this-input");
  expect(admitted.otherWorks).toMatchObject([{ runId: "peer", workId: "work-sibling" }]);
  expect(h.events.mock.calls.map(([id]) => id)).toEqual(["peer"]);
  expect(h.start).not.toHaveBeenCalled();
});
