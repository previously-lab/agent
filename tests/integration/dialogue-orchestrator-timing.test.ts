import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DialogueInput, PublicUtterance } from "@/lib/chat/dialogue-contract";
import type { DialogueOfferEvent } from "@/lib/dialogue/transport";
import type { DialogueWorldSnapshot } from "@/app/api/chat/dialogue-orchestrator-steps";
import type { DialogueRuntimeEvent } from "@/lib/dialogue/coordination";

const h = vi.hoisted(() => ({
  world: null as unknown as DialogueWorldSnapshot,
  published: [] as PublicUtterance[],
  prompts: [] as Array<{ checkpoint: boolean; prompt: string }>,
  wording: vi.fn(),
  archive: vi.fn(),
  prepare: vi.fn(),
  beforePublish: vi.fn(),
  runtime: vi.fn(),
}));

vi.mock("workflow", () => ({
  getWritable: vi.fn(() => ({})),
  sleep: vi.fn(async () => {}),
  createHook: vi.fn(() => ({
    getConflict: vi.fn(async () => null), dispose: vi.fn(),
    [Symbol.asyncIterator]: () => ({ next: vi.fn(async () => ({ done: true, value: undefined })) }),
  })),
}));
vi.mock("@/app/api/chat/dialogue-orchestrator-steps", () => ({
  readDialogueWorldStep: vi.fn(async () => h.world),
  recordDialogueUtteranceStep: h.archive,
  stoppedDialogueParentsStep: async () => ["thought-A"],
  stampDialogueTriggerStep: vi.fn(async () => {}),
  cancelDialogueRunStep: vi.fn(async () => {}),
  continueDialogueOrchestratorStep: vi.fn(async () => "wrun_SUCCESSOR"),
  waitForDialogueRunTerminalStep: vi.fn(async () => "completed"),
}));
vi.mock("@/app/api/chat/dialogue-transport-steps", () => ({
  dialogueOwnRunIdStep: vi.fn(async () => "wrun_ORCHESTRATOR"),
  openDialogueStreamStep: vi.fn(async () => {}),
  closeDialogueRunStreamStep: vi.fn(async () => {}),
  completeDialogueLapStep: vi.fn(async () => {}),
  writeDialogueRuntimeEventStep: h.runtime,
  prepareDialogueOfferStep: h.prepare,
  publishDialogueResultStep: vi.fn(async ({ input, text }) => {
    if (h.beforePublish(input) === false) return undefined;
    const utterance: PublicUtterance = {
      utteranceId: input.offerId,
      publicSeq: input.publicSeq,
      committedAt: "2026-11-15T00:00:00.000Z",
      inputIds: input.publicationInputIds ?? [input.context.sourceInputId],
      sourceResults: input.publicationSourceResults ?? [{ resultId: input.offerId, productRevision: 1, claimIds: [] }],
      phase: input.stage === "checkpoint" ? "commentary" : "final_answer",
      blocks: [{ kind: "markdown", blockId: `${input.offerId}:text`, text }],
    };
    h.published.push(utterance);
    h.world.publications.push(utterance);
    return utterance;
  }),
}));
vi.mock("@/app/api/agent/agent", () => ({
  createDialogueAgent: (checkpoint: boolean) => ({
    stream: async ({ prompt, onStepEnd }: { prompt: string; onStepEnd?: (step: { text: string }) => void }) => {
      h.prompts.push({ checkpoint, prompt });
      const source = prompt.startsWith("{") ? (JSON.parse(prompt) as { text: string }).text : prompt;
      return h.wording(source, onStepEnd);
    },
  }),
}));

import { dialogueOrchestratorWorkflow } from "@/app/api/chat/dialogue-orchestrator-workflow";

function input(id: string): DialogueInput {
  return {
    inputId: id, clientMessageId: `message-${id}`, userSeq: 1, eventSeq: 1,
    acceptedAt: "2026-11-15T00:00:00.000Z", text: `Question ${id}`,
  };
}

function offer(id: string, inputId: string, stage: "checkpoint" | "final"): DialogueOfferEvent {
  return {
    type: "offer", offerId: id, runId: "wrun_ORCHESTRATOR", parentRunId: `thought-${inputId}`,
    sourceInputId: inputId, workId: `work-${inputId}`, stage, publicSeq: 1,
    text: id, locale: "zh",
    record: {
      useGithub: false, useDemo: false, owner: "local", repo: "local", timezone: "UTC",
      slicing: { idleGapMinutes: 30, maxSliceMinutes: 30, maxTurnsPerSlice: 50 },
    },
  };
}

function world(inputs: DialogueInput[], offers: DialogueOfferEvent[]): DialogueWorldSnapshot {
  return {
    scope: "scope",
    works: offers.map(offer => ({ runId: offer.parentRunId, workId: offer.workId!, inputId: offer.sourceInputId, status: "running" })),
    inputs,
    starts: [],
    dialogueRuns: [],
    wakes: [],
    offers,
    publications: [],
  };
}

describe("dialogue orchestrator timed activation", () => {
  beforeEach(() => {
    h.published = [];
    h.prompts = [];
    h.runtime.mockReset();
    h.archive.mockReset();
    h.beforePublish.mockReset();
    h.prepare.mockReset().mockImplementation(async input => ({ artifacts: [],
      prompt: JSON.stringify({ stage: input.stage, text: input.text }), superseded: false }));
    h.wording.mockReset().mockImplementation((text: string) => ({ text: `公开：${text}`, finishReason: "stop" }));
  });

  it("publishes new work on activation, exits when idle, then starts for a final", async () => {
    h.world = world([input("input-A")], [offer("A-opening", "input-A", "checkpoint")]);
    const first = await dialogueOrchestratorWorkflow({ scope: "scope" });
    expect(first.status).toBe("idle");
    expect(h.published.map(item => item.phase)).toEqual(["commentary"]);

    // No new information: the run has already exited instead of polling.
    expect(h.prompts).toHaveLength(1);

    // The next activation reads the final offer from the Workflow world.
    h.world.offers.push(offer("A-final", "input-A", "final"));
    const second = await dialogueOrchestratorWorkflow({ scope: "scope" });
    expect(second.status).toBe("idle");
    expect(h.published.map(item => item.phase)).toEqual(["commentary", "final_answer"]);
    expect(h.published[1]?.blocks.flatMap(block => block.kind === "markdown" ? [block.text] : [])).toEqual(["公开：A-final"]);
  });

  it("handles B before A without replaying A or losing either input", async () => {
    h.world = world([input("input-A"), input("input-B")], [offer("A-opening", "input-A", "checkpoint")]);
    await dialogueOrchestratorWorkflow({ scope: "scope" });
    h.world.offers.push(offer("B-final", "input-B", "final"));
    await dialogueOrchestratorWorkflow({ scope: "scope" });
    h.world.offers.push(offer("A-final", "input-A", "final"));
    await dialogueOrchestratorWorkflow({ scope: "scope" });
    expect(h.published.map(item => [item.phase, item.inputIds[0]])).toEqual([
      ["commentary", "input-A"],
      ["final_answer", "input-B"],
      ["final_answer", "input-A"],
    ]);
  });

  it("does not merge final results from independent inputs into one utterance", async () => {
    h.world = world([input("input-A"), input("input-B")], [
      offer("A-final", "input-A", "final"),
      offer("B-final", "input-B", "final"),
    ]);
    await dialogueOrchestratorWorkflow({ scope: "scope" });
    expect(h.published.map(item => item.inputIds)).toEqual([["input-A"], ["input-B"]]);
    expect(h.prompts).toHaveLength(2);
  });

  it("suppresses an unpublished checkpoint when final is already available", async () => {
    h.world = world([input("input-A")], [
      offer("A-opening", "input-A", "checkpoint"),
      offer("A-final", "input-A", "final"),
    ]);
    await dialogueOrchestratorWorkflow({ scope: "scope" });
    expect(h.published.map(item => item.phase)).toEqual(["final_answer"]);
  });

  it("consumes a redundant checkpoint once, then publishes a new finding and the final answer", async () => {
    const redundant = offer("same-finding", "input-A", "checkpoint");
    h.world = world([input("input-A")], [redundant]);
    h.wording.mockReturnValueOnce({ text: "", finishReason: "stop" });
    expect(await dialogueOrchestratorWorkflow({ scope: "scope" })).toMatchObject({ status: "idle" });
    expect(h.published).toHaveLength(0);
    expect(h.wording).toHaveBeenCalledTimes(1);
    const events: DialogueRuntimeEvent[] = h.runtime.mock.calls.map(([event]) => event);
    expect(events).toContainEqual(expect.objectContaining({
      type: "expression_outcome", status: "intentionally_silent", candidateIds: ["same-finding"],
    }));
    h.world.dialogueRuns.push({ runId: "previous-actor", sessionId: "session", createdAt: "2026-11-15T00:00:00Z",
      status: "completed", events });
    h.world.offers.push(offer("new-finding", "input-A", "checkpoint"));
    await dialogueOrchestratorWorkflow({ scope: "scope" });
    h.world.offers.push(offer("answer", "input-A", "final"));
    await dialogueOrchestratorWorkflow({ scope: "scope" });
    expect(h.wording.mock.calls.map(([text]) => text)).toEqual(["same-finding", "new-finding", "answer"]);
    expect(h.published.map(item => item.phase)).toEqual(["commentary", "final_answer"]);
  });

  it.each(["", "The workshop was moved to"])("retries truncated interim wording without publishing its fragment", async text => {
    h.world = world([input("input-A")], [offer("finding", "input-A", "checkpoint")]);
    h.wording.mockReturnValueOnce({ text, finishReason: "length" }).mockReturnValueOnce({ text: text ? " noon." : "公开：finding", finishReason: "stop" });
    await dialogueOrchestratorWorkflow({ scope: "scope" });
    expect(h.wording).toHaveBeenCalledTimes(2);
    expect(h.published.map(item => item.phase)).toEqual(["commentary"]);
    expect(h.published[0]?.blocks[0]).toMatchObject({ text: text ? text + " noon." : "公开：finding" });
  });

  it.each(["error", "length"])("publishes only the completed retry when final wording ends with %s", async reason => {
    h.world = world([input("input-A")], [offer("answer", "input-A", "final")]);
    h.wording.mockImplementationOnce((_text: string, onStepEnd?: (step: { text: string }) => void) => {
      const fragment = "The result is";
      onStepEnd?.({ text: fragment });
      if (reason === "error") throw new Error("Stream interrupted");
      return { text: fragment, finishReason: reason };
    }).mockReturnValueOnce({ text: reason === "length" ? " verified." : "公开：answer", finishReason: "stop" });
    expect(await dialogueOrchestratorWorkflow({ scope: "scope" })).toMatchObject({ status: "idle" });
    expect(h.wording).toHaveBeenCalledTimes(2);
    expect(h.published).toHaveLength(1);
    expect(h.published[0]?.blocks[0]).toMatchObject({ text: reason === "length" ? "The result is verified." : "公开：answer" });
  });
  it.each([
    { error: new Error('step failed: DeepSeek request failed (402)'), retryable: false },
    { error: Object.assign(new Error('quota exhausted'), { statusCode: 429 }), retryable: false },
    { error: Object.assign(new Error('busy'), { statusCode: 429 }), retryable: true },
    { error: Object.assign(new Error('gateway timeout'), { statusCode: 504 }), retryable: true },
  ])("distinguishes a failed provider request in the published outcome", async ({ error, retryable }) => {
    h.world = world([input("input-A")], [offer("answer", "input-A", "final")]);
    h.wording.mockRejectedValue(error);
    await expect(dialogueOrchestratorWorkflow({ scope: "scope" })).resolves.toMatchObject({ status: "failed" });
    expect(h.wording).toHaveBeenCalledTimes(retryable ? 2 : 1);
    expect(h.runtime).toHaveBeenCalledWith(expect.objectContaining({ type: "expression_outcome", status: "failed", retryable }));
  });

  it("still publishes B when A stops after wording started for both", async () => {
    const a = offer("A-final", "A", "final");
    a.aggregateInputIds = ["A", "B"];
    h.world = world([input("A"), input("B")], [a, offer("B-final", "B", "final")]);
    h.beforePublish.mockImplementationOnce(() => {
      h.world.works.find(work => work.inputId === "A")!.status = "cancelled";
      return false;
    });
    await dialogueOrchestratorWorkflow({ scope: "scope" });
    expect(h.published.map(item => item.inputIds)).toEqual([["B"]]);
    expect(h.archive).toHaveBeenCalledTimes(1);
  });

  it("retries the archive enqueue without repeating a public answer or changing its outcome", async () => {
    h.world = world([input("input-A")], [offer("answer", "input-A", "final")]);
    h.archive.mockRejectedValueOnce(new Error("queue unavailable")).mockResolvedValueOnce(undefined);
    await dialogueOrchestratorWorkflow({ scope: "scope" });
    expect(h.archive).toHaveBeenCalledTimes(2);
    expect(h.published).toHaveLength(1);
    expect(h.wording).toHaveBeenCalledTimes(1);
    expect(h.runtime.mock.calls.some(([e]) => e.status === "failed")).toBe(false);
  });

  it("remembers what it already said on this input across intervening unrelated replies", async () => {
    h.world = world([input("A")], [offer("A-checkpoint", "A", "checkpoint")]);
    await dialogueOrchestratorWorkflow({ scope: "scope" });
    const checkpoint = h.published[0]!;
    for (let i = 0; i < 15; i++) h.world.publications.push({ ...checkpoint, utteranceId: "other-" + i, inputIds: ["other-" + i] });
    h.world.offers.push(offer("A-final", "A", "final"));
    await dialogueOrchestratorWorkflow({ scope: "scope" });
    expect(h.prepare.mock.lastCall![0].orchestration.publications).toEqual([checkpoint]);
  });

});
