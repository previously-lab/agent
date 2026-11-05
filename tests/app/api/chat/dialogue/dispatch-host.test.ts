import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULTS } from "@/lib/config/defaults";
import { FIXED_MODEL } from "@/lib/models/registry";
import type { TurnInput } from "@/lib/chat/turn-types";
import type { ThinkingProduct } from "@/lib/agents/thinking-product";
import { createDialogueStore, type DialogueStore } from "@/lib/dialogue/store";
import { createLocalDialogueStorage } from "@/lib/dialogue/local";

const state = vi.hoisted(() => ({ store: undefined as unknown }));
const runner = vi.hoisted(() => ({
  startWork: vi.fn(),
  startExpression: vi.fn(),
  cancelRun: vi.fn(),
  runStatus: vi.fn(),
  project: vi.fn(),
  ringReflection: vi.fn(),
}));

vi.mock("@/lib/dialogue/runtime", () => ({
  DialogueUnavailable: class DialogueUnavailable extends Error {},
  getDialogueStore: () => state.store,
  // Prove the direct entry works in a serverless-like runtime without the
  // local process interval being eligible to start.
  sharedDialogueRuntime: () => true,
}));
vi.mock("@/app/api/chat/dialogue/runner", () => ({ serverDialogueRunner: runner }));

import { dispatchDialogueDueScopes } from "@/app/api/chat/dialogue/dispatch-host";

const scope = "dispatch-host-test";
const at = "2026-11-06T06:00:00.000Z";
const store = () => state.store as DialogueStore;

function launch(text: string): TurnInput {
  return {
    modelMessages: [], recentTurns: [], lastUserMessage: text, model: FIXED_MODEL.id, modelConfig: FIXED_MODEL,
    thinking: true, reasoningEffort: "low", clientTimezone: "UTC", locale: "en",
    config: DEFAULTS, owner: "local", repo: "local", useGithub: false, useDemo: false,
    startedAtIso: at, turnId: "provisional", imageAttachments: [],
  };
}

function completion(workId: string): Parameters<DialogueStore["completeWork"]>[1] {
  const product: ThinkingProduct = {
    version: 1, inputScope: { scopeKey: scope, workId, inputIds: [workId] },
    sourceRevision: null, asOf: at, status: "complete", readSet: [], dependencies: [], openQuestions: [],
    claims: [{ claimId: "c1", text: "A result.", kind: "interpretation", allowedPublicMode: "finding",
      evidenceIds: [], requiredReadRefs: [], missingReadRefs: [], adoptionEvidenceIds: [] }],
  };
  return {
    workId, runId: "run-1", sliceId: "2026-11-06-0600", product, blocks: [], status: "completed",
    claims: [{ claimId: "c1", text: "A result.", allowedPublicMode: "finding", evidence: [] }],
  };
}

describe("dialogue dispatch host entry", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(await realpath(tmpdir()), "aftrbrez-dispatch-host-")));
    state.store = createDialogueStore(createLocalDialogueStorage(dir));
    for (const mock of Object.values(runner)) mock.mockReset();
    runner.startWork.mockResolvedValue({ runId: "run-1" });
    runner.startExpression.mockResolvedValue("started");
    runner.runStatus.mockResolvedValue("live");
    runner.project.mockResolvedValue(null);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  it("is safe as a request after callback or Workflow step and resumes from disk without a resident scheduler", async () => {
    const interval = vi.spyOn(globalThis, "setInterval");
    const accepted = await store().accept(scope, { clientMessageId: "m1", launch: launch("Think now.") });

    // A request handler can hand this plain callback to Next after(). No
    // request context, CRON_SECRET or local interval is needed by the entry.
    const requestAfterCallback = () => dispatchDialogueDueScopes();
    await expect(requestAfterCallback()).resolves.toMatchObject({ scopes: 1, failed: 0 });
    expect(runner.startWork).toHaveBeenCalledTimes(1);

    // Simulate a cold serverless invocation: only the temporary directory
    // survives. The terminal Workflow step directly awaits the same entry.
    state.store = createDialogueStore(createLocalDialogueStorage(dir));
    await store().beginWork(scope, accepted.workId, "run-1");
    await store().completeWork(scope, completion(accepted.workId));
    const workflowStepCallback = () => dispatchDialogueDueScopes();
    await expect(workflowStepCallback()).resolves.toMatchObject({ scopes: 1, failed: 0 });

    expect(runner.startExpression).toHaveBeenCalledWith(scope);
    expect(runner.startWork).toHaveBeenCalledTimes(1);
    expect(interval).not.toHaveBeenCalled();
  });

  it("keeps each invocation bounded", async () => {
    await store().accept(scope, { clientMessageId: "m1", launch: launch("One.") });
    await store().accept(scope, { clientMessageId: "m2", launch: launch("Two.") });
    const result = await dispatchDialogueDueScopes({ scopeLimit: 1, jobsPerScope: 1 });
    expect(result).toEqual({ scopes: 1, ran: 1, failed: 0 });
  });
});
