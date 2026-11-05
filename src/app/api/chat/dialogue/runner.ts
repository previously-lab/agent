/**
 * The server DialogueRunner — the real side effects behind the outbox
 * dispatcher on a single-host (non-serverless) deployment: durable workflow
 * starts for works and the expression drain, run status/cancel against the
 * workflow registry, projection onto the record plane, and the reflection
 * bell. Serverless deployments need an external scheduler calling the same
 * engine — that is a documented deployment gate, not hidden here.
 */
import { getRun, start } from "workflow/api";
import type { TurnInput } from "@/lib/chat/turn-types";
import type { SliceLandingConfig } from "@/lib/chat/slice-landing";
import { projectDialogueRecords } from "@/lib/episodic/dialogue-records";
import { deliverReflectionWake } from "@/app/api/evolution/reflection-wake";
import type { DialogueRunner as IDialogueRunner, ProjectJobPayload, ProjectedReceipt } from "@/lib/dialogue/dispatch";
import type { DialogueInput } from "@/lib/chat/dialogue-contract";
import { getDialogueStore } from "@/lib/dialogue/runtime";
import { expressionWorkflow } from "../expression-workflow";
import { startPreparedTurn } from "../start-turn";

async function cancelRunQuietly(runId: string): Promise<void> {
  try {
    const run = getRun(runId);
    const status = await run.status;
    if (status === "pending" || status === "running") await run.cancel();
  } catch (error) {
    console.warn(
      `[Dialogue] cancel for ${runId} failed (ignored):`,
      error instanceof Error ? error.message : error,
    );
  }
}

interface ProjectionEnv {
  useGithub: boolean;
  useDemo: boolean;
  owner: string;
  repo: string;
  timezone: string;
  slicing?: SliceLandingConfig;
}

/** Every accepted input has its launching work; the launch carries the full
 *  serializable projection environment (backend flags, repo, slicing). */
async function projectionEnv(scope: string, inputIds: string[]): Promise<ProjectionEnv> {
  const store = await getDialogueStore();
  for (const inputId of inputIds) {
    const work = await store.work(scope, inputId);
    if (!work) continue;
    const launch = work.launch;
    return {
      useGithub: launch.useGithub,
      useDemo: launch.useDemo,
      owner: launch.owner,
      repo: launch.repo,
      timezone: launch.clientTimezone,
      slicing: launch.config?.slicing,
    };
  }
  throw new Error(`No launching work found for projection inputs in ${scope}`);
}

async function loadInputs(scope: string, inputIds: string[]): Promise<DialogueInput[]> {
  const store = await getDialogueStore();
  const inputs: DialogueInput[] = [];
  for (const inputId of inputIds) {
    const input = await store.input(scope, inputId);
    if (input) inputs.push(input);
  }
  return inputs;
}

export const serverDialogueRunner: IDialogueRunner = {
  async startWork(launch: TurnInput): Promise<{ runId: string }> {
    const run = await startPreparedTurn(launch);
    console.log(`[Dialogue] work ${launch.dialogue?.workId ?? "?"} started: ${run.runId}`);
    return { runId: run.runId };
  },

  async startExpression(scopeKey: string): Promise<"started" | "busy"> {
    // The store's lease CAS already decided "start"; a racing duplicate run
    // loses the fence inside the workflow and exits — harmless.
    const run = await start(expressionWorkflow, [scopeKey], {
      region: "hkg1",
      attributes: { role: "expression", scope: scopeKey },
    });
    console.log(`[Dialogue] expression drain started: ${run.runId}`);
    return "started";
  },

  cancelRun: cancelRunQuietly,

  async runStatus(runId) {
    try {
      const status = await getRun(runId).status;
      if (status === "pending" || status === "running") return "live";
      if (status === "completed") return "completed";
      if (status === "failed") return "failed";
      if (status === "cancelled") return "cancelled";
      return "gone";
    } catch {
      return "gone";
    }
  },

  async project(scope: string, payload: ProjectJobPayload): Promise<ProjectedReceipt | null> {
    const store = await getDialogueStore();
    if (payload.kind === "project") {
      const event = await store.event(scope, payload.eventSeq);
      if (!event) return null;
      if (event.type === "input.accepted") {
        const input = event.input;
        const work = await store.work(scope, input.inputId);
        const env = await projectionEnv(scope, [input.inputId]);
        const receipt = await projectDialogueRecords({
          inputs: [{ input, turnId: input.inputId, images: work?.launch.verifiedImages, reflectUserOnly: true }],
          ...env,
        });
        return receipt && { ...receipt };
      }
      if (event.type === "manuscript.append") {
        const utterance = event.utterance;
        const inputs = await loadInputs(scope, utterance.inputIds);
        if (!inputs.length) return null;
        const env = await projectionEnv(scope, utterance.inputIds);
        const receipt = await projectDialogueRecords({ inputs: inputs.map((input) => ({ input, turnId: input.inputId })), utterance, ...env });
        return receipt && { ...receipt };
      }
      // work.status / projection.receipt events carry no record-plane content.
      return null;
    }
    const result = await store.result(scope, payload.resultId);
    if (!result) return null;
    const inputs = await loadInputs(scope, result.inputIds);
    if (!inputs.length) return null;
    const env = await projectionEnv(scope, result.inputIds);
    const receipt = await projectDialogueRecords({ inputs: inputs.map((input) => ({ input, turnId: input.inputId })), result, ...env });
    return receipt && { ...receipt };
  },

  async ringReflection(ranges) {
    for (const range of ranges) {
      const delivered = await deliverReflectionWake(range);
      if (!delivered.ok) {
        console.warn(`[Dialogue] reflection wake not delivered for ${range.sliceId} (ignored): ${delivered.reason}`);
      }
    }
  },
};
