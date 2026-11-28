import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DialogueOfferContext, DialogueWakeEvent } from "@/lib/dialogue/transport";
import type { WorkUpdateEvent } from "@/lib/dialogue/work-contract";

const h = vi.hoisted(() => ({ rows: vi.fn(), row: vi.fn(), hook: vi.fn(), ownWritable: vi.fn(() => {
  throw new Error("The extraction child cannot write the parent's control events to its own stream");
}) }));
vi.mock("workflow", () => ({ getWritable: h.ownWritable }));
vi.mock("workflow/api", () => ({
  start: async () => ({ runId: "wrun_NEW" }), getHookByToken: h.hook,
  resumeHook: async () => ({ runId: "wrun_ACTOR" }),
  getRun: () => ({ getReadable: () => ({ getTailIndex: async () => -1 }) }),
}));
vi.mock("workflow/runtime", () => ({ getWorld: async () => ({ runs: { list: h.rows, get: h.row } }) }));
vi.mock("@/app/api/chat/turn-workflow", () => ({ turnWorkflow: vi.fn() }));
vi.mock("@/app/api/chat/dialogue-orchestrator-workflow", () => ({ dialogueOrchestratorWorkflow: vi.fn() }));

import { workCheckpointExecute, type ToolContext } from "@/app/api/agent/tool-executors";

describe("extraction child checkpoint handoff", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(["known", "discovered", "new"])("writes the update and handles %s Actor activation without direct notification", async branch => {
    const now = new Date().toISOString();
    const holder = { runId: "wrun_ACTOR", sessionId: "session" };
    const actor = { runId: holder.runId, createdAt: now, status: "running",
      attributes: { scope: "scope", role: "dialogueOrchestrator", session: holder.sessionId } };
    h.row.mockImplementation(async (id: string) => id === actor.runId && branch !== "new" ? actor : undefined);
    h.hook.mockResolvedValue({ runId: holder.runId, hookId: "hook" });
    h.rows.mockResolvedValue({ data: branch === "new" ? [] : [actor] });
    const dialogueOffer: DialogueOfferContext = {
      scopeKey: "scope", workId: "work-A", parentRunId: "wrun_PARENT", sourceInputId: "input-A", sourceTurnId: "input-A",
      source: { inputId: "input-A", clientMessageId: "input-A", acceptedAt: now, text: "Question", userSeq: 1, eventSeq: 1 },
      record: { useDemo: false, useGithub: false, repo: "local", owner: "local", timezone: "UTC",
        slicing: { maxSliceMinutes: 60, maxTurnsPerSlice: 15, idleGapMinutes: 15 } }, priorContext: [], locale: "en",
      ...(branch === "known" ? { holder } : {}),
    };
    const context: ToolContext = { dialogueOffer, repo: "local", owner: "local", useGithub: false, useDemo: false,
      sliceId: "slice", turnId: "input-A", readScopeId: "work-A", currentUserText: "Question", recentTurns: [] };
    const events: Array<WorkUpdateEvent | DialogueWakeEvent> = [];
    const parent = new WritableStream<WorkUpdateEvent | DialogueWakeEvent>({ write(event) { events.push(event); } });
    const result = await workCheckpointExecute({ text: "Tuesday." }, { context, toolCallId: "host-partial-evidence", messages: [] }, parent);
    const actorRunId = branch === "new" ? "wrun_NEW" : holder.runId;
    expect(result).toMatchObject({ ok: true, runId: actorRunId });
    expect(events[0]).toMatchObject(
      { type: "work_checkpoint", runId: "wrun_PARENT", updateId: "work-A:host-partial-evidence" },
    );
    if (branch === "new") {
      expect(events).toHaveLength(2);
      expect(events[1]).toMatchObject({ type: "dialogue_wake", parentRunId: "wrun_PARENT",
        runId: actorRunId, triggerKey: "work-A:host-partial-evidence" });
    } else {
      expect(events).toHaveLength(1);
    }
    expect(h.ownWritable).not.toHaveBeenCalled();
  });
});
