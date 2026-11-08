import { beforeEach, describe, expect, it, vi } from "vitest";
import { DIALOGUE_CHECKPOINT_NAMESPACE, type DialogueRunInput } from "@/lib/dialogue/transport";

const h = vi.hoisted(() => ({
  admission: vi.fn(),
  prepare: vi.fn(),
  open: vi.fn(),
  publish: vi.fn(),
  record: vi.fn(),
  close: vi.fn(),
  stream: vi.fn(),
  sleep: vi.fn(),
}));

vi.mock("workflow", () => ({ sleep: h.sleep, getWritable: (options?: { namespace?: string }) => options ?? {} }));
vi.mock("@/app/api/agent/agent", () => ({ createDialogueAgent: () => ({ stream: h.stream }) }));
vi.mock("@/app/api/chat/dialogue-transport-steps", () => ({
  dialogueOwnRunIdStep: async () => "wrun_01JTESTCHILD00000000000000",
  dialogueAdmissionStep: h.admission,
  prepareDialogueOfferStep: h.prepare,
  openDialogueStreamStep: h.open,
  publishDialogueResultStep: h.publish,
  startDialogueRecordRunStep: h.record,
  closeDialogueStreamStep: h.close,
  dialogueRecordRequest: (input: DialogueRunInput, utterance?: unknown) => ({
    source: input.context.source,
    sourceTurnId: input.context.sourceTurnId,
    environment: input.context.record,
    ...(utterance ? { utterance } : {}),
  }),
}));

import { dialogueWorkflow } from "@/app/api/chat/dialogue-workflow";

const input: DialogueRunInput = {
  offerId: "work:call",
  publicSeq: 1,
  text: "internal result",
  context: {
    parentRunId: "wrun_01JTESTPARENT0000000000000",
    workId: "work", sourceInputId: "input", sourceTurnId: "input",
    source: {
      inputId: "input", clientMessageId: "message", userSeq: 1, eventSeq: 1,
      acceptedAt: "2026-11-07T00:00:00.000Z", text: "question",
    },
    priorContext: [], locale: "zh",
    record: {
      useGithub: false, useDemo: false, owner: "local", repo: "local", timezone: "UTC",
      slicing: { idleGapMinutes: 30, maxSliceMinutes: 60, maxTurnsPerSlice: 40 },
    },
  },
};
const utterance = {
  utteranceId: "work:call", publicSeq: 1, committedAt: "2026-11-07T00:00:01.000Z",
  inputIds: ["input"], sourceResults: [], blocks: [{ kind: "markdown" as const, blockId: "reply", text: "可以。" }],
};

describe("dialogueWorkflow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.admission.mockResolvedValue("admitted");
    h.prepare.mockResolvedValue({ prompt: "bounded prompt", artifacts: [] });
    h.publish.mockResolvedValue(utterance);
    h.record.mockResolvedValue("wrun_01JTESTRECORD0000000000000");
    h.stream.mockImplementation(async (options: { onStepEnd?: (step: { text: string }) => void }) => {
      options.onStepEnd?.({ text: "可以。" });
      return { text: "可以。", toolCalls: [] };
    });
  });

  it("rejects duplicates before inference, publication, or summary", async () => {
    h.admission.mockResolvedValue("duplicate");
    const result = await dialogueWorkflow(input);
    expect(result.status).toBe("not_admitted");
    expect(h.stream).not.toHaveBeenCalled();
    expect(h.publish).not.toHaveBeenCalled();
    expect(h.record).not.toHaveBeenCalled();
    expect(h.close).not.toHaveBeenCalled();
  });

  it("streams the admitted reply and hands off the actual publication", async () => {
    const result = await dialogueWorkflow(input);
    expect(h.stream).toHaveBeenCalledWith(expect.objectContaining({ prompt: "bounded prompt" }));
    expect(h.publish).toHaveBeenCalledWith({ input, artifacts: [], text: "可以。" });
    expect(h.record).toHaveBeenCalledWith(expect.objectContaining({ utterance }));
    expect(h.close).toHaveBeenCalledWith({ offerId: "work:call", text: "可以。" });
    expect(h.close.mock.invocationCallOrder[0]).toBeLessThan(h.record.mock.invocationCallOrder[0]!);
    expect(result).toMatchObject({ status: "completed", utterance, recordRunId: "wrun_01JTESTRECORD0000000000000" });
  });

  it("does not suppress public output when the record handoff fails", async () => {
    h.record.mockRejectedValue(new Error("queue unavailable"));
    const result = await dialogueWorkflow(input);
    expect(h.publish).toHaveBeenCalledOnce();
    expect(h.close).toHaveBeenCalledWith({ offerId: "work:call", text: "可以。" });
    expect(result).toMatchObject({ status: "completed", utterance, recordError: "queue unavailable" });
  });

  it("preserves only the user draft when dialogue produces no reply", async () => {
    h.stream.mockResolvedValue({ text: "" });
    const result = await dialogueWorkflow(input);
    expect(h.publish).not.toHaveBeenCalled();
    expect(h.record).toHaveBeenCalledWith(expect.not.objectContaining({ utterance: expect.anything() }));
    expect(h.close).toHaveBeenCalledWith(expect.objectContaining({ error: "The dialogue ended without a public reply." }));
    expect(result.status).toBe("failed");
  });

  it("keeps a held checkpoint and its candidate prose out of the public transcript and record", async () => {
    h.stream.mockResolvedValue({ text: "uncommitted draft", toolCalls: [{ toolName: "holdReply" }] });
    const result = await dialogueWorkflow({ ...input, stage: "checkpoint" });
    expect(h.stream).toHaveBeenCalledWith(expect.objectContaining({
      writable: { namespace: DIALOGUE_CHECKPOINT_NAMESPACE },
    }));
    expect(h.publish).not.toHaveBeenCalled();
    expect(h.record).not.toHaveBeenCalled();
    expect(h.close).toHaveBeenCalledWith({ offerId: "work:call", text: "" });
    expect(result).toMatchObject({ status: "completed", held: true });
  });

  it("drops a draft superseded during checkpoint inference", async () => {
    h.publish.mockResolvedValue(undefined);
    const result = await dialogueWorkflow({ ...input, stage: "checkpoint" });
    expect(h.publish).toHaveBeenCalledOnce();
    expect(h.record).not.toHaveBeenCalled();
    expect(h.close).toHaveBeenCalledWith({ offerId: "work:call", text: "" });
    expect(result).toMatchObject({ status: "completed", held: true });
  });
});
