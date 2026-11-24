import { isDialogueWorkStopped, stoppedDialogueParents } from "@/lib/dialogue/work-cancellation";
import { workflowRegistryPages } from "@/lib/chat/workflow-registry-pages";
import { sleep } from "workflow";
import { getHookByToken, getRun, resumeHook, start } from "workflow/api";
import { getWorld } from "workflow/runtime";
import type { DialogueInput, PublicUtterance } from "@/lib/chat/dialogue-contract";
import type { TurnRunResult } from "@/lib/chat/turn-types";
import {
  DIALOGUE_PUBLICATION_CHUNK,
  type DialogueDeliveryEvent,
  type DialogueHolderReceipt,
  type DialogueParentWritable,
  type DialogueOfferEvent,
  type DialogueRunInput,
  type DialogueWakeEvent,
} from "@/lib/dialogue/transport";
import { listDialogueEvents } from "@/lib/dialogue/workflow-offers";
import { readWorkflowStreamPrefix } from "@/lib/dialogue/workflow-stream-prefix";
import { cachedFetch, CACHE_TTLS } from "@/lib/cache/data-cache";
import { mapWithConcurrency } from "@/lib/map-with-concurrency";
import { projectWorkSnapshot, workUpdateAsDialogueCandidate, type WorkSnapshot, type WorkUpdateEvent } from "@/lib/dialogue/work-contract";
import {
  DIALOGUE_HEARTBEAT_MS,
  dialogueRunStale,
  dialogueRunUsable,
  type DialogueOrchestrationWorld,
} from "@/lib/dialogue/orchestrator";
import {
  dialogueCandidateFailed,
  forwardedDialogueWakes,
  responsibleDialogueRun,
  sessionLastWakeAt,
  type DialogueRuntimeEvent,
  type DialogueRunState,
} from "@/lib/dialogue/coordination";
import {
  publishThoughtDeliveryStep,
  recordDialogueWakeStep,
  startDialogueRecordRunStep,
} from "./dialogue-transport-steps";

export interface DialogueWorldSnapshot extends DialogueOrchestrationWorld {
  wakes: DialogueWakeEvent[];
}

export interface DialogueEnsureRequest {
  scope: string;
  parentRunId: string;
  sourceInputId: string;
  workId: string;
  triggerKey: string;
  candidateKeys: string[];
}

export interface DialogueOrchestratorArgs {
  scope: string;
  sessionId?: string;
  handoffFrom?: string;
  handoffReason?: "budget" | "session_expiry";
  /** First wake is supplied at creation so no notification is required to
   *  lose before the Actor has registered its hook. */
  initialWake?: DialogueWakeEvent;
  /** Test-only shortening; production always uses the 30-minute default. */
  idleMs?: number;
}

const MAX_HOLDER_STREAM_CHUNKS = 128;

function iso(value: unknown): string {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
  return new Date(0).toISOString();
}

function runtimeEvent(value: unknown): DialogueRuntimeEvent | undefined {
  if (!value || typeof value !== "object") return undefined;
  const event = value as DialogueRuntimeEvent;
  if (event.type === "lease_acquired" || event.type === "heartbeat" || event.type === "handoff_wait" || event.type === "exit_intent" ||
      event.type === "exit_commit" || event.type === "continued" || event.type === "delegated" ||
      event.type === "wording_started" || event.type === "expression_outcome" || event.type === "world_degraded") return event;
  return undefined;
}

async function readDialogueStream(runId: string, cacheScope?: string, maxChunks?: number) {
  const { entries, nextStreamIndex } = await readWorkflowStreamPrefix(
    runId, undefined, value => {
      const chunk = value as { type?: unknown; data?: unknown };
      const candidate = chunk.data as PublicUtterance | undefined;
      const publication = chunk.type === DIALOGUE_PUBLICATION_CHUNK && typeof candidate?.utteranceId === "string"
        ? candidate : undefined;
      const event = runtimeEvent(chunk.data);
      return publication || event ? { publication, event } : undefined;
    }, { cacheScope, maxChunks });
  const publications = new Map<string, PublicUtterance>();
  const events: DialogueRuntimeEvent[] = [];
  for (const { publication, event } of entries) {
    if (publication && !publications.has(publication.utteranceId)) publications.set(publication.utteranceId, publication);
    if (event) events.push(event);
  }
  return { publications: [...publications.values()], events, nextStreamIndex };
}

// Keep deployed workflow IDs discoverable across compiler or source-path
// changes. These are the two entry points that have created thinking/Actor
// runs since their respective roles were introduced.
const DEPLOYED_TURN_WORKFLOW = "workflow//./src/app/api/chat/turn-workflow//turnWorkflow";
const DEPLOYED_ACTOR_WORKFLOW = "workflow//./src/app/api/chat/dialogue-orchestrator-workflow//dialogueOrchestratorWorkflow";

async function listDialogueRegistry(includeActors: boolean, status?: "running" | "pending") {
  const world = await getWorld();
  const { turnWorkflow } = await import("./turn-workflow");
  const names = new Set([DEPLOYED_TURN_WORKFLOW]);
  // start() uses this compiler-assigned metadata as the stored workflowName.
  // Plain TypeScript execution (e.g. tests) has no compiler metadata.
  const compiledTurnId = Reflect.get(turnWorkflow, "workflowId");
  if (typeof compiledTurnId === "string" && compiledTurnId) names.add(compiledTurnId);
  if (includeActors) {
    const { dialogueOrchestratorWorkflow } = await import("./dialogue-orchestrator-workflow");
    names.add(DEPLOYED_ACTOR_WORKFLOW);
    const compiledActorId = Reflect.get(dialogueOrchestratorWorkflow, "workflowId");
    if (typeof compiledActorId === "string" && compiledActorId) names.add(compiledActorId);
  }
  type Row = Awaited<ReturnType<typeof world.runs.list>>["data"][number];
  const pages = await Promise.all([...names].map(async workflowName => {
    const rows: Row[] = [];
    for await (const page of workflowRegistryPages(world, { workflowName, status })) rows.push(...page);
    return rows;
  }));
  // Interleave the independent name queries in registry order rather than
  // letting the order of the queries affect tied publications or wake events.
  const rows = new Map(pages.flat().map(row => [row.runId, row]));
  return [...rows.values()].sort((a, b) => iso(b.createdAt).localeCompare(iso(a.createdAt)) ||
    b.runId.localeCompare(a.runId));
}

/** The thinking model only needs other active investigations. Read their scoped
 * start facts, not every old Actor, public wording stream and completed turn. */
export async function readDialogueAdmissionStep(scope: string, inputId: string): Promise<{
  otherWorks: DialogueOrchestrationWorld["works"]; holder?: DialogueHolderReceipt;
}> {
  "use step";
  const lookupHolder = async () => {
    try {
      const hook = await getHookByToken(`dialogue-execution:${scope}`);
      const row = await (await getWorld()).runs.get(hook.runId, { resolveData: "none" });
      if (row.attributes?.scope === scope && row.attributes.role === "dialogueOrchestrator" &&
          (row.status === "running" || row.status === "pending")) {
        return { runId: row.runId, sessionId: row.attributes.session ?? row.runId };
      }
    } catch { /* Offers perform authoritative discovery if this optional hint is unavailable. */ }
  };
  const [running, pending, holder] = await Promise.all([
    listDialogueRegistry(false, "running"), listDialogueRegistry(false, "pending"), lookupHolder(),
  ]);
  const siblings = [...new Map([...running, ...pending].map(row => [row.runId, row])).values()].filter(row =>
    row.attributes?.scope === scope && row.attributes.role === "thinking" && row.attributes.turn &&
    row.attributes.turn !== inputId && !isDialogueWorkStopped(row) && (row.status === "running" || row.status === "pending"));
  const otherWorks = await mapWithConcurrency(siblings, 8, async row => {
    const attrs = row.attributes!;
    const events = await listDialogueEvents(row.runId);
    const start = events.find(event => event.type === "thought_started" && event.sourceInputId === attrs.turn);
    const latest = events.findLast(event => event.type === "work_completed" || event.type === "work_checkpoint" || event.type === "offer");
    return { runId: row.runId, workId: attrs.work ?? attrs.turn!, inputId: attrs.turn!, status: row.status,
      acceptedAt: attrs.acceptedAt ?? iso(row.createdAt), text: start?.type === "thought_started" ? start.input.text : "",
      latestStage: latest?.type === "work_completed" || latest?.type === "offer" && latest.stage === "final"
        ? "completed" as const : latest ? "checkpoint" as const : "started" as const };
  });
  return { otherWorks, ...(holder ? { holder } : {}) };
}

/** Build the world entirely from Workflow registry and durable streams. */
export async function readDialogueWorldStep(scope: string): Promise<DialogueWorldSnapshot> {
  "use step";
  return readDialogueWorld(scope);
}

async function readDialogueWorld(scope: string, activatingInputId?: string): Promise<DialogueWorldSnapshot> {
  const startedAt = performance.now();
  const rows = await listDialogueRegistry(true);
  const registryMs = Math.round(performance.now() - startedAt);
  const works: DialogueWorldSnapshot["works"] = [];
  const inputs = new Map<string, DialogueInput>();
  const starts: DialogueWorldSnapshot["starts"] = [];
  const offers: DialogueOfferEvent[] = [];
  const wakes: DialogueWakeEvent[] = [];
  const publications: PublicUtterance[] = [];
  const dialogueRuns: DialogueRunState[] = [];
  // Cold admission needs other work facts, but this input has no Actor or
  // session history to discover until an Actor exists in its scope.
  const skipInput = activatingInputId && !rows.some(({ attributes }) =>
    attributes?.scope === scope && attributes.role === "dialogueOrchestrator") ? activatingInputId : undefined;
  const relevant = rows.filter(({ attributes }) => attributes?.scope === scope &&
    (attributes.role === "dialogueOrchestrator" ||
      (attributes.role === "thinking" && attributes.turn && attributes.turn !== skipInput &&
        (attributes.delivery === "orchestrator" || attributes.acceptedAt))));
  // Each stream is authoritative for one run. Read independent runs in
  // parallel, then fold them in registry order just as in a serial replay.
  const histories = await mapWithConcurrency(relevant, 8, async row => {
    const attributes = row.attributes!;
    const cacheScope = ["completed", "failed", "cancelled"].includes(row.status) ? scope : undefined;
    if (attributes.role === "dialogueOrchestrator") {
      return { kind: "actor", row, attributes, stream: await readDialogueStream(row.runId, cacheScope) } as const;
    }
    const events = await listDialogueEvents(row.runId, cacheScope);
    const inputId = attributes.turn!;
    const started = events.find(event => event.type === "thought_started" && event.sourceInputId === inputId);
    if (attributes.delivery !== "orchestrator" && !started) return null;
    let completedSource: DialogueInput | null = null;
    if (row.status === "completed") {
      try {
        // The returned product may contain private reasoning. Only its input
        // identity is needed here. A failed read can retry on the next pass.
        completedSource = await cachedFetch(["workflow", "dialogue-input-v1", scope, row.runId],
          CACHE_TTLS.BLOB_SECONDS, [], async () => (await getRun<TurnRunResult>(row.runId).returnValue)?.dialogueWork?.source ?? null);
      } catch { /* The committed start event remains sufficient for this pass. */ }
    }
    return { kind: "thinking", row, attributes, inputId, started, events, completedSource } as const;
  });
  for (const history of histories) {
    if (!history) continue;
    const { row, attributes } = history;
    if (history.kind === "thinking") {
      const { inputId, events, started, completedSource } = history;
      let input: DialogueInput = {
        inputId,
        clientMessageId: attributes.clientMessageId ?? inputId,
        userSeq: 0,
        eventSeq: 0,
        acceptedAt: attributes.acceptedAt ?? iso(row.createdAt),
        text: "",
      };
      if (started?.type === "thought_started") {
        input = { ...started.input };
        starts.push({ ...started, input });
      }
      if (completedSource) input = { ...completedSource };
      inputs.set(inputId, input);
      const latest = events.findLast(event => event.type === "offer" || event.type === "work_checkpoint" || event.type === "work_completed");
      works.push({
        runId: row.runId, workId: attributes.work ?? inputId, inputId, status: isDialogueWorkStopped(row) ? "cancelled" : row.status,
        text: input.text, acceptedAt: input.acceptedAt,
        latestStage: latest?.type === "work_completed" || latest?.type === "offer" && latest.stage === "final"
          ? "completed" : latest ? "checkpoint" : "started",
      });
      offers.push(...events.flatMap(event => event.type === "offer" ? [event]
        : event.type === "work_checkpoint" || event.type === "work_completed" ? [workUpdateAsDialogueCandidate(event)] : []));
      wakes.push(...events.filter((event): event is DialogueWakeEvent => event.type === "dialogue_wake"));
    } else {
      const { stream } = history;
      publications.push(...stream.publications);
      wakes.push(...forwardedDialogueWakes(stream.events));
      dialogueRuns.push({
        runId: row.runId,
        status: row.status,
        createdAt: iso(row.createdAt),
        sessionId: attributes.session ?? row.runId,
        events: stream.events,
        nextStreamIndex: stream.nextStreamIndex,
      });
    }
  }
  for (const run of dialogueRuns) {
    run.sessionId = wakes.findLast(wake => wake.runId === run.runId)?.sessionId ?? run.sessionId;
  }
  const orderedInputs = [...inputs.values()].sort((a, b) => a.acceptedAt.localeCompare(b.acceptedAt));
  orderedInputs.forEach((input, index) => {
    input.userSeq = index + 1;
    input.eventSeq = index + 1;
  });
  // A sequence is local to its source work. Across inputs, use the time the
  // handoff became available; a new work starts numbering at one again.
  const offerTime = (offer: DialogueOfferEvent) => offer.acceptedAt ?? inputs.get(offer.sourceInputId)?.acceptedAt ?? "";
  offers.sort((a, b) => offerTime(a).localeCompare(offerTime(b)) ||
    (a.publicSeq ?? 0) - (b.publicSeq ?? 0) || a.offerId.localeCompare(b.offerId));
  publications.sort((a, b) => a.committedAt.localeCompare(b.committedAt) || a.publicSeq - b.publicSeq);
  dialogueRuns.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  if (process.env.VERCEL_ENV === "production") {
    console.log(`[dialogue-world] ${JSON.stringify({ registryMs, elapsedMs: Math.round(performance.now() - startedAt),
      registryRows: rows.length, relevantRuns: relevant.length, actors: dialogueRuns.length, works: works.length })}`);
  }
  return { scope, works, inputs: orderedInputs, starts, dialogueRuns, offers, publications, wakes };
}

/** Read another work's public handoffs without exposing its private reasoning. */
export async function readWorkSnapshotStep(scope: string, workId: string): Promise<WorkSnapshot | null> {
  "use step";
  const row = (await listDialogueRegistry(false)).find(candidate =>
    candidate.attributes?.role === "thinking" && candidate.attributes.scope === scope &&
    (candidate.attributes.work ?? candidate.attributes.turn) === workId);
  if (!row) return null;
  const events = await listDialogueEvents(row.runId);
  const updates = events.filter((event): event is WorkUpdateEvent =>
    event.type === "work_checkpoint" || event.type === "work_completed");
  const started = events.find(event => event.type === "thought_started");
  const inputId = started?.type === "thought_started" ? started.sourceInputId : row.attributes?.turn ?? workId;
  const acceptedAt = started?.type === "thought_started" ? started.acceptedAt : row.attributes?.acceptedAt ?? iso(row.createdAt);
  const status = isDialogueWorkStopped(row) ? "cancelled" : row.status;
  if (status !== "pending" && status !== "running" && status !== "completed" && status !== "failed" && status !== "cancelled") return null;
  return projectWorkSnapshot({ workId, inputId, runId: row.runId, status, acceptedAt, updates });
}

async function startDialogueRun(args: DialogueOrchestratorArgs) {
  const { dialogueOrchestratorWorkflow } = await import("./dialogue-orchestrator-workflow");
  return start(dialogueOrchestratorWorkflow, [args], {
    region: "hkg1",
    attributes: {
      role: "dialogueOrchestrator",
      scope: args.scope,
      triggeredAt: new Date().toISOString(),
      ...(args.sessionId ? { session: args.sessionId } : {}),
      ...(args.handoffFrom ? { handoffFrom: args.handoffFrom } : {}),
    },
  });
}

function hookMissing(error: unknown): boolean {
  return error instanceof Error && error.name === "HookNotFoundError";
}

function leavingDialogueRun(run: DialogueRunState): boolean {
  return run.events.some(event => event.type === "continued" || event.type === "delegated" ||
    event.type === "exit_commit" || event.type === "world_degraded");
}

function dialogueWake(request: DialogueEnsureRequest, holder: DialogueHolderReceipt, now: number): DialogueWakeEvent {
  return {
    type: "dialogue_wake", ...holder, parentRunId: request.parentRunId, sourceInputId: request.sourceInputId,
    workId: request.workId, triggerKey: request.triggerKey, candidateKeys: request.candidateKeys,
    wakeAt: new Date(now).toISOString(), reused: true,
  };
}

async function resumeKnownDialogueHolder(request: DialogueEnsureRequest, holder: DialogueHolderReceipt,
  writeWake: (event: DialogueWakeEvent) => Promise<void>) {
  let hook: Awaited<ReturnType<typeof getHookByToken>>;
  let wake: DialogueWakeEvent;
  try {
    const world = await getWorld();
    const [currentHook, row] = await Promise.all([
      getHookByToken(`dialogue-execution:${request.scope}`), world.runs.get(holder.runId, { resolveData: "none" }),
    ]);
    if (currentHook.runId !== holder.runId || row.runId !== holder.runId || row.attributes?.scope !== request.scope ||
        row.attributes.role !== "dialogueOrchestrator" || (row.attributes.session ?? row.runId) !== holder.sessionId ||
        (row.status !== "running" && row.status !== "pending")) return;
    const { events } = await readDialogueStream(holder.runId, undefined, MAX_HOLDER_STREAM_CHUNKS);
    const run: DialogueRunState = { ...holder, status: row.status, createdAt: iso(row.createdAt), events };
    const now = Date.now();
    if (leavingDialogueRun(run) || request.candidateKeys.some(id => dialogueCandidateFailed(run, id)) ||
        Date.parse(run.createdAt) > now || !dialogueRunUsable(run.status, run.createdAt, now)) return;
    const phase = events.findLast(event => event.type === "heartbeat" || event.type === "handoff_wait" ||
      event.type === "exit_intent");
    // Only a fresh idle intent proves that no other thought's wake could have
    // already waited a heartbeat. An older one needs the full wake history.
    const progressAge = now - Date.parse(phase?.at ?? run.createdAt);
    if (phase?.type === "handoff_wait" || !(progressAge >= 0 && progressAge < DIALOGUE_HEARTBEAT_MS)) return;
    hook = currentHook;
    wake = dialogueWake(request, holder, now);
  } catch {
    // Read-only uncertainty is safe to resolve through normal discovery.
    return;
  }
  try {
    // Bind this write to the checked hook ID. A token lookup here could
    // redirect it to an unchecked successor. Only a missing hook proves that
    // no write committed. Other errors go back to the durable work witness.
    const resumed = await resumeHook(hook, wake);
    if (resumed.runId !== holder.runId) throw new Error("Unexpected dialogue hook owner");
  } catch (error) {
    if (hookMissing(error)) return;
    throw error;
  }
  await writeWake(wake);
  return holder;
}

async function resumeExistingActor(scope: string, wake: DialogueWakeEvent) {
  // start() returns before the new run can register its hook. Give that real
  // registration a bounded chance instead of creating a duplicate immediately.
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await resumeHook(`dialogue-execution:${scope}`, wake);
    } catch (error) {
      if (!hookMissing(error)) throw error;
      if (attempt < 4) await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  return null;
}

/** A racing startup may have missed the lease that another Actor just registered. */
export async function forwardDialogueWakeStep(scope: string, wake: DialogueWakeEvent): Promise<boolean> {
  "use step";
  try {
    return (await resumeHook(`dialogue-execution:${scope}`, wake)).runId === wake.runId;
  } catch (error) {
    if (hookMissing(error)) return false;
    throw error;
  }
}

/** Resume the one live Actor, or create it with the first wake already attached. */
export async function ensureDialogueOrchestratorStep(request: DialogueEnsureRequest, knownHolder?: DialogueHolderReceipt,
  parentWritable?: DialogueParentWritable): Promise<{
  runId: string;
  sessionId: string;
  reused: boolean;
  otherWorks: DialogueOrchestrationWorld["works"];
}> {
  "use step";
  const writeWake = parentWritable ? (event: DialogueWakeEvent) => recordDialogueWakeStep(event, parentWritable) : recordDialogueWakeStep;
  // Only a persisted work update passes the start receipt. Admission and the
  // delivery witness always discover the authoritative world and other works.
  if (knownHolder) {
    const resumed = await resumeKnownDialogueHolder(request, knownHolder, writeWake);
    if (resumed) return { ...resumed, reused: true, otherWorks: [] };
  }
  const world = await readDialogueWorld(request.scope, request.sourceInputId);
  const otherWorks = world.works.filter(work => work.inputId !== request.sourceInputId);
  const runs = new Map(world.dialogueRuns.map(run => [run.runId, run]));
  const newest = world.dialogueRuns.at(-1);
  const existing = newest ? responsibleDialogueRun(newest, runs) : undefined;
  const now = Date.now();
  if (existing) {
    const lastWakeAt = sessionLastWakeAt(existing, world.wakes);
    const failed = request.candidateKeys.some(key => dialogueCandidateFailed(existing!, key));
    if (!failed && !leavingDialogueRun(existing) && dialogueRunUsable(existing.status, lastWakeAt, now)) {
      const wake = dialogueWake(request, { runId: existing.runId, sessionId: existing.sessionId }, now);
      const resumed = await resumeExistingActor(request.scope, wake);
      if (resumed) {
        // The hook can change owners after discovery. Persist the session of
        // the Actor which accepted the wake, including a just-started holder.
        let sessionId = runs.get(resumed.runId)?.sessionId;
        if (!sessionId) {
          const row = await (await getWorld()).runs.get(resumed.runId, { resolveData: "none" });
          if (row.attributes?.role !== "dialogueOrchestrator" || row.attributes.scope !== request.scope) {
            throw new Error("The resumed dialogue owner does not match its scope");
          }
          sessionId = row.attributes.session ?? resumed.runId;
        }
        await writeWake({ ...wake, runId: resumed.runId, sessionId });
        return { runId: resumed.runId, sessionId, reused: true, otherWorks };
      }
      // A terminal or pre-Actor holder has no live hook. Start below and let
      // its lease resolve ownership; the Workflow facts remain the backstop.
    }
  }
  const sessionId = existing && dialogueRunUsable("running", sessionLastWakeAt(existing, world.wakes), now)
    ? existing.sessionId : undefined;
  const initialWake: DialogueWakeEvent = {
    type: "dialogue_wake", runId: "", parentRunId: request.parentRunId,
    sourceInputId: request.sourceInputId, workId: request.workId,
    sessionId: sessionId ?? "", triggerKey: request.triggerKey,
    candidateKeys: request.candidateKeys, wakeAt: new Date(now).toISOString(), reused: false,
  };
  const run = await startDialogueRun({ scope: request.scope, ...(sessionId ? { sessionId } : {}), initialWake });
  const wake = { ...initialWake, runId: run.runId, sessionId: sessionId ?? run.runId };
  await writeWake(wake);
  return { runId: run.runId, sessionId: wake.sessionId, reused: false, otherWorks };
}

export async function stampDialogueTriggerStep(sessionId?: string): Promise<void> {
  "use step";
  const { setAttributes } = await import("workflow");
  await setAttributes({ triggeredAt: new Date().toISOString(), ...(sessionId ? { session: sessionId } : {}) });
}

export async function waitForDialogueRunTerminalStep(runId: string, timeoutMs = DIALOGUE_HEARTBEAT_MS): Promise<string> {
  "use step";
  const world = await getWorld();
  if (world.runs.waitForTerminalStatus) {
    await world.runs.waitForTerminalStatus(runId, { timeoutMs, resolveData: "none" });
    return getRun(runId).status;
  }
  // Worlds without long polling must still return control for liveness checks.
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const status = await getRun(runId).status;
    const remaining = deadline - Date.now();
    if ((status !== "pending" && status !== "running") || remaining <= 0) return status;
    await new Promise(resolve => setTimeout(resolve, Math.min(1_000, remaining)));
  }
}

export async function continueDialogueOrchestratorStep(args: DialogueOrchestratorArgs): Promise<string> {
  "use step";
  return (await startDialogueRun(args)).runId;
}

/** A healthy Actor can stay alive for another session window after publishing.
 * Subscribe from the exact snapshot boundary so a publication between the scan
 * and this subscription is also delivered. The heartbeat bounds the wait. */
async function waitForPublication(run: DialogueRunState, candidateId: string): Promise<boolean> {
  if (run.nextStreamIndex === undefined) {
    await waitForDialogueRunTerminalStep(run.runId);
    return false;
  }
  const reader = getRun(run.runId).getReadable({ startIndex: run.nextStreamIndex }).getReader();
  const deadline = Date.now() + DIALOGUE_HEARTBEAT_MS;
  const timer = setTimeout(() => { void reader.cancel().catch(() => undefined); }, DIALOGUE_HEARTBEAT_MS);
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = next.value as { type?: unknown; data?: unknown };
      if (chunk.type === DIALOGUE_PUBLICATION_CHUNK) {
        const utterance = chunk.data as Partial<PublicUtterance> | null;
        if (typeof utterance?.utteranceId === "string" &&
            utterance.sourceResults?.some(result => result.resultId === candidateId)) return true;
      }
      const event = runtimeEvent(chunk.data);
      if (event?.type === "continued" || event?.type === "delegated" || event?.type === "world_degraded" ||
          (event?.type === "expression_outcome" && event.status === "failed" && event.candidateIds.includes(candidateId))) {
        return false;
      }
    }
  } finally {
    clearTimeout(timer);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  // close() can precede the registry's terminal transition. Avoid repeatedly
  // rebuilding the world while that final step is still committing.
  const remainingMs = deadline - Date.now();
  if (remainingMs > 0) await waitForDialogueRunTerminalStep(run.runId, remainingMs);
  return false;
}

/** One read of the authoritative streams. A sleeping witness checks again in a
 * new durable step, so a provider outage never holds one function invocation. */
async function inspectDeliveryStep(request: DialogueEnsureRequest, runId: string, candidateId: string,
  awaitingSince: number): Promise<"delivered" | "failed" | "pending" | "recover"> {
  "use step";
  const world = await readDialogueWorldStep(request.scope);
  if (world.publications.some(item => item.sourceResults.some(result => result.resultId === candidateId))) return "delivered";
  if (world.works.some(work => work.runId === request.parentRunId && work.status === "cancelled")) return "failed";
  if (world.dialogueRuns.some(run => run.events.some(event => event.type === "expression_outcome" &&
      event.status === "failed" && event.retryable === false && event.candidateIds.includes(candidateId)))) return "failed";
  const runs = new Map(world.dialogueRuns.map(run => [run.runId, run]));
  const first = runs.get(runId);
  if (!first) return "recover";
  let current: DialogueRunState;
  try { current = responsibleDialogueRun(first, runs); }
  catch { return "failed"; }
  if (current.status !== "running" && current.status !== "pending") return "recover";
  if (dialogueCandidateFailed(current, candidateId) || current.events.some(event => event.type === "world_degraded") ||
      dialogueRunStale(current, world.wakes, Date.now(), awaitingSince)) return "recover";
  return await waitForPublication(current, candidateId) ? "delivered" : "pending";
}

/** Runs in the parent workflow. The same persisted candidate is retried without
 * replaying the thought, tools or memory writes, or requiring another input. */
export async function witnessDialogueDeliveryStep(request: DialogueEnsureRequest, initialRunId: string,
  candidateId: string): Promise<"delivered" | "failed"> {
  let runId = initialRunId;
  let awaitingSince = Date.now();
  let retryDelayMs = 1_000;
  while (true) {
    const status = await inspectDeliveryStep(request, runId, candidateId, awaitingSince);
    if (status === "delivered" || status === "failed") {
      await publishThoughtDeliveryStep({ type: "thought_delivery_finished", runId: request.parentRunId,
        sourceInputId: request.sourceInputId, candidateId, status, finishedAt: new Date().toISOString() });
      return status;
    }
    if (status === "recover") {
      await sleep(retryDelayMs);
      runId = (await ensureDialogueOrchestratorStep(request)).runId;
      awaitingSince = Date.now();
      retryDelayMs = Math.min(retryDelayMs * 2, 60_000);
    }
  }
}

/** Only needed when an aggregate has already lost a contributor during wording. */
export async function stoppedDialogueParentsStep(runIds: string[]): Promise<string[]> {
  "use step";
  return stoppedDialogueParents(runIds);
}

/** Launch the archive workflow once the exact utterance is public. Each input
 * carries its own slice and attachments; the archivist reads artifacts from
 * the authoritative actor stream without delaying subsequent wording. */
export async function recordDialogueUtteranceStep(args: {
  input: DialogueRunInput;
  utterance: PublicUtterance;
  inputs: DialogueInput[];
  related: DialogueOfferEvent[];
}): Promise<void> {
  const { input, utterance, inputs, related } = args;
  const publicationInputs = inputs.filter(source => utterance.inputIds.includes(source.inputId)).map(source => {
    const environment = related.find(offer => offer.sourceInputId === source.inputId)?.record ??
      (source.inputId === input.context.sourceInputId ? input.context.record : undefined);
    return { input: source, turnId: source.inputId, ...(environment?.sliceId ? { sliceId: environment.sliceId } : {}),
      ...(environment?.images?.length ? { images: environment.images } : {}) };
  });
  await startDialogueRecordRunStep({ source: input.context.source, sourceTurnId: input.context.sourceTurnId,
    environment: input.context.record, utterance, publicationInputs });
}
