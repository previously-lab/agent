import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelMessage } from "@/lib/deepseek/types";
import type { WriteBatch } from "@/lib/episodic/io-helpers";
import { requestDeepSeek } from "@/lib/deepseek/http";
import { createTask, recordTaskResult } from "@/lib/tasks/store";
import { createDialogueStore, type DialogueStore } from "@/lib/dialogue/store";
import { createLocalDialogueStorage } from "@/lib/dialogue/local";
import { deriveWorkScopeBindings } from "@/lib/dialogue/scopes";
import { dispatchDialogueDueScopes } from "@/app/api/chat/dialogue/dispatch-host";
import {
  acquireExpressionStep,
  beginDialogueWorkStep,
  completeDialogueWorkStep,
  expressionRoundStep,
  publishExpressionSegmentStep,
  releaseExpressionStep,
  settleExpressionPlanStep,
} from "@/app/api/chat/dialogue-steps";

// The Git-ledger-backed task store resolves its filesystem through
// io-helpers, whose module-level source detection runs at import time — far
// before a test can set STORAGE. An in-memory io-helpers keeps the ledger
// private to this file and makes the read/modify/write flow deterministic.
const ledgerFiles = vi.hoisted(() => ({ files: new Map<string, string>() }));

vi.mock("@/lib/episodic/io-helpers", () => ({
  createBatch: () => ({
    entries: new Map<string, string | null>(),
    encodings: new Map<string, "base64">(),
  }),
  fsReadFile: async (path: string, batch?: WriteBatch) => {
    const pending = batch?.entries.get(path);
    if (pending !== undefined) {
      if (pending === null) throw new Error(`File not found: "${path}"`);
      return pending;
    }
    const content = ledgerFiles.files.get(path);
    if (content === undefined) throw new Error(`File not found: "${path}"`);
    return content;
  },
  fsWriteFile: async (path: string, content: string, batch?: WriteBatch) => {
    if (batch) {
      batch.entries.set(path, content);
      return { path, created: true };
    }
    ledgerFiles.files.set(path, content);
    return { path, created: true };
  },
  flushBatch: async (batch: WriteBatch) => {
    for (const [path, content] of batch.entries) {
      if (content === null) ledgerFiles.files.delete(path);
      else ledgerFiles.files.set(path, content);
    }
    batch.entries.clear();
    return null;
  },
  fsListFiles: async () => [],
}));

vi.mock("@/lib/deepseek/http", () => ({ requestDeepSeek: vi.fn() }));
vi.mock("@/app/api/chat/dialogue/dispatch-host", () => ({ dispatchDialogueDueScopes: vi.fn() }));

const scope = "steps-test-user";
const sliceId = "2026-11-06-0600";

const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, reasoningTokens: 0, cachedInputTokens: 0, uncachedInputTokens: 0 };

describe("dialogue steps over the real local store", () => {
  let dir: string;
  let store: DialogueStore;

  beforeEach(async () => {
    vi.mocked(requestDeepSeek).mockReset();
    vi.mocked(dispatchDialogueDueScopes).mockReset().mockResolvedValue({ scopes: 0, ran: 0, failed: 0 });
    process.env.STORAGE = "local";
    dir = await realpath(await mkdtemp(join(await realpath(tmpdir()), "aftrbrez-dialogue-steps-")));
    process.env.DIALOGUE_RUNTIME_DIR = dir;
    ledgerFiles.files.clear();
    store = createDialogueStore(createLocalDialogueStorage(dir));
  });

  afterEach(async () => {
    delete process.env.DIALOGUE_RUNTIME_DIR;
    await rm(dir, { recursive: true, force: true });
  });

  async function accept(text: string) {
    return store.accept(scope, {
      clientMessageId: `msg-${text.length}-${Math.random().toString(36).slice(2, 8)}`,
      launch: {
        modelMessages: [], recentTurns: [], lastUserMessage: text, model: "deepseek", modelConfig: {} as never,
        thinking: true, reasoningEffort: "low", clientTimezone: "UTC", locale: "en",
        config: {} as never, owner: "local", repo: "local", useGithub: false, useDemo: false,
        startedAtIso: "2026-11-06T06:00:00.000Z", turnId: "provisional", imageAttachments: [],
      },
    });
  }

  const workMessages = (report: unknown): ModelMessage[] => [
    { role: "assistant", content: "The answer is 42." },
    { role: "assistant", content: [{ type: "tool-call", toolCallId: "c1", toolName: "finishThinking", input: report }] },
  ];

  it("admits exactly one attempt and hands the terminal product to the store", async () => {
    const accepted = await accept("What is the answer?");
    const launch = { scopeKey: scope, workId: accepted.workId };
    const admitted = await beginDialogueWorkStep(launch, "run-a");
    expect(admitted).not.toBeNull();
    expect(admitted!.inputs.map((input) => [input.userSeq, input.text])).toEqual([[1, "What is the answer?"]]);
    expect(await beginDialogueWorkStep(launch, "run-b")).toBeNull();

    const result = await completeDialogueWorkStep({
      launch,
      inputIds: [accepted.workId],
      runId: "run-a",
      sliceId,
      messages: workMessages({ findings: [{ text: "The answer is 42.", kind: "interpretation" }] }),
      text: "The answer is 42.",
      locale: "en",
      report: { findings: [{ text: "The answer is 42.", kind: "interpretation" }] },
      interrupted: false,
    });
    expect(result).not.toBeNull();
    expect(result!.product.status).toBe("complete");
    expect(result!.claims.map((claimEntry) => [claimEntry.claimId, claimEntry.allowedPublicMode])).toEqual([["claim-1", "finding"]]);
    const work = await store.work(scope, accepted.workId);
    expect(work?.status).toBe("completed");
    expect(work?.sliceId).toBe(sliceId);
    expect(await store.result(scope, result!.resultId)).not.toBeNull();
    expect(dispatchDialogueDueScopes).toHaveBeenCalledOnce();
  });

  it("records an honest failure status when the work was interrupted", async () => {
    const accepted = await accept("Hard question.");
    const launch = { scopeKey: scope, workId: accepted.workId };
    await beginDialogueWorkStep(launch, "run-a");
    const result = await completeDialogueWorkStep({
      launch,
      inputIds: [accepted.workId],
      runId: "run-a",
      sliceId,
      messages: [],
      text: "",
      report: undefined,
      interrupted: true,
    });
    expect(result!.product.status).toBe("incomplete");
    expect(result!.claims.every((claimEntry) => claimEntry.allowedPublicMode === "status")).toBe(true);
  });

  it("binds trusted context into the saved scope and persists only ledger-verified delivery intents", async () => {
    await createTask({
      operationId: "op-create", now: "2026-11-06T06:00:00.000Z",
      task: { ref: "tasks/speakers", summary: "Compare two speakers" },
      userCommitment: { sliceId, turnId: "bg-turn", statement: "The user asked for the comparison" },
    });
    await recordTaskResult({
      operationId: "op-result", now: "2026-11-06T06:05:00.000Z",
      result: { id: "result-1", taskRef: "tasks/speakers", evidence: { producerRunId: "bg-run", statement: "The smaller speaker fits." } },
    });
    const accepted = await accept("Which speaker fits?");
    const launch = { scopeKey: scope, workId: accepted.workId };
    await beginDialogueWorkStep(launch, "run-a");
    const minted = deriveWorkScopeBindings([{ ref: "things/speakers" }]).independentScopes[0]!;
    const messages: ModelMessage[] = [
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "rd1", toolName: "recallRead", input: { ref: "things/speakers" } }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "rd1", toolName: "recallRead",
        output: { type: "json", value: { thinkingReceipt: { version: 1, scopeId: accepted.workId, toolCallId: "rd1",
          reads: [{ evidenceId: "rd1:1", ref: "things/speakers", sourceKind: "semantic_document",
            revision: "rev-1", asOf: "2026-11-06T06:00:00.000Z", coverage: "full" }] } } } }] },
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "r1", toolName: "reportTaskFollowup", input: { resultId: "result-1" } }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "r1", toolName: "reportTaskFollowup",
        output: { type: "json", value: { ackIntent: { kind: "result", resultId: "result-1", expectedRevision: 1 } } } }] },
    ];
    const result = await completeDialogueWorkStep({
      launch,
      inputIds: [accepted.workId],
      runId: "run-a",
      sliceId,
      messages,
      text: "The smaller speaker fits.",
      locale: "en",
      documentContext: [{ ref: "things/speakers" }],
      report: { findings: [
        { text: "Scoped finding.", kind: "project_fact", scopeId: minted.id, evidenceIds: ["rd1:1"] },
        { text: "The smaller speaker fits.", kind: "conversation" },
      ] },
      interrupted: false,
    });
    expect(result!.deliveryIntents).toEqual([
      { resultId: "result-1", expectedRevision: 1, taskRef: "tasks/speakers" },
    ]);
    expect(result!.product.inputScope.taskRef).toBe("tasks/speakers");
    const scoped = result!.product.claims.find((entry) => entry.text === "Scoped finding.");
    expect(scoped?.allowedPublicMode).toBe("finding");
    expect(scoped?.scopeId).toBe(minted.id);
  });

  it("drops delivery intents the ledger does not verify", async () => {
    const accepted = await accept("No task here.");
    const launch = { scopeKey: scope, workId: accepted.workId };
    await beginDialogueWorkStep(launch, "run-a");
    const messages: ModelMessage[] = [
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "r9", toolName: "reportTaskFollowup", input: { resultId: "result-unknown" } }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "r9", toolName: "reportTaskFollowup",
        output: { type: "json", value: { ackIntent: { kind: "result", resultId: "result-unknown", expectedRevision: 3 } } } }] },
    ];
    const result = await completeDialogueWorkStep({
      launch, inputIds: [accepted.workId], runId: "run-a", sliceId,
      messages, text: "Plain answer.", report: undefined, interrupted: false,
    });
    expect(result!.deliveryIntents).toBeUndefined();
    expect(result!.product.inputScope.taskRef).toBeUndefined();
  });

  it("publishes without an explicit empty decisions array and unlocks the committed artifact idempotently", async () => {
    const accepted = await accept("Show the offline calculator.");
    const launch = { scopeKey: scope, workId: accepted.workId };
    await beginDialogueWorkStep(launch, "run-a");
    const html = "<!doctype html>\n<html><body>Offline calculator</body></html>\n";
    const report = { findings: [{ text: "Use the calculator.", kind: "conversation", evidenceIds: [] }] };
    const result = await completeDialogueWorkStep({
      launch, inputIds: [accepted.workId], runId: "run-a", sliceId,
      messages: workMessages(report), text: `Before.\n\n\`\`\`html live\n${html}\`\`\`\n\nAfter.`, report,
      interrupted: false,
    });
    const block = result!.blocks.find((entry) => entry.kind === "artifact_ref");
    if (!block || block.kind !== "artifact_ref") throw new Error("Expected a stored artifact reference");
    expect(await store.artifact(scope, block.artifact.artifactId)).toBeNull();

    vi.mocked(requestDeepSeek).mockResolvedValue({
      message: { role: "assistant", content: JSON.stringify({
        sends: [{ text: "Here is the calculator.", sources: [{ resultId: result!.resultId, productRevision: 1,
          claimId: "claim-1", mode: "finding" }], blockIds: [block.blockId] }],
      }) },
      toolCalls: [], finishReason: "stop", usage,
    });
    const fence = await acquireExpressionStep(scope, "artifact-owner");
    const round = await expressionRoundStep(scope, fence!, "artifact-owner");
    expect(round!.saved.plan.decisions).toEqual([]);
    const published = await publishExpressionSegmentStep(scope, fence!, round!.saved, 0, round!.saved.basis.publicHighWater);
    expect(published.status).toBe("committed");
    expect((await store.artifact(scope, block.artifact.artifactId))?.body).toBe(html);

    const replay = await publishExpressionSegmentStep(scope, fence!, round!.saved, 0, round!.saved.basis.publicHighWater);
    expect(replay.utterances).toEqual(published.utterances);
    await settleExpressionPlanStep(scope, fence!, round!.saved.id, false);
    await releaseExpressionStep(scope, fence!, round!.observedWake);
  });
  it("drains a two-segment plan with per-segment publication and a clean release", async () => {
    const accepted = await accept("Two things, please.");
    const launch = { scopeKey: scope, workId: accepted.workId };
    await beginDialogueWorkStep(launch, "run-a");
    const result = await completeDialogueWorkStep({
      launch,
      inputIds: [accepted.workId],
      runId: "run-a",
      sliceId,
      messages: workMessages({ findings: [
        { text: "First conclusion.", kind: "conversation" },
        { text: "Second conclusion.", kind: "conversation" },
      ] }),
      text: "First conclusion. Second conclusion.",
      report: { findings: [
        { text: "First conclusion.", kind: "conversation", evidenceIds: [] },
        { text: "Second conclusion.", kind: "conversation", evidenceIds: [] },
      ] },
      interrupted: false,
    });
    expect(result!.claims).toHaveLength(2);

    vi.mocked(requestDeepSeek).mockImplementation(async (request) => {
      expect(JSON.stringify(request)).toContain(result!.resultId);
      return {
        message: { role: "assistant", content: JSON.stringify({
          sends: [
            { text: "First segment.", sources: [{ resultId: result!.resultId, productRevision: 1, claimId: "claim-1", mode: "finding" }], blockIds: [] },
            { text: "Second segment.", sources: [{ resultId: result!.resultId, productRevision: 1, claimId: "claim-2", mode: "finding" }], blockIds: [] },
          ],
          decisions: [],
        }) },
        toolCalls: [],
        finishReason: "stop",
        usage,
      } as never;
    });

    const fence = await acquireExpressionStep(scope, "expression-owner");
    expect(fence).not.toBeNull();
    const round = await expressionRoundStep(scope, fence!, "expression-owner");
    expect(round).not.toBeNull();
    expect(round!.saved.plan.sends).toHaveLength(2);

    const first = await publishExpressionSegmentStep(scope, fence!, round!.saved, 0, round!.saved.basis.publicHighWater);
    expect(first.status).toBe("committed");
    expect(first.utterances[0]?.publicSeq).toBe(1);
    const second = await publishExpressionSegmentStep(scope, fence!, round!.saved, 1, first.utterances[0]!.publicSeq);
    expect(second.status).toBe("committed");
    expect(second.utterances[0]?.publicSeq).toBe(2);

    await settleExpressionPlanStep(scope, fence!, round!.saved.id, false);
    // A new input lands before release: the drain still exits cleanly and the
    // committed prefix is preserved.
    await accept("A late correction.");
    expect(await releaseExpressionStep(scope, fence!, round!.observedWake)).toBe("released");

    const page = await store.page(scope);
    const appended = page.events.flatMap((event) => event.type === "manuscript.append" ? [event.utterance] : []);
    expect(appended.map((utterance) => utterance.publicSeq)).toEqual([1, 2]);
    expect(appended.flatMap((utterance) => utterance.blocks.flatMap((block) => block.kind === "markdown" ? [block.text] : [])))
      .toEqual(["First segment.", "Second segment."]);
  });

  it("fences a stale segment and degrades a compose failure to a null round", async () => {
    const accepted = await accept("Fenced.");
    const launch = { scopeKey: scope, workId: accepted.workId };
    await beginDialogueWorkStep(launch, "run-a");
    const result = await completeDialogueWorkStep({
      launch, inputIds: [accepted.workId], runId: "run-a", sliceId,
      messages: workMessages({ findings: [{ text: "One conclusion.", kind: "interpretation" }] }),
      text: "One conclusion.",
      report: { findings: [{ text: "One conclusion.", kind: "interpretation" }] },
      interrupted: false,
    });

    vi.mocked(requestDeepSeek).mockImplementation(async () => ({
      message: { role: "assistant", content: JSON.stringify({
        sends: [{ text: "One segment.", sources: [{ resultId: result!.resultId, productRevision: 1, claimId: "claim-1", mode: "finding" }], blockIds: [] }],
        decisions: [],
      }) },
      toolCalls: [],
      finishReason: "stop",
      usage,
    } as never));

    const fence = await acquireExpressionStep(scope, "owner-stale");
    const round = await expressionRoundStep(scope, fence!, "owner-stale");
    await accept("New input moves the high water.");
    const stale = await publishExpressionSegmentStep(scope, fence!, round!.saved, 0, round!.saved.basis.publicHighWater);
    expect(stale.status).toBe("stale");
    await settleExpressionPlanStep(scope, fence!, round!.saved.id, false);
    // Ready results remain and the lease is yielded with work — the resume
    // outbox (not the user) wakes the next drain attempt.
    expect(await releaseExpressionStep(scope, fence!, round!.observedWake, true)).toBe("released");
    const page = await store.page(scope);
    expect(page.events.some((event) => event.type === "manuscript.append")).toBe(false);

    // Compose failure: the model round is billed once and the round yields;
    // results stay ready for the next wake instead of a retry loop.
    const fence2 = await acquireExpressionStep(scope, "owner-retry");
    expect(fence2).not.toBeNull();
    expect(fence2!.epoch).toBeGreaterThan(fence!.epoch);
    vi.mocked(requestDeepSeek).mockRejectedValueOnce(new Error("provider down"));
    await expect(expressionRoundStep(scope, fence2!, "owner-retry")).resolves.toBeNull();
    const snapshot = await store.expressionSnapshot(scope, fence2!);
    expect(snapshot!.results.map((entry) => entry.resultId)).toEqual([result!.resultId]);
  });
});
