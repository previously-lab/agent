import { getRun, resumeHook, start } from "workflow/api";
import { getWorld } from "workflow/runtime";
import type { DialogueInput, PublicUtterance } from "@/lib/chat/dialogue-contract";
import type { TurnRunResult } from "@/lib/chat/turn-types";
import {
  DIALOGUE_PUBLICATION_CHUNK,
  type DialogueDeliveryEvent,
  type DialogueOfferEvent,
  type DialogueRunInput,
  type DialogueTypedArtifact,
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
} from "./dialogue-transport-steps";
import { projectDialogueRecords } from "@/lib/episodic/dialogue-records";
import { ringReflection } from "./steps";

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

const MAX_DELIVERY_REPLACEMENTS = 2;

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
      event.type === "expression_outcome" || event.type === "world_degraded") return event;
  return undefined;
}

async function readDialogueStream(runId: string, cacheScope?: string) {
  const { entries, nextStreamIndex } = await readWorkflowStreamPrefix(
    runId, undefined, value => {
      const chunk = value as { type?: unknown; data?: unknown };
      const candidate = chunk.data as PublicUtterance | undefined;
      const publication = chunk.type === DIALOGUE_PUBLICATION_CHUNK && typeof candidate?.utteranceId === "string"
        ? candidate : undefined;
      const event = runtimeEvent(chunk.data);
      return publication || event ? { publication, event } : undefined;
    }, cacheScope);
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

async function listDialogueRegistry(includeActors: boolean) {
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
    let cursor: string | undefined;
    do {
      const page = await world.runs.list({
        workflowName, pagination: { limit: 100, sortOrder: "desc", cursor }, resolveData: "none",
      });
      rows.push(...page.data);
      if (!page.hasMore) break;
      if (!page.cursor || page.cursor === cursor) throw new Error("Workflow registry pagination did not advance");
      cursor = page.cursor;
    } while (true);
    return rows;
  }));
  // Interleave the independent name queries in registry order rather than
  // letting the order of the queries affect tied publications or wake events.
  const rows = new Map(pages.flat().map(row => [row.runId, row]));
  return [...rows.values()].sort((a, b) => iso(b.createdAt).localeCompare(iso(a.createdAt)) ||
    b.runId.localeCompare(a.runId));
}

/** Build the world entirely from Workflow registry and durable streams. */
export async function readDialogueWorldStep(scope: string): Promise<DialogueWorldSnapshot> {
  "use step";
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
  const relevant = rows.filter(({ attributes }) => attributes?.scope === scope &&
    (attributes.role === "dialogueOrchestrator" ||
      (attributes.role === "thinking" && attributes.turn && (attributes.delivery === "orchestrator" || attributes.acceptedAt))));
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
        runId: row.runId, workId: attributes.work ?? inputId, inputId, status: row.status,
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
  offers.sort((a, b) => (a.publicSeq ?? 0) - (b.publicSeq ?? 0) || a.offerId.localeCompare(b.offerId));
  publications.sort((a, b) => a.publicSeq - b.publicSeq || a.committedAt.localeCompare(b.committedAt));
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
  const status = row.status;
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
export async function ensureDialogueOrchestratorStep(request: DialogueEnsureRequest): Promise<{
  runId: string;
  sessionId: string;
  reused: boolean;
  otherWorks: DialogueOrchestrationWorld["works"];
}> {
  "use step";
  const world = await readDialogueWorldStep(request.scope);
  const otherWorks = world.works.filter(work => work.inputId !== request.sourceInputId);
  const runs = new Map(world.dialogueRuns.map(run => [run.runId, run]));
  const newest = world.dialogueRuns.at(-1);
  let existing = newest ? responsibleDialogueRun(newest, runs) : undefined;
  const now = Date.now();
  if (existing) {
    const lastWakeAt = sessionLastWakeAt(existing, world.wakes);
    const stale = dialogueRunStale(existing, world.wakes, now);
    const failed = request.candidateKeys.some(key => dialogueCandidateFailed(existing!, key));
    if (stale && (existing.status === "pending" || existing.status === "running")) {
      await cancelDialogueRunStep(existing.runId);
      existing = undefined;
    } else if (!stale && !failed && dialogueRunUsable(existing.status, lastWakeAt, now)) {
      const wake: DialogueWakeEvent = {
        type: "dialogue_wake", runId: existing.runId, parentRunId: request.parentRunId,
        sourceInputId: request.sourceInputId, workId: request.workId, sessionId: existing.sessionId,
        triggerKey: request.triggerKey, candidateKeys: request.candidateKeys,
        wakeAt: new Date(now).toISOString(), reused: true,
      };
      const resumed = await resumeExistingActor(request.scope, wake);
      if (resumed) {
        // The hook can change owners after discovery. Persist the session of
        // the Actor which accepted the wake, including a just-started holder.
        const sessionId = runs.get(resumed.runId)?.sessionId ??
          (await (await getWorld()).runs.get(resumed.runId, { resolveData: "none" })).attributes.session ?? resumed.runId;
        await recordDialogueWakeStep({ ...wake, runId: resumed.runId, sessionId });
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
  await recordDialogueWakeStep(wake);
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

export async function cancelDialogueRunStep(runId: string): Promise<void> {
  "use step";
  await getRun(runId).cancel().catch(() => undefined);
  const status = await waitForDialogueRunTerminalStep(runId);
  if (status === "pending" || status === "running") throw new Error("Dialogue predecessor did not reach a terminal state");
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

/** The thought-side delivery witness follows responsibility, never the client. */
export async function witnessDialogueDeliveryStep(
  request: DialogueEnsureRequest,
  initialRunId: string,
  candidateId: string,
): Promise<"delivered" | "failed"> {
  "use step";
  let awaitingDeliverySince = Date.now();
  let runId = initialRunId;
  let replacements = 0;
  while (true) {
    const world = await readDialogueWorldStep(request.scope);
    const delivered = world.publications.some(publication =>
      publication.sourceResults.some(result => result.resultId === candidateId));
    if (delivered) break;
    if (world.dialogueRuns.some(run => dialogueCandidateFailed(run, candidateId) ||
      run.events.some(event => event.type === "world_degraded"))) {
      await publishThoughtDeliveryStep({
        type: "thought_delivery_finished", runId: request.parentRunId, sourceInputId: request.sourceInputId,
        candidateId, status: "failed", finishedAt: new Date().toISOString(),
      });
      return "failed";
    }
    const runs = new Map(world.dialogueRuns.map(run => [run.runId, run]));
    let current = runId ? runs.get(runId) : undefined;
    try {
      if (current) current = responsibleDialogueRun(current, runs);
    } catch {
      await publishThoughtDeliveryStep({
        type: "thought_delivery_finished", runId: request.parentRunId, sourceInputId: request.sourceInputId,
        candidateId, status: "failed", finishedAt: new Date().toISOString(),
      });
      return "failed";
    }
    if (current && (current.status === "pending" || current.status === "running")) {
      if (!dialogueRunStale(current, world.wakes, Date.now(), awaitingDeliverySince)) {
        if (await waitForPublication(current, candidateId)) break;
        continue;
      }
    }
    if (replacements >= MAX_DELIVERY_REPLACEMENTS) {
      await publishThoughtDeliveryStep({
        type: "thought_delivery_finished", runId: request.parentRunId, sourceInputId: request.sourceInputId,
        candidateId, status: "failed", finishedAt: new Date().toISOString(),
      });
      return "failed";
    }
    replacements++;
    runId = (await ensureDialogueOrchestratorStep(request)).runId;
    awaitingDeliverySince = Date.now();
  }
  await publishThoughtDeliveryStep({
    type: "thought_delivery_finished", runId: request.parentRunId, sourceInputId: request.sourceInputId,
    candidateId, status: "delivered", finishedAt: new Date().toISOString(),
  });
  return "delivered";
}

/** Only the complete public utterance is projected into the memory filesystem. */
export async function recordDialogueUtteranceStep(args: {
  input: DialogueRunInput;
  utterance: PublicUtterance;
  artifacts: DialogueTypedArtifact[];
  inputs: DialogueInput[];
}): Promise<void> {
  "use step";
  const { input, utterance, artifacts, inputs } = args;
  const selected = inputs.filter(candidate => utterance.inputIds.includes(candidate.inputId));
  if (!selected.length) return;
  const environment = input.context.record;
  const receipt = await projectDialogueRecords({
    inputs: selected.map(candidate => ({
      input: candidate,
      turnId: candidate.inputId,
      ...(environment.sliceId ? { sliceId: environment.sliceId } : {}),
      ...(environment.images?.length ? { images: environment.images } : {}),
    })),
    utterance,
    typedArtifacts: artifacts,
    useGithub: environment.useGithub,
    useDemo: environment.useDemo,
    owner: environment.owner,
    repo: environment.repo,
    timezone: environment.timezone,
    slicing: environment.slicing,
  });
  if (receipt) for (const range of receipt.reflection) await ringReflection(range.sliceId, range);
}
