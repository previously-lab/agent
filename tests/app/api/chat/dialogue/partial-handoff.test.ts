import { beforeEach, describe, expect, it, vi } from "vitest";
import { createThinkingReadReceipt, wrapThinkingRead } from "@/lib/agents/thinking-read-receipt";
import type { ToolCall } from "@/lib/deepseek/types";
import { createPartialHandoff } from "@/app/api/agent/partial-handoff";
import { partialHandoffWorkflow } from "@/app/api/agent/partial-handoff-workflow";
import type { PartialHandoffPassages } from "@/app/api/agent/partial-handoff-steps";
import type { DialogueParentWritable } from "@/lib/dialogue/transport";
import type { ToolContext } from "@/app/api/agent/tool-executors";

const h = vi.hoisted(() => ({ assess: vi.fn(), publish: vi.fn(), launch: vi.fn(), open: vi.fn() }));
vi.mock("@/lib/deepseek/steps", () => ({ callModelStep: h.assess }));
vi.mock("@/app/api/agent/tool-executors", () => ({ workCheckpointExecute: h.publish }));
vi.mock("@/app/api/agent/partial-handoff-steps", () => ({ startPartialHandoffStep: h.launch, partialHandoffOpenStep: h.open }));

const context = { readScopeId: "test", currentUserText: "Which book and which room?", sliceId: "test-slice",
  dialogueOffer: { priorContext: [] } } as unknown as ToolContext;
const sentence = "The signed programme names Glass Rivers as the book.";
const call = (toolName: string, toolCallId: string): ToolCall => ({ toolName, toolCallId, input: {} });
const read = call("recallSearch", "first-read");
const later = [call("recallRead", "next-read")];
const receipt = createThinkingReadReceipt("test", read.toolCallId, [{ ref: "events/Book club", sourceKind: "semantic_document",
  edition: "current", revision: "a".repeat(64), asOf: "2026-11-21T00:00:00Z", coverage: "excerpt",
  excerpt: sentence, partialEvidenceEligible: true }]);
const previous = { toolCalls: [read], toolResults: [{ ...read, output: wrapThinkingRead(receipt, "private navigation details") }] };
const judged = { message: { content: JSON.stringify([
  { question: "Which book?", directAnswer: "Glass Rivers", verbatimEvidence: sentence },
  { question: "Which room?", directAnswer: null, verbatimEvidence: null },
]) }, finishReason: "stop" };

const writer: DialogueParentWritable = new WritableStream();
let child: Promise<void> | undefined;
beforeEach(() => {
  child = undefined;
  h.assess.mockReset(); h.publish.mockReset(); h.open.mockReset().mockResolvedValue(true);
  h.launch.mockReset().mockImplementation(async (ctx: ToolContext, passages: PartialHandoffPassages) => {
    child = partialHandoffWorkflow(ctx, passages, writer);
  });
});

describe("partial answers during an ongoing native investigation", () => {
  it("hands off one verified finding concurrently with a subsequent lookup", async () => {
    const task = createPartialHandoff(context);
    h.assess.mockResolvedValue(judged);
    expect(task.onBatch(later, previous)).toBeUndefined();
    task.onBatch(later, previous);
    await task.settled();
    await child;
    expect(h.assess).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(h.assess.mock.calls[0])).not.toContain("private navigation");
    expect(h.publish).toHaveBeenCalledTimes(1);
    expect(h.publish).toHaveBeenCalledWith({ text: expect.stringContaining(sentence) },
      { context: expect.objectContaining({ currentUserText: context.currentUserText }), toolCallId: "host-partial-evidence", messages: [] }, writer);
  });

  it("preserves a new answer that shares a name with an unrelated older reply", async () => {
    const task = createPartialHandoff({ ...context, dialogueOffer: { ...context.dialogueOffer!,
      priorContext: [{ role: "assistant", text: "Glass Rivers is also the name of a print studio." }] } });
    h.assess.mockResolvedValue(judged);
    task.onBatch(later, previous);
    await task.settled();
    await child;
    expect(h.publish).toHaveBeenCalledTimes(1);
  });

  it.each(["completeWork", "workCheckpoint", "finishThinking", "workflow stop"])("suppresses late extraction after %s", async kind => {
    const task = createPartialHandoff(context);
    let release!: (value: typeof judged) => void;
    h.assess.mockReturnValue(new Promise(resolve => { release = resolve; }));
    task.onBatch(later, previous);
    await task.settled(); // Only the launch was awaited, despite a parked provider call.
    if (kind === "workflow stop") task.close();
    else task.onBatch([call(kind, "end")]);
    h.open.mockResolvedValue(false); // Parent stream now contains a handoff, or the parent is terminal.
    release(judged);
    await child;
    expect(h.publish).not.toHaveBeenCalled();
  });

  it("makes no assessment on first lookup, instant final, explicit updates, or unpaired evidence", () => {
    const task = createPartialHandoff(context);
    task.onBatch(later);
    task.onBatch(later, { ...previous, toolCalls: [] });
    for (const name of ["workCheckpoint", "completeWork", "finishThinking"]) {
      createPartialHandoff(context).onBatch([...later, call(name, "normal")], previous);
    }
    expect(h.launch).not.toHaveBeenCalled();
  });

  it("lets primary work continue through a failed or truncated optional model call", async () => {
    h.assess.mockRejectedValueOnce(new Error("provider busy")).mockResolvedValueOnce({ ...judged, finishReason: "length" });
    for (let attempt = 0; attempt < 2; attempt++) {
      const task = createPartialHandoff(context);
      task.onBatch(later, previous);
      await expect(task.settled()).resolves.toBeUndefined();
      await child;
    }
    expect(h.publish).not.toHaveBeenCalled();
  });
});
