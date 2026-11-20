import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DialogueInput, PublicUtterance } from "@/lib/chat/dialogue-contract";
import type { DialogueOfferEvent } from "@/lib/dialogue/transport";
import type { DialogueWorldSnapshot } from "@/app/api/chat/dialogue-orchestrator-steps";

const h = vi.hoisted(() => ({
  world: null as unknown as DialogueWorldSnapshot,
  published: [] as PublicUtterance[],
  prompts: [] as Array<{ checkpoint: boolean; prompt: string }>,
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
  recordDialogueUtteranceStep: vi.fn(async () => {}),
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
  writeDialogueRuntimeEventStep: vi.fn(async () => {}),
  prepareDialogueOfferStep: vi.fn(async (input) => ({
    artifacts: [],
    prompt: JSON.stringify({ stage: input.stage, text: input.text }),
    superseded: false,
  })),
  publishDialogueResultStep: vi.fn(async ({ input, text }) => {
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
    stream: async ({ prompt }: { prompt: string }) => {
      h.prompts.push({ checkpoint, prompt });
      const parsed = JSON.parse(prompt) as { text: string };
      return { text: `公开：${parsed.text}` };
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
});
