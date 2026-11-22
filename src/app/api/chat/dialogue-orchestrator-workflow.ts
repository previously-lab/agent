import { createHook, getWritable, sleep } from "workflow";
import { isStepCount } from "@/lib/deepseek/tools";
import type { ModelCallStreamPart } from "@/lib/deepseek/types";
import { createDialogueAgent } from "@/app/api/agent/agent";
import { dialoguePriorContext } from "@/lib/dialogue/dialogue-prompt";
import { DIALOGUE_SESSION_MS, dialogueRunStale, dialogueRunUsable, publicationOfferIds, selectDialogueOffer } from "@/lib/dialogue/orchestrator";
import { sessionLastWakeAt } from "@/lib/dialogue/coordination";
import {
  DIALOGUE_CHECKPOINT_NAMESPACE,
  type DialogueOfferEvent,
  type DialogueRunInput,
} from "@/lib/dialogue/transport";
import type { ModelMessage } from "@/lib/deepseek/types";
import type { PublicUtterance } from "@/lib/chat/dialogue-contract";
import {
  closeDialogueRunStreamStep,
  completeDialogueLapStep,
  dialogueOwnRunIdStep,
  openDialogueStreamStep,
  prepareDialogueOfferStep,
  publishDialogueResultStep,
  writeDialogueRuntimeEventStep,
} from "./dialogue-transport-steps";
import {
  cancelDialogueRunStep,
  continueDialogueOrchestratorStep,
  forwardDialogueWakeStep,
  readDialogueWorldStep,
  recordDialogueUtteranceStep,
  stampDialogueTriggerStep,
  waitForDialogueRunTerminalStep,
  type DialogueOrchestratorArgs,
} from "./dialogue-orchestrator-steps";

const MAX_LAPS = 4;
const MAX_MODEL_ATTEMPTS = 2;

function priorMessages(input: {
  inputs: Array<{ inputId: string; acceptedAt: string; text: string }>;
  publications: PublicUtterance[];
}): ModelMessage[] {
  const users = input.inputs.map(input => ({
    role: "user" as const,
    content: input.text,
    at: input.acceptedAt,
  }));
  const assistants = input.publications.map(publication => ({
    role: "assistant" as const,
    content: publication.blocks.flatMap(block => block.kind === "markdown" ? [block.text] : []).join("\n\n"),
    at: publication.committedAt,
  }));
  return [...users, ...assistants]
    .sort((a, b) => a.at.localeCompare(b.at))
    .map(({ role, content }) => ({ role, content }));
}

function relatedFinalOffers(
  primary: DialogueOfferEvent,
  offers: DialogueOfferEvent[],
  publications: PublicUtterance[],
  handled: ReadonlySet<string>,
): DialogueOfferEvent[] {
  if (primary.stage === "checkpoint") return [primary];
  const published = publicationOfferIds(publications);
  const inputIds = new Set(primary.aggregateInputIds ?? [primary.sourceInputId]);
  return offers.filter(offer => inputIds.has(offer.sourceInputId) && offer.stage !== "checkpoint" &&
    !handled.has(offer.offerId) && !published.has(offer.offerId));
}

/** One scoped public Actor. Its private working state never enters memory files. */
export async function dialogueOrchestratorWorkflow(args: DialogueOrchestratorArgs): Promise<{
  status: "idle" | "delegated" | "continued" | "failed";
  laps: number;
}> {
  "use workflow";
  const ownRunId = await dialogueOwnRunIdStep();
  const sessionId = args.sessionId ?? ownRunId;
  await stampDialogueTriggerStep(sessionId);
  let lease = createHook({ token: `dialogue-execution:${args.scope}` });
  let laps = 0;
  try {
    let conflict = await lease.getConflict();
    let unsuccessfulClaims = 0;
    while (conflict) {
      const holderId = conflict.runId;
      let waitedForPredecessor = false;
      const snapshot = await readDialogueWorldStep(args.scope);
      const holder = snapshot.dialogueRuns.find(run => run.runId === holderId);
      const now = Date.now();
      if (holder && (holder.status === "pending" || holder.status === "running")) {
        if (dialogueRunStale(holder, snapshot.wakes, now)) {
          await cancelDialogueRunStep(holderId);
        } else {
          // Two first wakes can create independent run/session IDs before either
          // hook is visible. Only an actual handoff needs to outlive the holder.
          const newSession = sessionId !== holder.sessionId && (args.handoffReason === "session_expiry" ||
            !dialogueRunUsable(holder.status, sessionLastWakeAt(holder, snapshot.wakes), now));
          const leaving = holder.events.some(event => event.type === "exit_commit" || event.type === "continued" || event.type === "delegated");
          if (args.handoffFrom === holderId || newSession || leaving) {
            await writeDialogueRuntimeEventStep({ type: "handoff_wait", waitingForRunId: holderId, at: new Date(now).toISOString() });
            await waitForDialogueRunTerminalStep(holderId);
            // The SDK may return while a healthy predecessor is still running.
            // A liveness poll is not a failed acquisition of a released lease.
            waitedForPredecessor = true;
          } else {
            const wake = args.initialWake && {
              ...args.initialWake, runId: holderId, sessionId: holder.sessionId, wakeAt: new Date(now).toISOString(), reused: true,
            };
            if (!wake || await forwardDialogueWakeStep(args.scope, wake)) {
              await writeDialogueRuntimeEventStep({ type: "delegated", holderRunId: holderId, ...(wake ? { wake } : {}) });
              return { status: "delegated", laps };
            }
          }
        }
      }
      // A conflicted hook was never registered and caches that conflict forever.
      // Only a fresh hook can atomically retry the now-released token.
      lease.dispose();
      lease = createHook({ token: `dialogue-execution:${args.scope}` });
      conflict = await lease.getConflict();
      unsuccessfulClaims = !waitedForPredecessor && conflict?.runId === holderId ? unsuccessfulClaims + 1 : 0;
      if (unsuccessfulClaims >= 3) throw new Error("Dialogue execution lease still belongs to an unreachable holder");
    }
    await writeDialogueRuntimeEventStep({ type: "lease_acquired", at: new Date().toISOString() });

    // Hook events are only wake hints. Workflow facts remain authoritative.
    const wakes = lease[Symbol.asyncIterator]();
    let nextWake = wakes.next();
    let messages: ModelMessage[] = [];
    const knownInputs = new Set<string>();
    let primed = false;
    const handled = new Set<string>();
    let modelAttempts = 0;
    while (laps < MAX_LAPS && modelAttempts < MAX_MODEL_ATTEMPTS) {
      await writeDialogueRuntimeEventStep({ type: "heartbeat", at: new Date().toISOString() });
      const world = await readDialogueWorldStep(args.scope);
      if (!primed) {
        messages = priorMessages(world).slice(-16);
        for (const input of world.inputs) knownInputs.add(input.inputId);
        primed = true;
      }
      // A newer run does not by itself retire this Actor. Its hook owns the
      // writer lease; startup races and successors resolve at that boundary.
      const primary = selectDialogueOffer(world, handled);
      if (!primary) {
        const keys = [...new Set([
          ...world.offers.map(offer => offer.offerId),
          ...world.inputs.map(input => `${input.inputId}:start`),
        ])];
        await writeDialogueRuntimeEventStep({ type: "exit_intent", keys, at: new Date().toISOString() });
        const outcome = await Promise.race([
          nextWake.then(result => ({ kind: "wake" as const, result })),
          sleep(args.idleMs ?? DIALOGUE_SESSION_MS).then(() => ({ kind: "idle" as const })),
        ]);
        if (outcome.kind === "idle") {
          const verification = await readDialogueWorldStep(args.scope);
          if (selectDialogueOffer(verification, handled)) continue;
          await writeDialogueRuntimeEventStep({ type: "exit_commit", at: new Date().toISOString() });
          return { status: "idle", laps };
        }
        if (outcome.result.done) return { status: "idle", laps };
        nextWake = wakes.next();
        continue;
      }
      const related = relatedFinalOffers(primary, world.offers, world.publications, handled);
      for (const offer of related) handled.add(offer.offerId);
      const source = world.inputs.find(input => input.inputId === primary.sourceInputId);
      if (!source) continue;
      const input: DialogueRunInput = {
        offerId: primary.offerId,
        publicSeq: primary.publicSeq ?? 1,
        text: primary.text ?? "",
        ...(primary.responseMode ? { responseMode: primary.responseMode } : {}),
        ...(primary.event ? { event: primary.event } : {}),
        publicationId: related.map(offer => offer.offerId).sort().join("+"),
        context: {
          scopeKey: args.scope,
          parentRunId: primary.parentRunId ?? primary.runId,
          workId: primary.workId ?? primary.sourceInputId,
          sourceInputId: primary.sourceInputId,
          sourceTurnId: primary.sourceInputId,
          source,
          // The Actor retains its own public conversation instead of rebuilding
          // the whole Workflow input registry as a fresh current task.
          priorContext: dialoguePriorContext(messages, source.text),
          locale: primary.locale ?? "zh",
          record: primary.record ?? {
            useGithub: false,
            useDemo: false,
            owner: "local",
            repo: "local",
            timezone: "UTC",
            slicing: { idleGapMinutes: 30, maxSliceMinutes: 30, maxTurnsPerSlice: 50 },
          },
        },
        stage: primary.stage,
        publicationInputIds: [...new Set(related.map(offer => offer.sourceInputId))],
        publicationSourceResults: related.map(offer => ({ resultId: offer.offerId, productRevision: 1, claimIds: [] })),
        orchestration: {
          works: world.works,
          offers: world.offers,
          publications: world.publications.slice(-8),
        },
      };
      if (primary.offerId.endsWith(":opening") && !primary.text?.trim()) {
        await writeDialogueRuntimeEventStep({
          type: "expression_outcome", status: "intentionally_silent", planId: primary.offerId,
          candidateIds: [], inputIds: [primary.sourceInputId],
        });
        await completeDialogueLapStep(primary.offerId);
        laps++;
        continue;
      }
      const checkpoint = input.stage === "checkpoint";
      const prepared = await prepareDialogueOfferStep(input, ownRunId);
      if (prepared.superseded) continue;
      await openDialogueStreamStep(input);
      let text = "";
      let error: unknown;
      while (modelAttempts < MAX_MODEL_ATTEMPTS && !text.trim()) {
        modelAttempts++;
        try {
          const agent = createDialogueAgent(checkpoint, true, primary.record?.sliceId ?? primary.workId);
          const result = await agent.stream({
            messages,
            prompt: prepared.prompt,
            writable: getWritable<ModelCallStreamPart>(checkpoint ? { namespace: DIALOGUE_CHECKPOINT_NAMESPACE } : undefined),
            stopWhen: isStepCount(1),
            sendFinish: false,
            preventClose: true,
            onStepEnd: step => { if (step.text) text = step.text; },
          });
          text = result.text || text;
          error = undefined;
        } catch (cause) {
          error = cause;
        }
      }
      if (text.trim()) {
        try {
          const utterance = await publishDialogueResultStep({ input, artifacts: prepared.artifacts, text });
          if (utterance) {
            if (!knownInputs.has(source.inputId) && source.text.trim()) {
              messages.push({ role: "user", content: source.text });
              knownInputs.add(source.inputId);
            }
            messages.push({ role: "assistant", content: text });
            await writeDialogueRuntimeEventStep({
              type: "expression_outcome", status: "answered", planId: input.publicationId ?? input.offerId,
              candidateIds: related.map(offer => offer.offerId), inputIds: input.publicationInputIds ?? [input.context.sourceInputId],
            });
            await recordDialogueUtteranceStep({ input, utterance, artifacts: prepared.artifacts, inputs: world.inputs });
          }
        } catch (cause) {
          error ??= cause;
        }
      } else if (primary.offerId.endsWith(":opening") && !error) {
        await writeDialogueRuntimeEventStep({
          type: "expression_outcome", status: "intentionally_silent", planId: input.publicationId ?? input.offerId,
          candidateIds: [], inputIds: [input.context.sourceInputId],
        });
      } else {
        error ??= "The dialogue model produced no public response";
      }
      if (error) {
        await writeDialogueRuntimeEventStep({
          type: "expression_outcome", status: "failed", planId: input.publicationId ?? input.offerId,
          candidateIds: related.map(offer => offer.offerId), inputIds: input.publicationInputIds ?? [input.context.sourceInputId],
        });
        await completeDialogueLapStep(input.offerId, error instanceof Error ? error.message : String(error));
        return { status: "failed", laps };
      }
      await completeDialogueLapStep(input.offerId);
      laps++;
    }
    const remaining = await readDialogueWorldStep(args.scope);
    if (selectDialogueOffer(remaining, handled)) {
      const nextRunId = await continueDialogueOrchestratorStep({
        scope: args.scope, sessionId, handoffFrom: ownRunId, handoffReason: "budget",
      });
      await writeDialogueRuntimeEventStep({ type: "continued", nextRunId });
      return { status: "continued", laps };
    }
    await writeDialogueRuntimeEventStep({ type: "exit_commit", at: new Date().toISOString() });
    return { status: "idle", laps };
  } finally {
    lease.dispose();
    await closeDialogueRunStreamStep();
  }
}
