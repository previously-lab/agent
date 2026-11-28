import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DialogueOfferContext } from "@/lib/dialogue/transport";
import type { WorkSnapshot } from "@/lib/dialogue/work-contract";
import { fromNativeAssistant } from "@/lib/deepseek/messages";

const h = vi.hoisted(() => ({
  publish: vi.fn(async (_update: unknown) => {}),
  ensure: vi.fn(async () => ({ runId: "wrun_ORCHESTRATOR", reused: false })),
  reconcile: vi.fn(),
  snapshot: vi.fn(),
}));
vi.mock("workflow/api", () => ({ start: vi.fn(), getRun: vi.fn() }));
vi.mock("@/app/api/chat/dialogue-transport-steps", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/app/api/chat/dialogue-transport-steps")>()),
  publishWorkUpdateStep: h.publish,
  reconcileDialogueOffersStep: h.reconcile,
}));
vi.mock("@/app/api/chat/dialogue-orchestrator-steps", () => ({
  ensureDialogueOrchestratorStep: h.ensure,
  readWorkSnapshotStep: h.snapshot,
}));

import { completeWorkExecute, workCheckpointExecute, readWorkSnapshotExecute, type ToolContext } from "@/app/api/agent/tool-executors";
import { prepareDialogueOfferStep } from "@/app/api/chat/dialogue-transport-steps";

const dialogueOffer: DialogueOfferContext = {
  scopeKey: "scope-1", parentRunId: "wrun_A", workId: "work-B", sourceInputId: "input-B", sourceTurnId: "input-B",
  source: { inputId: "input-B", clientMessageId: "message-B", userSeq: 2, eventSeq: 2,
    acceptedAt: "2026-11-16T00:00:01.000Z", text: "百度现在市值多少" },
  priorContext: [], locale: "zh",
  record: { useGithub: false, useDemo: false, owner: "local", repo: "local", timezone: "Asia/Shanghai",
    slicing: { idleGapMinutes: 30, maxSliceMinutes: 60, maxTurnsPerSlice: 40 } },
};
function ctx(): ToolContext {
  return { repo: "local", owner: "local", useGithub: false, useDemo: false,
    sliceId: "slice", turnId: "input-B", readScopeId: "work-B", currentUserText: "百度现在市值多少",
    recentTurns: [], dialogueOffer,
  };
}

describe("work-only handoff", () => {
  beforeEach(() => vi.clearAllMocks());

  it("writes a completion with its relation, response mode and native artifact, not public wording", async () => {
    const html = "<!doctype html><html><body>Chart</body></html>\n";
    const result = await completeWorkExecute({
      result: `市值需要实时查询。\n\n\`\`\`html live\n${html}\`\`\`\n`,
      relation: "related", dependsOnInputIds: ["input-A"], responseMode: "research",
    }, { context: ctx(), toolCallId: "call-final", messages: [] });
    expect(result).toMatchObject({ ok: true, kind: "work-update", updateId: "work-B:call-final", sourceInputId: "input-B" });
    expect(h.publish).toHaveBeenCalledWith(expect.objectContaining({
      type: "work_completed", updateId: "work-B:call-final", workId: "work-B", sourceInputId: "input-B",
      relation: "related", dependsOnInputIds: ["input-A"], responseMode: "research",
    }));
    expect((h.publish.mock.calls[0]![0] as { text: string }).text).toContain(html);
    const prepared = await prepareDialogueOfferStep({
      offerId: "work-B:call-final", publicSeq: 1, text: (h.publish.mock.calls[0]![0] as { text: string }).text,
      responseMode: "research", context: dialogueOffer, stage: "final", direct: true,
    }, "wrun_ACTOR");
    expect(prepared.artifacts).toHaveLength(1);
    expect(prepared.artifacts[0]!.body).toBe(html);
    expect(prepared.artifacts[0]!.artifact.kind).toBe("native_html");
    expect(prepared.prompt).not.toContain("<html>");
    expect(JSON.parse(prepared.prompt).currentTaskContract).toMatchObject({ responseMode: "research" });
    expect(h.publish.mock.invocationCallOrder[0]).toBeLessThan(h.ensure.mock.invocationCallOrder[0]);
  });

  it("defaults a legacy completion to focused and rejects an invalid mode", async () => {
    await completeWorkExecute({ result: "你好" }, { context: ctx(), toolCallId: "call-chat", messages: [] });
    expect(h.publish).toHaveBeenCalledWith(expect.objectContaining({ responseMode: "focused" }));
    h.publish.mockClear();
    const result = await completeWorkExecute({ result: "无效", responseMode: "takeover" as never },
      { context: ctx(), toolCallId: "call-invalid", messages: [] });
    expect(result).toMatchObject({ ok: false, reason: "Invalid response mode." });
    expect(h.publish).not.toHaveBeenCalled();
  });

  it("uses the initial Actor receipt only after the checkpoint or final is durable", async () => {
    const holder = { runId: "wrun_ORCHESTRATOR", sessionId: "session" };
    const context = { ...ctx(), dialogueOffer: { ...dialogueOffer, holder } };
    await workCheckpointExecute({ text: "progress" }, { context, toolCallId: "progress", messages: [] });
    await completeWorkExecute({ result: "done" }, { context, toolCallId: "final", messages: [] });
    for (const [index, key] of ["work-B:progress", "work-B:final"].entries()) {
      expect(h.ensure).toHaveBeenNthCalledWith(index + 1, expect.objectContaining({ triggerKey: key, candidateKeys: [key] }), holder);
      expect(h.publish.mock.invocationCallOrder[index]).toBeLessThan(h.ensure.mock.invocationCallOrder[index]!);
    }
  });

  it("redelivers the original committed work ID after an activation failure", async () => {
    h.ensure.mockRejectedValueOnce(new Error("queue acknowledgement lost"));
    const options = { context: ctx(), toolCallId: "final", messages: [] };
    await expect(completeWorkExecute({ result: "done" }, options)).rejects.toThrow("queue acknowledgement lost");
    await expect(completeWorkExecute({ result: "done" }, options))
      .resolves.toMatchObject({ ok: true, kind: "work-update", updateId: "work-B:final", sourceInputId: "input-B" });
    expect(h.ensure).toHaveBeenCalledTimes(2);
    expect(h.publish).toHaveBeenCalledTimes(2);
  });

  it("reconciles a lost work-append acknowledgement before sending its wake", async () => {
    h.publish.mockRejectedValueOnce(new Error("ack lost")).mockRejectedValueOnce(new Error("no append"));
    h.reconcile.mockResolvedValueOnce([{ offerId: "work-B:done", stage: "final", parentRunId: "wrun_A",
      workId: "work-B", sourceInputId: "input-B" }]).mockResolvedValueOnce([]);
    await expect(completeWorkExecute({ result: "done" }, { context: ctx(), toolCallId: "done", messages: [] }))
      .resolves.toMatchObject({ ok: true, runId: "wrun_ORCHESTRATOR" });
    await expect(completeWorkExecute({ result: "missing" }, { context: ctx(), toolCallId: "absent", messages: [] }))
      .rejects.toThrow("no append");
    expect(h.ensure).toHaveBeenCalledTimes(1);
    expect(h.publish).toHaveBeenCalledTimes(2);
  });

  it("redelivers the same final ID when the append acknowledgement and reconciliation both fail", async () => {
    const committed = new Set<string>();
    h.publish.mockImplementationOnce(async update => {
      committed.add((update as { updateId: string }).updateId);
      throw new Error("Acknowledgement lost");
    }).mockImplementationOnce(async update => { committed.add((update as { updateId: string }).updateId); });
    h.reconcile.mockRejectedValueOnce(new Error("Cannot read the complete stream"));
    const opts = { context: ctx(), toolCallId: "final", messages: [] };
    await expect(completeWorkExecute({ result: "done" }, opts)).rejects.toThrow("Cannot read the complete stream");
    expect(h.ensure).not.toHaveBeenCalled();
    await expect(completeWorkExecute({ result: "done" }, opts)).resolves.toMatchObject({ ok: true, updateId: "work-B:final" });
    expect([...committed]).toEqual(["work-B:final"]);
    expect(h.ensure).toHaveBeenCalledOnce();
  });

  it("records a progress checkpoint without a public offer", async () => {
    const input = { text: "只查当前市值，不重复成立时间", relation: "related" as const, dependsOnInputIds: ["input-A"] };
    const checkpoint = { id: "call-progress", type: "function" as const,
      function: { name: "workCheckpoint", arguments: JSON.stringify(input) } };
    const message = fromNativeAssistant({ role: "assistant", content: null, tool_calls: [checkpoint] });
    const result = await workCheckpointExecute(input,
      { context: ctx(), toolCallId: checkpoint.id, messages: [message] });
    expect(result.ok).toBe(true);
    expect(h.publish).toHaveBeenCalledWith(expect.objectContaining({
      type: "work_checkpoint", relation: "related", dependsOnInputIds: ["input-A"],
    }));

    const parallel = fromNativeAssistant({ role: "assistant", content: null, tool_calls: [
      checkpoint, { id: "final", type: "function", function: { name: "completeWork", arguments: "{}" } },
    ] });
    expect(await workCheckpointExecute(input, { context: ctx(), toolCallId: checkpoint.id, messages: [parallel] }))
      .toMatchObject({ ok: false, reason: "The final result in this step replaces this checkpoint." });
    expect(h.publish).toHaveBeenCalledTimes(1);
  });

  it("reads another work's public snapshot by Workflow scope", async () => {
    const snapshot: WorkSnapshot = {
      workId: "work-A", inputId: "input-A", runId: "wrun_A", status: "running",
      acceptedAt: "2026-11-16T00:00:00.000Z", latestStage: "checkpoint",
      publicHandoffs: [{ updateId: "progress", stage: "checkpoint", text: "正在核对成立时间", at: "2026-11-16T00:00:01.000Z" }],
      updatedAt: "2026-11-16T00:00:01.000Z",
    };
    h.snapshot.mockResolvedValue(snapshot);
    const result = await readWorkSnapshotExecute({ workId: "work-A" }, { context: ctx(), toolCallId: "read-A", messages: [] });
    expect(result).toEqual({ snapshot });
    expect(h.snapshot).toHaveBeenCalledWith("scope-1", "work-A");
    expect(JSON.stringify(result)).not.toContain("private reasoning");
  });
});
