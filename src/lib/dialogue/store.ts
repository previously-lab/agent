import { randomUUID } from "node:crypto";
import type { ContentBlockV1, DialogueAccepted, DialogueClaim, DialogueEvent, DialogueInput, DialoguePage, DialogueWork, PublicUtterance } from "@/lib/chat/dialogue-contract";
import { parseNativeSections } from "@/lib/markdown/native-sections";
import type { TurnInput } from "@/lib/chat/turn-types";
import type { ThinkingProduct } from "@/lib/agents/thinking-product";
import { authorizePublishedArtifacts, digest, readOwnedArtifact, readScopedArtifact, storeResultBlocks } from "./artifacts";
import type { DialogueStorage } from "./storage";
import { DialogueRows, withDialogueScope, type ScopeState } from "./rows";
import type { DialogueOutboxJob, DialogueResult, DialogueWorkRecord, DraftContentBlock, ExpressionBasis, ExpressionFence, ExpressionPlan, ExpressionSnapshot, OutboxPayload, SavedExpressionPlan, TaskDeliveryIntent } from "./types";

const LEASE_MS = 45_000;
const JOB_LEASE_MS = 30_000;
const MAX_ACTIVE_WORKS = 64;
const LIVE = ["queued", "running"];
const stamp = (ms: number) => new Date(ms).toISOString();

export class DialogueConflict extends Error {
  constructor(message: string) { super(message); this.name = "DialogueConflict"; }
}

type NewEvent = DialogueEvent extends infer T ? T extends DialogueEvent ? Omit<T, "eventSeq"> : never : never;
interface InputRecord { input: DialogueInput; signature: string; requestSignature?: string }
interface PlanRecord { signature: string; utterances: PublicUtterance[] }

async function appendEvent(rows: DialogueRows, state: ScopeState, body: NewEvent): Promise<number> {
  const seq = ++state.eventSeq;
  await rows.put("event", String(seq), { ...body, eventSeq: seq }, seq);
  return seq;
}

async function enqueue(rows: DialogueRows, id: string, payload: OutboxPayload, seq: number, now: number): Promise<void> {
  if (await rows.get("outbox", id)) return;
  await rows.put<DialogueOutboxJob>("outbox", id, { id, payload, attempts: 0 }, seq, "ready", now);
}

async function wake(rows: DialogueRows, state: ScopeState, now: number): Promise<void> {
  const version = ++state.wakeVersion;
  await enqueue(rows, `express:${version}`, { kind: "express" }, state.eventSeq, now);
}

function holds(state: ScopeState, fence: ExpressionFence, now: number): boolean {
  return state.lease?.holder === fence.holder && state.lease.epoch === fence.epoch && state.lease.until > now;
}

function workView(work: DialogueWorkRecord): DialogueWork {
  const { workId, inputId, userSeq, status, runId, summary, artifacts } = work;
  return { workId, inputId, userSeq, status, ...(runId ? { runId } : {}), ...(summary ? { summary } : {}), ...(artifacts?.length ? { artifacts } : {}) };
}

async function setWork(rows: DialogueRows, state: ScopeState, work: DialogueWorkRecord, now: number): Promise<void> {
  await rows.put("work", work.workId, work, work.userSeq, work.status, now);
  await appendEvent(rows, state, { type: "work.status", work: workView(work) });
}

async function inputWindow(rows: DialogueRows): Promise<{ inputs: DialogueInput[]; pending: DialogueWork[]; firstRecentUserSeq: number }> {
  const recent = await rows.list<InputRecord>("input", { newest: true, limit: 40 });
  const pending = (await rows.list<DialogueWorkRecord>("work", { states: LIVE, limit: MAX_ACTIVE_WORKS })).map((row) => workView(row.value));
  const inputs = new Map(recent.map(({ value }) => [value.input.inputId, value.input]));
  for (const work of pending) {
    if (inputs.has(work.inputId)) continue;
    const input = await rows.get<InputRecord>("input", work.inputId);
    if (input) inputs.set(work.inputId, input.value.input);
  }
  return { inputs: [...inputs.values()].sort((a, b) => a.userSeq - b.userSeq), pending, firstRecentUserSeq: recent.at(-1)?.seq ?? 1 };
}

export function createDialogueStore(storage: DialogueStorage) {
  const tx = <T>(scope: string, fn: (rows: DialogueRows, state: ScopeState, now: number) => Promise<T>) => withDialogueScope(storage, scope, fn);

  const view = <T>(scope: string, fn: (rows: DialogueRows) => Promise<T>) => storage.view(scope, (files) => fn(new DialogueRows(files, scope)));

  return {
    async accept(scope: string, args: { clientMessageId: string; launch: TurnInput; attachments?: DialogueInput["attachments"]; requestSignature?: string }): Promise<DialogueAccepted> {
      if (!args.clientMessageId.trim() || args.clientMessageId.length > 128) throw new DialogueConflict("Invalid client message id");
      const inputId = digest(JSON.stringify([scope, args.clientMessageId])).slice(0, 24);
      const signature = digest(JSON.stringify([args.launch.lastUserMessage, args.attachments, args.launch.documentContext, args.launch.regenerate ?? false]));
      return tx(scope, async (rows, state, now) => {
        const prior = await rows.get<InputRecord>("input", inputId);
        if (prior) {
          if (args.requestSignature !== undefined ? prior.value.requestSignature !== args.requestSignature : prior.value.signature !== signature) throw new DialogueConflict("This message id already belongs to different input");
          const work = await rows.get<DialogueWorkRecord>("work", inputId);
          return { version: 1, input: prior.value.input, workId: inputId, ...(work?.value.runId ? { runId: work.value.runId } : {}) };
        }
        if ((await rows.list("work", { states: LIVE, limit: MAX_ACTIVE_WORKS })).length === MAX_ACTIVE_WORKS) throw new DialogueConflict("Too many pending turns; retry once one finishes");
        const userSeq = ++state.userSeq;
        const input: DialogueInput = {
          inputId, clientMessageId: args.clientMessageId, userSeq, eventSeq: state.eventSeq + 1,
          acceptedAt: stamp(now), text: args.launch.lastUserMessage,
          ...(args.attachments?.length ? { attachments: args.attachments } : {}),
          ...(args.launch.documentContext?.length ? { documentContext: args.launch.documentContext } : {}),
        };
        const launch = { ...args.launch, turnId: inputId, modelMessages: [], recentTurns: [], dialogue: { scopeKey: scope, workId: inputId } };
        await rows.put<InputRecord>("input", inputId, { input, signature, requestSignature: args.requestSignature }, userSeq);
        const seq = await appendEvent(rows, state, { type: "input.accepted", input });
        await setWork(rows, state, { workId: inputId, inputId, userSeq, status: "queued", launch, acceptedAt: input.acceptedAt }, now);
        await enqueue(rows, `work:${inputId}`, { kind: "start_work", workId: inputId }, seq, now);
        await enqueue(rows, `project:${seq}`, { kind: "project", eventSeq: seq }, seq, now);
        return { version: 1, input, workId: inputId };
      });
    },

    async accepted(scope: string, clientMessageId: string, requestSignature: string): Promise<DialogueAccepted | null> {
      const inputId = digest(JSON.stringify([scope, clientMessageId])).slice(0, 24);
      return view(scope, async (rows) => {
        const prior = await rows.get<InputRecord>("input", inputId);
        if (!prior) return null;
        if (prior.value.requestSignature !== requestSignature) throw new DialogueConflict("This message id already belongs to different input");
        const runId = (await rows.get<DialogueWorkRecord>("work", inputId))?.value.runId;
        return { version: 1, input: prior.value.input, workId: inputId, ...(runId ? { runId } : {}) };
      });
    },

    async regenerate(scope: string, inputId: string, requestId: string): Promise<DialogueAccepted> {
      return tx(scope, async (rows, state, now) => {
        const original = await rows.get<DialogueWorkRecord>("work", inputId);
        const input = (await rows.get<InputRecord>("input", inputId))?.value.input;
        if (!original || !input) throw new DialogueConflict("The original input is unavailable");
        const workId = digest(JSON.stringify([scope, "regenerate", requestId])).slice(0, 24);
        const prior = await rows.get<DialogueWorkRecord>("work", workId);
        if (prior && prior.value.inputId !== inputId) throw new DialogueConflict("This retry id belongs to another input");
        if (!prior) {
          if ((await rows.list("work", { states: LIVE, limit: MAX_ACTIVE_WORKS })).length === MAX_ACTIVE_WORKS) throw new DialogueConflict("Too many pending turns; retry once one finishes");
          const launch = { ...original.value.launch, regenerate: true, startedAtIso: stamp(now), dialogue: { scopeKey: scope, workId } };
          await setWork(rows, state, { workId, inputId, userSeq: input.userSeq, status: "queued", launch, acceptedAt: stamp(now) }, now);
          await enqueue(rows, `work:${workId}`, { kind: "start_work", workId }, state.eventSeq, now);
        }
        return { version: 1, input, workId, ...(prior?.value.runId ? { runId: prior.value.runId } : {}) };
      });
    },

    async work(scope: string, id: string): Promise<DialogueWorkRecord | null> {
      return view(scope, async (rows) => (await rows.get<DialogueWorkRecord>("work", id))?.value ?? null);
    },

    async input(scope: string, id: string): Promise<DialogueInput | null> {
      return view(scope, async (rows) => (await rows.get<InputRecord>("input", id))?.value.input ?? null);
    },

    async result(scope: string, id: string): Promise<DialogueResult | null> {
      return view(scope, async (rows) => (await rows.get<DialogueResult>("result", id))?.value ?? null);
    },

    async event(scope: string, seq: number): Promise<DialogueEvent | null> {
      return view(scope, async (rows) => (await rows.get<DialogueEvent>("event", String(seq)))?.value ?? null);
    },

    async noteLaunch(scope: string, id: string, runId: string): Promise<void> {
      await tx(scope, async (rows, state, now) => {
        const row = await rows.get<DialogueWorkRecord>("work", id);
        if (!row || !LIVE.includes(row.state) || (row.value.runId && row.value.runId !== runId)) return;
        if (!row.value.runId) await setWork(rows, state, { ...row.value, runId }, now);
        await enqueue(rows, `watch-work:${id}`, { kind: "watch_work", workId: id }, state.eventSeq, now + 8_000);
      });
    },

    async beginWork(scope: string, id: string, runId: string) {
      return tx(scope, async (rows, state, now) => {
        const row = await rows.get<DialogueWorkRecord>("work", id);
        if (!row || !LIVE.includes(row.state) || (row.value.runId && row.value.runId !== runId)) return null;
        if (row.state === "queued") await setWork(rows, state, { ...row.value, runId, status: "running" }, now);
        await enqueue(rows, `watch-work:${id}`, { kind: "watch_work", workId: id }, state.eventSeq, now + 8_000);
        const window = await inputWindow(rows);
        const publications = (await rows.list<PublicUtterance>("publication", { newest: true, limit: 24 })).reverse().map((entry) => entry.value);
        return { ...window, publications };
      });
    },

    async bindWorkSlice(scope: string, id: string, runId: string, sliceId: string): Promise<boolean> {
      return tx(scope, async (rows, _state, now) => {
        const row = await rows.get<DialogueWorkRecord>("work", id);
        if (row?.state !== "running" || row.value.runId !== runId) return false;
        if (row.value.sliceId && row.value.sliceId !== sliceId) throw new DialogueConflict("A work cannot move between record slices");
        await rows.put("work", id, { ...row.value, sliceId }, row.seq, row.state, now);
        return true;
      });
    },

    async failWork(scope: string, id: string, runId?: string): Promise<void> {
      await tx(scope, async (rows, state, now) => {
        const row = await rows.get<DialogueWorkRecord>("work", id);
        if (row && LIVE.includes(row.state) && row.value.runId === runId) await setWork(rows, state, { ...row.value, status: "failed" }, now);
      });
    },

    async completeWork(scope: string, args: { workId: string; runId: string; sliceId: string; product: ThinkingProduct; claims: DialogueClaim[]; blocks: DraftContentBlock[]; status: "completed" | "failed"; deliveryIntents?: TaskDeliveryIntent[] }): Promise<DialogueResult | null> {
      return tx(scope, async (rows, state, now) => {
        const row = await rows.get<DialogueWorkRecord>("work", args.workId);
        if (!row || row.value.runId !== args.runId || row.state === "cancelled") return null;
        const resultId = `${args.workId}:1`;
        const signature = digest(JSON.stringify(args));
        const prior = await rows.get<DialogueResult>("result", resultId);
        if (prior) {
          if ((await rows.get<string>("result-signature", resultId))?.value !== signature) throw new DialogueConflict("This work result already has a different immutable version");
          return prior.value;
        }
        if (!LIVE.includes(row.state)) return null;
        const blocks = await storeResultBlocks(rows, resultId, args.blocks);
        const result: DialogueResult = {
          resultId, productRevision: 1, workId: args.workId, inputIds: [row.value.inputId],
          producerRunId: args.runId, sliceId: args.sliceId, availableAt: stamp(now), product: args.product,
          claims: args.claims, blocks,
          ...(args.deliveryIntents?.length ? { deliveryIntents: args.deliveryIntents } : {}),
        };
        await rows.put("result", resultId, result, ++state.resultSeq, "ready");
        await rows.put("result-signature", resultId, signature);
        const summary = args.claims.filter((claim) => claim.allowedPublicMode !== "none").map((claim) => claim.text).join("\n").slice(0, 2_000);
        const artifacts = blocks.flatMap((block) => block.kind === "artifact_ref" ? [block.artifact] : []);
        await setWork(rows, state, { ...row.value, sliceId: args.sliceId, status: args.status, summary, artifacts }, now);
        await enqueue(rows, `result:${resultId}`, { kind: "project_result", resultId }, state.eventSeq, now);
        await wake(rows, state, now);
        return result;
      });
    },

    async expressionDispatch(scope: string): Promise<"start" | "busy" | "done"> {
      return tx(scope, async (rows, state, now) => {
        if (state.pausedThrough >= state.wakeVersion) return "done";
        const ready = await rows.list("result", { states: ["ready", "deferred"], due: state.wakeVersion, limit: 1 });
        if (!ready.length) return "done";
        return state.lease && state.lease.until > now ? "busy" : "start";
      });
    },

    async acquireExpression(scope: string, holder: string): Promise<ExpressionFence | null> {
      return tx(scope, async (rows, state, now) => {
        if (state.pausedThrough >= state.wakeVersion) return null;
        if (state.lease && state.lease.until > now && state.lease.holder !== holder) return null;
        if (state.lease?.holder === holder && state.lease.until > now) return { holder, epoch: state.lease.epoch };
        const fence = { holder, epoch: ++state.epoch };
        state.lease = { ...fence, until: now + LEASE_MS };
        await enqueue(rows, `express-watch:${fence.epoch}`, { kind: "express" }, state.eventSeq, now + LEASE_MS);
        return fence;
      });
    },

    async expressionSnapshot(scope: string, fence: ExpressionFence): Promise<ExpressionSnapshot | null> {
      return tx(scope, async (rows, state, now) => {
        if (!holds(state, fence, now)) return null;
        state.lease!.until = now + LEASE_MS;
        const window = await inputWindow(rows);
        const publications = (await rows.list<PublicUtterance>("publication", { newest: true, limit: 20 })).reverse().map((row) => row.value);
        const results: DialogueResult[] = [];
        for (const row of await rows.list<DialogueResult>("result", { states: ["ready", "deferred"], due: state.wakeVersion, limit: 8 })) {
          const claims: DialogueClaim[] = [];
          for (const claim of row.value.claims) if (!(await rows.get("published-claim", JSON.stringify([row.id, row.value.productRevision, claim.claimId])))) claims.push(claim);
          results.push({ ...row.value, claims });
        }
        return { ...window, inputHighWater: state.userSeq, publicHighWater: state.publicSeq, wakeVersion: state.wakeVersion, publications, results };
      });
    },

    async activePlan(scope: string, fence: ExpressionFence): Promise<SavedExpressionPlan | null> {
      return tx(scope, async (rows, state, now) => holds(state, fence, now)
        ? (await rows.get<SavedExpressionPlan>("expression-plan", "active"))?.value ?? null : null);
    },

    async savePlan(scope: string, fence: ExpressionFence, basis: ExpressionBasis, plan: ExpressionPlan, admitted: string[]): Promise<SavedExpressionPlan | null> {
      return tx(scope, async (rows, state, now) => {
        if (!holds(state, fence, now) || state.userSeq !== basis.inputHighWater || state.publicSeq !== basis.publicHighWater) return null;
        const active = await rows.get<SavedExpressionPlan>("expression-plan", "active");
        if (active) return active.value;
        const ids = new Set(admitted);
        if (plan.sends.some((send) => send.sources.some((source) => !ids.has(source.resultId)))
          || plan.decisions.some((decision) => !ids.has(decision.resultId))) throw new DialogueConflict("Expression cited a result outside its snapshot");
        const saved = { id: randomUUID(), basis, plan, admitted };
        await rows.put("expression-plan", "active", saved);
        return saved;
      });
    },

    async finishPlan(scope: string, fence: ExpressionFence, id: string, defer: boolean): Promise<void> {
      await tx(scope, async (rows, state, now) => {
        if (!holds(state, fence, now)) return;
        const active = await rows.get<SavedExpressionPlan>("expression-plan", "active");
        if (active?.value.id !== id) return;
        if (defer && state.userSeq === active.value.basis.inputHighWater) {
          for (const resultId of active.value.admitted) {
            const row = await rows.get<DialogueResult>("result", resultId);
            if (!row || !["ready", "deferred"].includes(row.state)) continue;
            await rows.put("result", row.id, row.value, row.seq, "deferred", active.value.basis.wakeVersion + 1);
            await rows.put("result-use", `${id}:defer:${row.id}`, { kind: "deferred", nextTrigger: "next_result" });
          }
        }
        await rows.remove("expression-plan", "active");
      });
    },

    async publish(scope: string, fence: ExpressionFence, roundId: string, basis: ExpressionBasis, plan: ExpressionPlan): Promise<{ status: "committed" | "stale"; utterances: PublicUtterance[] }> {
      return tx(scope, async (rows, state, now) => {
        const signature = digest(JSON.stringify([basis, plan]));
        const previous = await rows.get<PlanRecord>("published-plan", roundId);
        if (previous) {
          if (previous.value.signature !== signature) throw new DialogueConflict("Publication retry changed a committed plan");
          return { status: "committed", utterances: previous.value.utterances };
        }
        if (!holds(state, fence, now) || state.userSeq !== basis.inputHighWater || state.publicSeq !== basis.publicHighWater) return { status: "stale", utterances: [] };
        if (plan.sends.length > 4 || plan.decisions.length > 8) throw new DialogueConflict("Expression plan exceeds its budget");
        const utterances: PublicUtterance[] = [];
        const published = new Map<string, Set<string>>();
        const referencedBlocks = new Set<string>();
        for (const [ordinal, send] of plan.sends.entries()) {
          if (send.text.length > 2_000 || /<\/?[a-z][\s\S]*?>|data:[^\s,]*;base64,/i.test(send.text) || parseNativeSections(send.text).some((part) => part.kind === "native")) throw new DialogueConflict("Expression cannot author executable content or embed binary bytes");
          if (!send.sources.length) throw new DialogueConflict("A publication must cite an admitted claim");
          const selected = new Map<string, ContentBlockV1>();
          const sourceResults = new Map<string, PublicUtterance["sourceResults"][number]>();
          const inputIds = new Set<string>();
          const statusText: string[] = [];
          for (const source of send.sources) {
            const row = await rows.get<DialogueResult>("result", source.resultId);
            const result = row?.value;
            const claim = result?.claims.find((candidate) => candidate.claimId === source.claimId);
            if (!row || !["ready", "deferred"].includes(row.state) || row.dueAt > basis.wakeVersion || !result || result.productRevision !== source.productRevision || claim?.allowedPublicMode !== source.mode || !result.product.claims.some((item) => item.claimId === claim.claimId && item.allowedPublicMode === source.mode)) throw new DialogueConflict("Expression source is not admitted for this publication");
            const useId = JSON.stringify([result.resultId, result.productRevision, claim.claimId]);
            if (await rows.get("published-claim", useId)) throw new DialogueConflict("This claim was already published");
            const use = sourceResults.get(result.resultId) ?? { resultId: result.resultId, productRevision: result.productRevision, claimIds: [] };
            if (use.claimIds.includes(claim.claimId)) throw new DialogueConflict("Duplicate expression claim");
            use.claimIds.push(claim.claimId);
            sourceResults.set(result.resultId, use);
            const claims = published.get(result.resultId) ?? new Set<string>();
            if (claims.has(claim.claimId)) throw new DialogueConflict("The same claim cannot be sent twice in one round");
            claims.add(claim.claimId);
            published.set(result.resultId, claims);
            for (const id of result.inputIds) inputIds.add(id);
            if (source.mode === "status") statusText.push(claim.text);
            else for (const block of result.blocks) if (claim.blockIds?.includes(block.blockId)) selected.set(block.blockId, block);
          }
          const utteranceId = `${roundId}:${ordinal + 1}`;
          // A status-only permission cannot be turned into a factual finding by
          // supplying different prose under the same claim id.
          if (statusText.length && statusText.length !== send.sources.length) throw new DialogueConflict("Status and findings need separate segments");
          const text = statusText.length ? statusText.join("\n\n") : send.text.trim();
          const blocks: ContentBlockV1[] = text ? [{ kind: "markdown", blockId: `${utteranceId}:text`, text }] : [];
          for (const id of send.blockIds) {
            const block = selected.get(id);
            if (!block || referencedBlocks.has(id)) throw new DialogueConflict("Artifact or content block is not admitted for this publication");
            referencedBlocks.add(id);
            blocks.push(block);
          }
          if (!blocks.length) throw new DialogueConflict("An empty publication is not a message");
          await authorizePublishedArtifacts(rows, blocks);
          const utterance = { utteranceId, publicSeq: ++state.publicSeq, committedAt: stamp(now), inputIds: [...inputIds], sourceResults: [...sourceResults.values()], blocks };
          await rows.put("publication", utteranceId, utterance, utterance.publicSeq);
          for (const use of utterance.sourceResults) for (const id of use.claimIds) await rows.put("published-claim", JSON.stringify([use.resultId, use.productRevision, id]), utteranceId);
          const seq = await appendEvent(rows, state, { type: "manuscript.append", utterance });
          await enqueue(rows, `project:${seq}`, { kind: "project", eventSeq: seq }, seq, now);
          utterances.push(utterance);
        }
        for (const decision of plan.decisions) {
          const row = await rows.get<DialogueResult>("result", decision.resultId);
          if (!row || row.value.productRevision !== decision.productRevision || !["ready", "deferred"].includes(row.state) || row.dueAt > basis.wakeVersion || published.has(row.id)) throw new DialogueConflict("Invalid expression decision basis");
          if (decision.kind === "covered") {
            const covered = decision.byUtteranceId && await rows.get<PublicUtterance>("publication", decision.byUtteranceId);
            if (!covered || !covered.value.sourceResults.some((use) => use.resultId === row.id && use.productRevision === decision.productRevision && row.value.claims.filter((claim) => claim.allowedPublicMode !== "none").every((claim) => use.claimIds.includes(claim.claimId)))) throw new DialogueConflict("Coverage requires a committed publication of these claims");
          }
          await rows.put("result", row.id, row.value, row.seq, decision.kind === "covered" ? "covered" : "deferred", basis.wakeVersion + 1);
          await rows.put("result-use", `${roundId}:${row.id}`, { ...decision, nextTrigger: decision.kind === "deferred" ? "next_result" : undefined });
        }
        for (const [id, ids] of published) {
          const row = (await rows.get<DialogueResult>("result", id))!;
          const eligible = row.value.claims.filter((claim) => claim.allowedPublicMode !== "none");
          let complete = true;
          for (const claim of eligible) if (!(await rows.get("published-claim", JSON.stringify([id, row.value.productRevision, claim.claimId])))) complete = false;
          await rows.put("result", id, row.value, row.seq, complete ? "consumed" : "ready", complete ? basis.wakeVersion + 1 : row.dueAt);
          await rows.put("result-use", `${roundId}:${id}`, { kind: "published", claimIds: [...ids], utteranceIds: utterances.filter((utterance) => utterance.sourceResults.some((use) => use.resultId === id)).map((utterance) => utterance.utteranceId) });
        }
        await rows.put<PlanRecord>("published-plan", roundId, { signature, utterances });
        return { status: "committed", utterances };
      });
    },

    async deferSnapshot(scope: string, fence: ExpressionFence, basis: ExpressionBasis, ids: string[]): Promise<void> {
      await tx(scope, async (rows, state, now) => {
        if (!holds(state, fence, now) || state.userSeq !== basis.inputHighWater) return;
        for (const id of ids) {
          const row = await rows.get<DialogueResult>("result", id);
          if (row && ["ready", "deferred"].includes(row.state) && row.dueAt <= basis.wakeVersion) {
            await rows.put("result", id, row.value, row.seq, "deferred", basis.wakeVersion + 1);
          }
        }
      });
    },

    async releaseExpression(scope: string, fence: ExpressionFence, observedWake: number, yieldWithWork = false): Promise<"released" | "continue" | "lost"> {
      return tx(scope, async (rows, state, now) => {
        if (!holds(state, fence, now)) return "lost";
        const ready = await rows.list("result", { states: ["ready", "deferred"], due: state.wakeVersion, limit: 1 });
        if (ready.length && !yieldWithWork) return "continue";
        delete state.lease;
        if (ready.length || state.wakeVersion !== observedWake) await enqueue(rows, `express-resume:${fence.epoch}`, { kind: "express" }, state.eventSeq, now + 250);
        return "released";
      });
    },

    async stop(scope: string, workId?: string): Promise<{ runId?: string }> {
      return tx(scope, async (rows, state, now) => {
        if (workId) {
          const row = await rows.get<DialogueWorkRecord>("work", workId);
          if (!row || !LIVE.includes(row.state)) return {};
          await setWork(rows, state, { ...row.value, status: "cancelled" }, now);
          return { runId: row.value.runId };
        }
        const runId = state.lease?.holder;
        state.pausedThrough = state.wakeVersion;
        state.epoch++;
        delete state.lease;
        return { runId };
      });
    },

    async recordProjection(scope: string, key: string, receipt: { inputIds: string[]; utteranceIds: string[]; sliceId: string }): Promise<void> {
      await tx(scope, async (rows, state) => {
        if (await rows.get("projection-receipt", key)) return;
        await rows.put("projection-receipt", key, receipt);
        await appendEvent(rows, state, { type: "projection.receipt", ...receipt });
      });
    },

    async page(scope: string, after = 0, limit = 100): Promise<DialoguePage> {
      return tx(scope, async (rows, state, now) => {
        const events = await rows.list<DialogueEvent>("event", { after, limit: Math.min(200, Math.max(1, limit)) + 1 });
        const hasMore = events.length > Math.min(200, Math.max(1, limit));
        if (hasMore) events.pop();
        const expression = state.pausedThrough >= state.wakeVersion ? "paused" : state.lease && state.lease.until > now ? "running" : "idle";
        return { version: 1, events: events.map((row) => row.value), cursor: events.at(-1)?.seq ?? after, hasMore, expression };
      });
    },

    artifact(scope: string, id: string) { return view(scope, (rows) => readScopedArtifact(rows, id)); },

    resultArtifact(scope: string, resultId: string, id: string) {
      return view(scope, (rows) => readOwnedArtifact(rows, resultId, id));
    },

    async dueScopes(limit = 16): Promise<string[]> {
      return storage.dueScopes(Date.now(), limit);
    },

    async claimOutbox(scope: string): Promise<DialogueOutboxJob | null> {
      return tx(scope, async (rows, state, now) => {
        const [row] = await rows.list<DialogueOutboxJob>("outbox", { states: ["ready", "leased"], due: now, limit: 1 });
        if (!row) return null;
        const value = { ...row.value, attempts: row.value.attempts + 1, lease: randomUUID() };
        await rows.put("outbox", row.id, value, row.seq, "leased", now + JOB_LEASE_MS);
        void state;
        return value;
      });
    },

    async settleOutbox(scope: string, job: DialogueOutboxJob, ok: boolean, retryMs?: number): Promise<void> {
      await tx(scope, async (rows, _state, now) => {
        const row = await rows.get<DialogueOutboxJob>("outbox", job.id);
        if (!row || row.state !== "leased" || row.value.lease !== job.lease) return;
        await rows.put("outbox", row.id, row.value, row.seq, ok ? "done" : "ready", ok ? 0 : now + (retryMs ?? Math.min(60_000, 250 * 2 ** Math.min(job.attempts, 8))));
      });
    },
  };
}

export type DialogueStore = ReturnType<typeof createDialogueStore>;
