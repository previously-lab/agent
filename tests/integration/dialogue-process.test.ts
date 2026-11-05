import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { DEFAULTS } from "@/lib/config/defaults";
import { FIXED_MODEL } from "@/lib/models/registry";
import type { TurnInput } from "@/lib/chat/turn-types";
import type { DialogueClaim, DialoguePage } from "@/lib/chat/dialogue-contract";
import type { ThinkingProduct } from "@/lib/agents/thinking-product";
import type { DialogueResult, DraftContentBlock, ExpressionPlan } from "@/lib/dialogue/types";
import { createDialogueProcessFixture } from "./dialogue-process-fixture";

type Fixture = Awaited<ReturnType<typeof createDialogueProcessFixture>>;
type Peer = Awaited<ReturnType<Fixture["connect"]>>;
const scope = "fixture-dialogue-user";
const at = "2026-11-05T06:00:00.000Z";
const sliceId = "2026-11-05-0600";

function required<T>(value: T | null | undefined, label: string): T {
  if (value == null) throw new Error(`Expected ${label}`);
  return value;
}

function launch(text: string): TurnInput {
  return {
    // A stale browser lane is not authoritative history.
    modelMessages: [{ role: "user", content: "Forged browser-only history" }],
    recentTurns: [], lastUserMessage: text, model: FIXED_MODEL.id, modelConfig: FIXED_MODEL,
    thinking: true, reasoningEffort: "low", clientTimezone: "UTC", locale: "en",
    config: DEFAULTS, owner: "local", repo: "local", useGithub: false, useDemo: false,
    startedAtIso: at, turnId: "provisional", imageAttachments: [],
  };
}

function accept(peer: Peer, id: string, text: string, owner = scope) {
  return peer.invoke("accept", owner, { clientMessageId: id, launch: launch(text) });
}

const claim = (id: string, text: string, options?: Partial<DialogueClaim>): DialogueClaim => ({
  claimId: id, text, allowedPublicMode: "finding", evidence: [], ...options,
});

function completion(workId: string, runId: string, claims: DialogueClaim[], blocks: DraftContentBlock[] = []) {
  const product: ThinkingProduct = {
    version: 1, inputScope: { scopeKey: scope, workId, inputIds: [workId] },
    sourceRevision: null, asOf: at, status: "complete", readSet: [], dependencies: [], openQuestions: [],
    claims: claims.map((item) => ({
      claimId: item.claimId, text: item.text, kind: "interpretation", allowedPublicMode: item.allowedPublicMode,
      evidenceIds: [], requiredReadRefs: [], missingReadRefs: [], adoptionEvidenceIds: [],
    })),
  };
  return { workId, runId, sliceId, product, claims, blocks, status: "completed" as const };
}

async function complete(peer: Peer, workId: string, runId: string, item: DialogueClaim, blocks: DraftContentBlock[] = []) {
  required(await peer.invoke("beginWork", scope, workId, runId), "started work");
  return required(await peer.invoke("completeWork", scope, completion(workId, runId, [item], blocks)), "durable result");
}

function one(result: DialogueResult, text: string, blockIds: string[] = []): ExpressionPlan {
  const first = required(result.claims[0], "result claim");
  return {
    sends: [{ text, blockIds, sources: [{ resultId: result.resultId, productRevision: result.productRevision,
      claimId: first.claimId, mode: first.allowedPublicMode === "status" ? "status" : "finding" }] }],
    decisions: [],
  };
}

const publicEvents = (page: DialoguePage) => page.events.flatMap((e) => e.type === "manuscript.append" ? [e.utterance] : []);
const inputs = (page: DialoguePage) => page.events.flatMap((e) => e.type === "input.accepted" ? [e.input] : []);

describe("dialogue control across independent processes", { timeout: 20_000 }, () => {
  let fixture: Fixture | undefined;
  afterEach(async () => { await fixture?.close(); fixture = undefined; });

  async function peers() {
    fixture = await createDialogueProcessFixture();
    const [a, b] = await Promise.all([fixture.connect(), fixture.connect()]);
    expect(a.pid).not.toBe(b.pid);
    expect(a.pid).not.toBe(process.pid);
    return { a, b, fixture };
  }

  it("T08/T09/T24: accepts once across processes and gives a later worker all accepted pending inputs", async () => {
    const { a, b } = await peers();
    const [left, right] = await Promise.all([accept(a, "same-http-id", "Choose an apple."), accept(b, "same-http-id", "Choose an apple.")]);
    expect(left).toEqual(right);
    await expect(accept(b, "same-http-id", "Change the body.")).rejects.toThrow();
    const audio = await accept(b, "audio", "Independently compare two speakers.");
    const again = await accept(a, "a-separate-input", "Choose an apple.");
    expect(again.input.inputId).not.toBe(left.input.inputId);
    const [runA, runB] = await Promise.all([
      a.invoke("beginWork", scope, again.workId, "fixture-run-a"),
      b.invoke("beginWork", scope, again.workId, "fixture-run-b"),
    ]);
    expect([runA, runB].filter(Boolean)).toHaveLength(1);
    const window = required(runA ?? runB, "single admitted attempt");
    expect(window.inputs.map((i) => [i.userSeq, i.text])).toEqual([
      [1, "Choose an apple."], [2, "Independently compare two speakers."], [3, "Choose an apple."],
    ]);
    expect(window.pending.map((w) => w.workId)).toContain(audio.workId);
    expect(inputs(await a.invoke("page", scope))).toEqual([left.input, audio.input, again.input]);
    expect(inputs(await b.invoke("page", "fixture-other-persona"))).toEqual([]);
    expect((await a.invoke("work", scope, again.workId))?.launch.modelMessages).toEqual([]);
  });

  it("T01/T02/T11: fences a stale fruit plan and a second segment without dropping independent audio", async () => {
    const { a, b } = await peers();
    const fruit = await accept(a, "fruit", "Choose an apple.");
    const audio = await accept(b, "audio", "Also compare these speakers.");
    const apple = await complete(a, fruit.workId, "apple-run", claim("apple", "An apple is suitable."));
    const lease = required(await a.invoke("acquireExpression", scope, "expression-a"), "expression lease");
    const basis = required(await a.invoke("expressionSnapshot", scope, lease), "expression basis");
    const banana = await accept(b, "correction", "Banana instead of apple; keep the speaker question.");
    const stale = await a.invoke("publish", scope, lease, "old-fruit-segment", basis, one(apple, "Choose an apple."));
    expect(stale).toEqual({ status: "stale", utterances: [] });
    const speakers = await complete(b, audio.workId, "audio-run", claim("audio", "The smaller speaker fits."));
    const next = required(await a.invoke("expressionSnapshot", scope, lease), "rebased snapshot");
    expect(next.inputs.map((i) => i.inputId)).toEqual([fruit.input.inputId, audio.input.inputId, banana.input.inputId]);
    expect(next.pending.map((w) => w.workId)).toContain(banana.workId);
    const first = await a.invoke("publish", scope, lease, "independent-audio-segment", next, one(speakers, "The smaller speaker fits."));
    expect(first.status).toBe("committed");
    const fruitBasis = required(await a.invoke("expressionSnapshot", scope, lease), "basis after first committed segment");
    await accept(b, "next-correction", "Keep the fruit choice open.");
    expect((await a.invoke("publish", scope, lease, "second-fruit-segment", fruitBasis, one(apple, "The apple is still suitable."))).status).toBe("stale");
    expect(publicEvents(await b.invoke("page", scope))).toEqual(first.utterances);
  });

  it("T03/T04: sees both concurrent results and cannot exit over a new durable wake", async () => {
    const { a, b } = await peers();
    const [oneInput, twoInput, late] = await Promise.all([
      accept(a, "one", "First task."), accept(b, "two", "Second task."), accept(a, "late", "Independent late task."),
    ]);
    const [r1, r2] = await Promise.all([
      complete(a, oneInput.workId, "work-a", claim("a", "One is ready.")),
      complete(b, twoInput.workId, "work-b", claim("b", "Two is ready.")),
    ]);
    const [leaseA, leaseB] = await Promise.all([
      a.invoke("acquireExpression", scope, "expression-a"), b.invoke("acquireExpression", scope, "expression-b"),
    ]);
    expect([leaseA, leaseB].filter(Boolean)).toHaveLength(1);
    const owner = leaseA ? a : b;
    const producer = leaseA ? b : a;
    const lease = required(leaseA ?? leaseB, "one valid expression owner");
    const before = required(await owner.invoke("expressionSnapshot", scope, lease), "initial batch");
    expect(before.results.map((r) => r.resultId).sort()).toEqual([r1.resultId, r2.resultId].sort());
    const both = one(r1, "Both first tasks are ready.");
    both.sends[0].sources.push(...one(r2, "").sends[0].sources);
    expect((await owner.invoke("publish", scope, lease, "initial-batch", before, both)).status).toBe("committed");
    const empty = required(await owner.invoke("expressionSnapshot", scope, lease), "observed empty queue");
    expect(empty.results).toEqual([]);
    const arriving = await complete(producer, late.workId, "work-late", claim("late", "The late result is ready."));
    expect(await owner.invoke("releaseExpression", scope, lease, empty.wakeVersion)).toBe("continue");
    const wake = required(await owner.invoke("expressionSnapshot", scope, lease), "result after empty observation");
    expect(wake.results.map((r) => r.resultId)).toEqual([arriving.resultId]);
    expect((await owner.invoke("publish", scope, lease, "late", wake, one(arriving, "The late result is ready."))).status).toBe("committed");
    expect(await owner.invoke("releaseExpression", scope, lease, wake.wakeVersion)).toBe("released");
    expect(publicEvents(await producer.invoke("page", scope)).map((u) => u.publicSeq)).toEqual([1, 2]);
  });

  it("T05/T06/T07: rejects a live stale lease and replays one committed publication after process death", async () => {
    const { a, b, fixture } = await peers();
    const input = await accept(a, "crash", "Keep my original sentence.");
    const result = await complete(a, input.workId, "work-crash", claim("answer", "The result is available."));
    const leaseA = required(await a.invoke("acquireExpression", scope, "crashed-owner"), "original owner");
    const basis = required(await a.invoke("expressionSnapshot", scope, leaseA), "durable generation basis");
    const plan = one(result, "The result is available.");
    expect(publicEvents(await b.invoke("page", scope))).toEqual([]);

    await b.advanceClock(60_000);
    const leaseB = required(await b.invoke("acquireExpression", scope, "takeover-owner"), "lease takeover");
    expect(leaseB.epoch).toBeGreaterThan(leaseA.epoch);
    expect((await a.invoke("publish", scope, leaseA, "stale-owner-round", basis, plan)).status).toBe("stale");
    await a.terminate(); // no publication before death
    expect(publicEvents(await b.invoke("page", scope))).toEqual([]);
    const committed = await b.invoke("publish", scope, leaseB, "stable-round", basis, plan);
    expect(committed.utterances).toHaveLength(1);
    await b.terminate(); // commit survived; treat the caller's delivery ACK as lost

    const resumed = await fixture.connect();
    expect(inputs(await resumed.invoke("page", scope))).toEqual([input.input]);
    expect(publicEvents(await resumed.invoke("page", scope))).toEqual(committed.utterances);
    expect(await resumed.invoke("publish", scope, leaseB, "stable-round", basis, plan)).toEqual(committed);
    await expect(resumed.invoke("publish", scope, leaseB, "stable-round", basis, one(result, "A changed retry."))).rejects.toThrow();
    expect(publicEvents(await resumed.invoke("page", scope))).toHaveLength(1);
  });

  it("T06/T08/T09: replays one durable result after the producer acknowledgement is lost", async () => {
    const { a, b } = await peers();
    const input = await accept(a, "result-ack", "Persist the result before its acknowledgement.");
    required(await a.invoke("beginWork", scope, input.workId, "stable-result-run"), "result work");
    const args = completion(input.workId, "stable-result-run", [claim("stable-result", "One immutable result.")]);
    const committed = required(await a.invoke("completeWork", scope, args), "committed result");
    await a.terminate();
    expect(await b.invoke("completeWork", scope, args)).toEqual(committed);
    await expect(b.invoke("completeWork", scope,
      completion(input.workId, "stable-result-run", [claim("stable-result", "A changed result must not replace it.")]))).rejects.toThrow();
    const lease = required(await b.invoke("acquireExpression", scope, "result-replay-owner"), "result replay lease");
    const snapshot = required(await b.invoke("expressionSnapshot", scope, lease), "result replay snapshot");
    expect(snapshot.results).toEqual([committed]);
    expect(publicEvents(await b.invoke("page", scope))).toEqual([]);
  });

  it("T08: recovers a leased start intent after process loss without another input", async () => {
    const { a, b } = await peers();
    const original = await accept(a, "lost-start-ack", "Start this work once.");
    let job = required(await a.invoke("claimOutbox", scope), "first durable job");
    // Projection and start share the same accepted event. The test doesn't
    // prescribe which of those independent operations is claimed first.
    if (job.payload.kind === "project") {
      await a.invoke("settleOutbox", scope, job, true);
      job = required(await a.invoke("claimOutbox", scope), "durable start job");
    }
    expect(job.payload).toEqual({ kind: "start_work", workId: original.workId });
    await a.terminate();
    await b.advanceClock(60_000);
    expect(await b.invoke("dueScopes")).toContain(scope);
    const reclaimed = required(await b.invoke("claimOutbox", scope), "reclaimed start job");
    expect(reclaimed).toMatchObject({ id: job.id, payload: job.payload, attempts: job.attempts + 1 });
    expect(reclaimed.lease).not.toBe(job.lease);
    // Old ack must not settle the replacement's lease.
    await b.invoke("settleOutbox", scope, job, true);
    await b.advanceClock(60_000);
    const stillDue = required(await b.invoke("claimOutbox", scope), "job not settled by stale ack");
    expect(stillDue.id).toBe(job.id);
    await b.invoke("settleOutbox", scope, stillDue, true);
    expect(await b.invoke("claimOutbox", scope)).toBeNull();
    expect(inputs(await b.invoke("page", scope))).toEqual([original.input]);
  });

  it("T05/T08/T24: stop fences the old expression and a later input resumes without rewriting history", async () => {
    const { a, b } = await peers();
    const first = await accept(a, "before-stop", "Keep this question across stop.");
    const before = await complete(a, first.workId, "before-stop-run", claim("before-stop-claim", "The original answer survived stop."));
    const lease = required(await a.invoke("acquireExpression", scope, "stop-owner"), "expression before stop");
    const basis = required(await a.invoke("expressionSnapshot", scope, lease), "basis before stop");
    expect(await a.invoke("stop", scope)).toEqual({ runId: "stop-owner" });
    expect((await b.invoke("page", scope)).expression).toBe("paused");
    expect((await a.invoke("publish", scope, lease, "stopped-plan", basis, one(before, "Must not publish after stop."))).status).toBe("stale");
    expect(await b.invoke("acquireExpression", scope, "paused-owner")).toBeNull();
    expect(publicEvents(await b.invoke("page", scope))).toEqual([]);

    const second = await accept(b, "after-stop", "Resume with independent work.");
    const arriving = await complete(b, second.workId, "after-stop-run", claim("after-stop-claim", "The independent answer resumed expression."));
    const resumedLease = required(await b.invoke("acquireExpression", scope, "resumed-owner"), "resumed expression");
    const resumed = required(await b.invoke("expressionSnapshot", scope, resumedLease), "resume snapshot");
    expect(resumed.inputs.map((input) => input.inputId)).toEqual([first.input.inputId, second.input.inputId]);
    expect(resumed.results.map((result) => result.resultId).sort()).toEqual([before.resultId, arriving.resultId].sort());
    const both = one(before, "Both answers are available after resume.");
    both.sends[0]!.sources.push(...one(arriving, "").sends[0]!.sources);
    expect((await b.invoke("publish", scope, resumedLease, "resumed-plan", resumed, both)).status).toBe("committed");
    expect(inputs(await a.invoke("page", scope)).map((input) => input.inputId)).toEqual([first.input.inputId, second.input.inputId]);
    expect(publicEvents(await a.invoke("page", scope))).toHaveLength(1);
  });

  it("T10/T20/T21: keeps a zero-segment decision deferred until an independent result wakes it", async () => {
    const { a, b } = await peers();
    const slow = await accept(a, "slow", "Research the slow question.");
    const independent = await accept(b, "independent", "Answer the independent question.");
    const deferred = await complete(a, slow.workId, "slow-run", claim("slow-claim", "The slow result is ready but need not be said yet."));
    const lease = required(await a.invoke("acquireExpression", scope, "defer-owner"), "defer lease");
    const basis = required(await a.invoke("expressionSnapshot", scope, lease), "defer basis");
    const silence = await a.invoke("publish", scope, lease, "defer-slow", basis, {
      sends: [], decisions: [{ resultId: deferred.resultId, productRevision: deferred.productRevision, kind: "deferred" }],
    });
    expect(silence).toEqual({ status: "committed", utterances: [] });
    expect(publicEvents(await b.invoke("page", scope))).toEqual([]);
    expect((await a.invoke("expressionSnapshot", scope, lease))?.results).toEqual([]);
    await expect(a.invoke("publish", scope, lease, "false-coverage", basis, {
      sends: [], decisions: [{ resultId: deferred.resultId, productRevision: deferred.productRevision, kind: "covered", byUtteranceId: "not-published" }],
    })).rejects.toThrow();
    expect(await a.invoke("releaseExpression", scope, lease, basis.wakeVersion)).toBe("released");

    const arriving = await complete(b, independent.workId, "independent-run", claim("independent-claim", "The independent answer is ready."));
    const nextLease = required(await b.invoke("acquireExpression", scope, "next-owner"), "wake after a new result");
    const next = required(await b.invoke("expressionSnapshot", scope, nextLease), "deferred and independent results");
    expect(next.results.map((result) => result.resultId).sort()).toEqual([deferred.resultId, arriving.resultId].sort());
    const both = one(deferred, "The slow and independent results are ready.");
    both.sends[0]!.sources.push(...one(arriving, "").sends[0]!.sources);
    expect((await b.invoke("publish", scope, nextLease, "deferred-wake", next, both)).status).toBe("committed");
    expect(publicEvents(await a.invoke("page", scope))).toHaveLength(1);
  });

  it("T17/T19/T23: refuses unadmitted claims and reuses the exact published artifact only in scope", async () => {
    const { a, b } = await peers();
    const input = await accept(a, "artifact", "Show the offline calculator.");
    const body = "<!doctype html>\r\n<html lang=zh><body>计算 2×3<script>window.fixture = 6</script></body></html>\r\n";
    const visible = claim("supported", "Use the calculator.", { blockIds: ["calculator"] });
    const blocked = claim("unread-flat", "The prior dimensions definitely apply.", { allowedPublicMode: "none" });
    required(await a.invoke("beginWork", scope, input.workId, "artifact-work"), "artifact work");
    const result = required(await a.invoke("completeWork", scope, completion(input.workId, "artifact-work", [visible, blocked], [
      { kind: "artifact_source", blockId: "calculator", artifactKind: "native_html", mediaType: "text/html", body, summary: "Offline calculator" },
    ])), "artifact result");
    const ref = required(result.blocks.find((block) => block.kind === "artifact_ref"), "server-minted artifact reference");
    expect(ref.artifact.sha256).toBe(createHash("sha256").update(body, "utf8").digest("hex"));
    const beforePublication = await b.invoke("artifact", scope, ref.artifact.artifactId);
    const lease = required(await b.invoke("acquireExpression", scope, "artifact-expression"), "artifact expression lease");
    const basis = required(await b.invoke("expressionSnapshot", scope, lease), "artifact expression basis");
    const forged = one(result, "The prior dimensions definitely apply.");
    forged.sends[0].sources[0].claimId = blocked.claimId;
    await expect(b.invoke("publish", scope, lease, "forged-claim", basis, forged)).rejects.toThrow();
    await expect(b.invoke("publish", scope, lease, "forged-block", basis, one(result, "Here is the calculator.", ["other-artifact"]))).rejects.toThrow();
    await expect(b.invoke("publish", scope, lease, "copied-html", basis, one(result, body))).rejects.toThrow();
    expect(publicEvents(await a.invoke("page", scope))).toEqual([]);
    const committed = await b.invoke("publish", scope, lease, "valid-artifact", basis, one(result, "Here is the calculator.", ["calculator"]));
    expect(committed.utterances[0]?.blocks).toContainEqual(ref);
    expect(JSON.stringify(committed)).not.toContain("window.fixture");
    expect(await a.invoke("artifact", scope, ref.artifact.artifactId)).toEqual({ artifact: ref.artifact, body });
    expect(await a.invoke("artifact", "fixture-other-persona", ref.artifact.artifactId)).toBeNull();
    expect(beforePublication).toBeNull();
  });
});
