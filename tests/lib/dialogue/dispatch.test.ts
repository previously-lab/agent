import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULTS } from "@/lib/config/defaults";
import { FIXED_MODEL } from "@/lib/models/registry";
import type { TurnInput } from "@/lib/chat/turn-types";
import type { DialogueClaim } from "@/lib/chat/dialogue-contract";
import type { ThinkingProduct } from "@/lib/agents/thinking-product";
import { createDialogueStore, type DialogueStore } from "@/lib/dialogue/store";
import { createLocalDialogueStorage } from "@/lib/dialogue/local";
import { dispatchDialogueStore, runDialogueJob, type DialogueRunner } from "@/lib/dialogue/dispatch";
import { publicTurnIdFor, type DeliveryConfirmation } from "@/lib/dialogue/task-delivery";

vi.mock("@/lib/deepseek/http", () => ({ requestDeepSeek: vi.fn() }));

const scope = "dispatch-test-user";
const at = "2026-11-06T06:00:00.000Z";

function launch(text: string): TurnInput {
  return {
    modelMessages: [], recentTurns: [], lastUserMessage: text, model: FIXED_MODEL.id, modelConfig: FIXED_MODEL,
    thinking: true, reasoningEffort: "low", clientTimezone: "UTC", locale: "en",
    config: DEFAULTS, owner: "local", repo: "local", useGithub: false, useDemo: false,
    startedAtIso: at, turnId: "provisional", imageAttachments: [],
  };
}

const claim = (id: string, text: string): DialogueClaim => ({ claimId: id, text, allowedPublicMode: "finding", evidence: [] });

function completion(workId: string, runId: string, claims: DialogueClaim[]): Parameters<DialogueStore["completeWork"]>[1] {
  const product: ThinkingProduct = {
    version: 1, inputScope: { scopeKey: scope, workId, inputIds: [workId] },
    sourceRevision: null, asOf: at, status: "complete", readSet: [], dependencies: [], openQuestions: [],
    claims: claims.map((item) => ({ claimId: item.claimId, text: item.text, kind: "interpretation", allowedPublicMode: item.allowedPublicMode,
      evidenceIds: [], requiredReadRefs: [], missingReadRefs: [], adoptionEvidenceIds: [] })),
  };
  return { workId, runId, sliceId: "2026-11-06-0600", product, claims, blocks: [], status: "completed" };
}

interface Fake {
  runner: DialogueRunner;
  started: TurnInput[];
  expressions: string[];
  projects: Array<{ scope: string; payload: unknown }>;
  ringed: Array<{ sliceId: string; turnIds: string[] }>;
  statuses: Map<string, "live" | "completed" | "failed" | "cancelled" | "gone">;
  failStart: boolean;
  projectReceipt: { inputIds: string[]; utteranceIds: string[]; sliceId: string; reflection: Array<{ sliceId: string; turnIds: string[] }>; commitSha: string | null } | null;
}

function fakeRunner(): Fake {
  const fake: Fake = {
    started: [], expressions: [], projects: [], ringed: [], statuses: new Map(),
    failStart: false, projectReceipt: null,
    runner: undefined as unknown as DialogueRunner,
  };
  fake.runner = {
    startWork: async (input) => {
      if (fake.failStart) throw new Error("start unavailable");
      fake.started.push(input);
      return { runId: `run-${fake.started.length}` };
    },
    startExpression: async (scopeKey) => {
      fake.expressions.push(scopeKey);
      return "started";
    },
    cancelRun: async () => {},
    runStatus: async (runId) => fake.statuses.get(runId) ?? "gone",
    project: async (target, payload) => {
      fake.projects.push({ scope: target, payload });
      return fake.projectReceipt;
    },
    ringReflection: async (ranges) => {
      fake.ringed.push(...ranges);
    },
  };
  return fake;
}

describe("dialogue outbox dispatch", () => {
  let dir: string;
  let store: DialogueStore;

  /** Jobs of other kinds are settled on the way through; the wanted kind is
   *  returned still leased for the caller's own assertions. */
  async function claimJobOfKind(store: DialogueStore, runner: DialogueRunner, kind: string) {
    for (let lap = 0; lap < 8; lap++) {
      const job = await store.claimOutbox(scope);
      if (!job) throw new Error(`No ${kind} job enqueued`);
      if (job.payload.kind === kind) return job;
      const outcome = await runDialogueJob(store, runner, scope, job);
      await store.settleOutbox(scope, job, outcome.ok, outcome.retryMs);
    }
    throw new Error(`No ${kind} job enqueued`);
  }

  beforeEach(async () => {
    process.env.STORAGE = "local";
    dir = await realpath(await mkdtemp(join(await realpath(tmpdir()), "aftrbrez-dispatch-test-")));
    process.env.DIALOGUE_RUNTIME_DIR = dir;
    store = createDialogueStore(createLocalDialogueStorage(dir));
  });

  afterEach(async () => {
    delete process.env.DIALOGUE_RUNTIME_DIR;
    await rm(dir, { recursive: true, force: true });
  });

  it("starts each accepted work exactly once across sweeps", async () => {
    const fake = fakeRunner();
    const one = await store.accept(scope, { clientMessageId: "m1", launch: launch("Choose an apple.") });
    const two = await store.accept(scope, { clientMessageId: "m2", launch: launch("Compare speakers.") });
    const first = await dispatchDialogueStore(store, fake.runner);
    expect(first.ran).toBeGreaterThan(0);
    expect(fake.started.map((input) => input.lastUserMessage).sort()).toEqual(["Choose an apple.", "Compare speakers."]);
    expect(fake.started.every((input) => input.dialogue)).toBe(true);
    const work = await store.work(scope, one.workId);
    expect(work?.runId).toBeTruthy();
    const again = await dispatchDialogueStore(store, fake.runner);
    expect(fake.started).toHaveLength(2);
    expect(again.ran).toBe(0);
    expect(two.workId).not.toBe(one.workId);
  });

  it("retries a failed start instead of losing the intent", async () => {
    const fake = fakeRunner();
    fake.failStart = true;
    await store.accept(scope, { clientMessageId: "m1", launch: launch("Retry me.") });
    const job = await claimJobOfKind(store, fake.runner, "start_work");
    const outcome = await runDialogueJob(store, fake.runner, scope, job);
    expect(outcome.ok).toBe(false);
    // Settle back to ready immediately (the engine's 1.5s backoff is a
    // runtime courtesy, not part of the contract).
    await store.settleOutbox(scope, job, false, 0);
    // The project job (due now) sorts before the retried start job — settle
    // through it, then the reclaimed start job must carry a fresh lease.
    let reclaimed: Awaited<ReturnType<DialogueStore["claimOutbox"]>> | null = null;
    for (let lap = 0; lap < 4; lap++) {
      reclaimed = await store.claimOutbox(scope);
      if (!reclaimed) break;
      if (reclaimed.payload.kind === "project") {
        const projectOutcome = await runDialogueJob(store, fake.runner, scope, reclaimed);
        await store.settleOutbox(scope, reclaimed, projectOutcome.ok, projectOutcome.retryMs);
        continue;
      }
      break;
    }
    expect(reclaimed?.id).toBe(job.id);
    expect(reclaimed?.attempts).toBe(job.attempts + 1);
    expect(reclaimed?.lease).not.toBe(job.lease);
  });

  it("watches a live run, settles a completed one and fails a dead one", async () => {
    const fake = fakeRunner();
    const accepted = await store.accept(scope, { clientMessageId: "m1", launch: launch("Watch me.") });
    await store.noteLaunch(scope, accepted.workId, "run-live");
    fake.statuses.set("run-live", "live");
    const liveJob = { id: "w1", payload: { kind: "watch_work", workId: accepted.workId }, attempts: 0 } as const;
    await expect(runDialogueJob(store, fake.runner, scope, { ...liveJob, lease: "l1" })).resolves.toEqual({ ok: false, retryMs: 8_000 });
    fake.statuses.set("run-live", "completed");
    await expect(runDialogueJob(store, fake.runner, scope, { ...liveJob, lease: "l2" })).resolves.toEqual({ ok: true });
    expect((await store.work(scope, accepted.workId))?.status).toBe("queued");
    fake.statuses.set("run-live", "failed");
    await expect(runDialogueJob(store, fake.runner, scope, { ...liveJob, lease: "l3" })).resolves.toEqual({ ok: true });
    expect((await store.work(scope, accepted.workId))?.status).toBe("failed");
  });

  it("starts the expression drain only when the store admits it, after results wake the scope", async () => {
    const fake = fakeRunner();
    const accepted = await store.accept(scope, { clientMessageId: "m1", launch: launch("Answer me.") });
    // Settle the start/project jobs first so the express job surfaces.
    await dispatchDialogueStore(store, fake.runner);
    expect(await store.expressionDispatch(scope)).toBe("done");
    await store.beginWork(scope, accepted.workId, "run-1");
    await store.completeWork(scope, completion(accepted.workId, "run-1", [claim("c1", "A result.")]));
    const job = await store.claimOutbox(scope);
    expect(job?.payload).toEqual({ kind: "express" });
    await expect(runDialogueJob(store, fake.runner, scope, job!)).resolves.toEqual({ ok: true });
    expect(fake.expressions).toEqual([scope]);
  });

  it("settles task delivery with the real public turn BEFORE the projection receipt", async () => {
    const fake = fakeRunner();
    const accepted = await store.accept(scope, { clientMessageId: "m1", launch: launch("Deliver the background result.") });
    await store.beginWork(scope, accepted.workId, "run-1");
    const completed = await store.completeWork(scope, {
      ...completion(accepted.workId, "run-1", [claim("c1", "A delivered fact.")]),
      deliveryIntents: [{ resultId: "result-1", expectedRevision: 1, taskRef: "tasks/speakers" }],
    });
    const fence = await store.acquireExpression(scope, "owner");
    const snapshot = await store.expressionSnapshot(scope, fence!);
    const basis = { inputHighWater: snapshot!.inputHighWater, publicHighWater: snapshot!.publicHighWater, wakeVersion: snapshot!.wakeVersion };
    const plan = {
      sends: [{ text: "It fits.", sources: [{ resultId: completed!.resultId, productRevision: 1, claimId: "c1", mode: "finding" as const }], blockIds: [] }],
      decisions: [],
    };
    const published = await store.publish(scope, fence!, "round-1", basis, plan);
    expect(published.status).toBe("committed");
    const utterance = published.utterances[0]!;
    await store.releaseExpression(scope, fence!, snapshot!.wakeVersion, false);
    const appendSeq = (await store.page(scope)).events.find((event) => event.type === "manuscript.append")!.eventSeq;

    const seen: Array<{ confirmations: readonly DeliveryConfirmation[]; receiptsAtConfirm: number }> = [];
    const receiptCount = async () =>
      (await store.page(scope)).events.filter((event) => event.type === "projection.receipt").length;
    const sink = {
      confirm: async (confirmations: readonly DeliveryConfirmation[]) => {
        seen.push({ confirmations, receiptsAtConfirm: await receiptCount() });
      },
    };
    fake.projectReceipt = { inputIds: [accepted.input.inputId], utteranceIds: [utterance.utteranceId],
      sliceId: "2026-11-06-0600", reflection: [], commitSha: null };

    let appendJob: Awaited<ReturnType<DialogueStore["claimOutbox"]>> | null = null;
    for (let lap = 0; lap < 6 && !appendJob; lap++) {
      const job = await store.claimOutbox(scope);
      if (!job) break;
      if (job.payload.kind === "project" && job.payload.eventSeq === appendSeq) appendJob = job;
      else {
        const outcome = await runDialogueJob(store, fake.runner, scope, job);
        await store.settleOutbox(scope, job, outcome.ok, outcome.retryMs);
      }
    }
    expect(appendJob?.payload).toEqual({ kind: "project", eventSeq: appendSeq });
    const receiptsBefore = await receiptCount();
    await expect(runDialogueJob(store, fake.runner, scope, appendJob!, undefined, { deliveries: sink })).resolves.toEqual({ ok: true });

    expect(seen).toHaveLength(1);
    // The delivery confirmation lands BEFORE this job's receipt records —
    // a failed confirm re-runs the idempotent chain instead of skipping.
    expect(seen[0]!.receiptsAtConfirm).toBe(receiptsBefore);
    expect(await receiptCount()).toBe(receiptsBefore + 1);
    expect(seen[0]!.confirmations).toEqual([{
      resultId: "result-1",
      expectedRevision: 1,
      operationId: expect.stringContaining("dialogue:delivery"),
      now: expect.any(String),
      outcome: { status: "persisted", sliceId: "2026-11-06-0600", turnId: publicTurnIdFor(utterance.utteranceId) },
    }]);
    expect((await store.page(scope)).events.some((event) => event.type === "projection.receipt")).toBe(true);
    await store.settleOutbox(scope, appendJob!, true);
  });

  it("records the projection receipt idempotently and rings reflection with material", async () => {
    const fake = fakeRunner();
    fake.projectReceipt = { inputIds: ["in1"], utteranceIds: [], sliceId: "2026-11-06-0600",
      reflection: [{ sliceId: "2026-11-06-0600", turnIds: ["t1"] }], commitSha: null };
    const accepted = await store.accept(scope, { clientMessageId: "m1", launch: launch("Project me.") });
    // The project job sorts before the start job (same due, lexical id) — it
    // is claimed first and settles with the receipt recorded.
    const job = await claimJobOfKind(store, fake.runner, "project");
    expect(job.payload).toEqual({ kind: "project", eventSeq: 1 });
    await expect(runDialogueJob(store, fake.runner, scope, job)).resolves.toEqual({ ok: true });
    expect(fake.projects).toHaveLength(1);
    expect(fake.projects[0]).toEqual({ scope, payload: { kind: "project", eventSeq: 1 } });
    expect(fake.ringed).toEqual([{ sliceId: "2026-11-06-0600", turnIds: ["t1"] }]);
    const page = await store.page(scope);
    const receipts = page.events.filter((event) => event.type === "projection.receipt");
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ inputIds: ["in1"], utteranceIds: [], sliceId: "2026-11-06-0600" });
    // A redelivery (lost ack) must not double-record.
    await store.recordProjection(scope, job.id, { inputIds: ["in1"], utteranceIds: [], sliceId: "2026-11-06-0600" });
    expect((await store.page(scope)).events.filter((event) => event.type === "projection.receipt")).toHaveLength(1);
    expect(accepted.input.inputId).toBeTruthy();
  });
});
