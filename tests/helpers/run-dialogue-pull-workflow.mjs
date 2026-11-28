import { cp, mkdir, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const workflowRequire = createRequire(require.resolve("workflow"));
const nextRequire = createRequire(workflowRequire.resolve("@workflow/next"));
const corePath = workflowRequire.resolve("@workflow/core/runtime");
const coreRequire = createRequire(corePath);
const { BaseBuilder } = await import(pathToFileURL(nextRequire.resolve("@workflow/builders")).href);
const { createWorld } = await import(pathToFileURL(coreRequire.resolve("@workflow/world-local")).href);
const runtime = await import(pathToFileURL(corePath).href);
const directory = join(projectRoot, "test-results", `dialogue-pull-${Date.now()}`);
const modulesLink = join(directory, "node_modules");
let world;
let timeout;
globalThis.fetch = async () => { throw new Error("Network is disabled in the dialogue pull fixture"); };

const input = id => ({
  inputId: `input-${id}`, clientMessageId: `message-${id}`, userSeq: id === "A" ? 1 : 2, eventSeq: id === "A" ? 1 : 2,
  acceptedAt: `2026-11-15T00:00:0${id === "A" ? 0 : 1}.000Z`, text: `Question ${id}`,
});
const offer = id => ({
  type: "offer", offerId: `${id}-final`, runId: `thought-${id}`, parentRunId: `thought-${id}`,
  sourceInputId: `input-${id}`, workId: `work-${id}`, stage: "final", publicSeq: 1, text: `${id} result`, locale: "zh",
  record: { useGithub: false, useDemo: false, owner: "local", repo: "local", timezone: "UTC",
    slicing: { idleGapMinutes: 30, maxSliceMinutes: 30, maxTurnsPerSlice: 50 } },
});
const initialState = {
  scope: "scope", inputs: [input("A")], starts: [], wakes: [], offers: [offer("A")], publications: [], dialogueRuns: [],
  works: [{ runId: "thought-A", workId: "work-A", inputId: "input-A", status: "running" }],
};

try {
  await mkdir(directory, { recursive: true });
  await symlink(join(projectRoot, "node_modules"), modulesLink, "junction");
  await writeFile(join(directory, "state.json"), JSON.stringify(initialState));
  await writeFile(join(directory, "published.jsonl"), "");

  // Compile the real production loop. Only its model and state dependencies are
  // replaced by deterministic local steps; no provider request is possible.
  const source = await readFile(join(projectRoot, "src/app/api/chat/dialogue-orchestrator-workflow.ts"), "utf8");
  const replaced = source
    .replace('@/lib/dialogue/orchestrator', './orchestrator')
    .replace('@/lib/dialogue/coordination', './coordination')
    .replace('@/app/api/agent/agent', './agent')
    .replace('@/lib/dialogue/wording-stream', './wording')
    .replace('@/lib/dialogue/dialogue-prompt', './prompt')
    .replace('@/lib/dialogue/transport', './transport')
    .replace('@/lib/chat/dialogue-contract', './transport')
    .replace('@/lib/deepseek/types', './transport')
    .replace('./dialogue-transport-steps', './transport-steps')
    .replace('./dialogue-orchestrator-steps', './world-steps');
  await writeFile(join(directory, "dialogue.ts"), replaced);
  await cp(join(projectRoot, "src/lib/dialogue/orchestrator.ts"), join(directory, "orchestrator.ts"));
  await cp(join(projectRoot, "src/lib/dialogue/coordination.ts"), join(directory, "coordination.ts"));
  await writeFile(join(directory, "transport.ts"), 'export const DIALOGUE_CHECKPOINT_NAMESPACE = "checkpoint";\n');
  await writeFile(join(directory, "prompt.ts"), 'export function dialoguePriorContext() { return []; }\n');
  await writeFile(join(directory, "agent.ts"), 'export function createDialogueAgent() { return {}; }\n');
  await writeFile(join(directory, "wording.ts"), `
export async function fixtureWordingStep(prompt) {
  "use step";
  return "public:" + prompt;
}
export async function streamDialogueWording(_agent, options) {
  return await fixtureWordingStep(options.prompt);
}
`);
  await writeFile(join(directory, "world-steps.ts"), `
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
const file = () => join(process.env.FIXTURE_DIR, "state.json");
export async function readDialogueWorldStep() {
  "use step";
  return JSON.parse(await readFile(file(), "utf8"));
}
export async function recordDialogueUtteranceStep() { "use step"; }
export async function stampDialogueTriggerStep() { "use step"; }
export async function stoppedDialogueParentsStep() { "use step"; return []; }
export async function waitForDialogueRunTerminalStep() { "use step"; return "completed"; }
`);
  await writeFile(join(directory, "transport-steps.ts"), `
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getWorkflowMetadata } from "workflow";
const file = () => join(process.env.FIXTURE_DIR, "state.json");
export async function dialogueOwnRunIdStep() { "use step"; return getWorkflowMetadata().workflowRunId; }
export async function openDialogueStreamStep() { "use step"; }
export async function closeDialogueRunStreamStep() { "use step"; }
export async function completeDialogueLapStep() { "use step"; }
export async function writeDialogueRuntimeEventStep() { "use step"; }
export async function prepareDialogueOfferStep(input) { "use step"; return { artifacts: [], prompt: input.text, superseded: false }; }
export async function publishDialogueResultStep({ input: candidate, text }) {
  "use step";
  const state = JSON.parse(await readFile(file(), "utf8"));
  // B completes while A is being published. There is no wake or notification;
  // the production loop must discover B on its next pull.
  if (candidate.offerId === "A-final" && !state.offers.some(item => item.offerId === "B-final")) {
    state.inputs.push(${JSON.stringify(input("B"))});
    state.works.push({ runId: "thought-B", workId: "work-B", inputId: "input-B", status: "completed" });
    state.offers.push(${JSON.stringify(offer("B"))});
  }
  const utterance = {
    utteranceId: candidate.offerId, publicSeq: candidate.publicSeq ?? 1, committedAt: new Date().toISOString(),
    inputIds: [candidate.context.sourceInputId],
    sourceResults: [{ resultId: candidate.offerId, productRevision: 1, claimIds: [] }],
    phase: "final_answer", blocks: [{ kind: "markdown", blockId: "text", text }],
  };
  state.publications.push(utterance);
  await writeFile(file(), JSON.stringify(state));
  await appendFile(join(process.env.FIXTURE_DIR, "published.jsonl"), JSON.stringify({ offerId: candidate.offerId, text }) + "\\n");
  return utterance;
}
`);

  process.env.FIXTURE_DIR = directory;
  process.env.WORKFLOW_TARGET_WORLD = "local";
  class FixtureBuilder extends BaseBuilder {
    async build() {
      return this.createCombinedBundle({
        inputFiles: ["dialogue.ts", "wording.ts", "world-steps.ts", "transport-steps.ts"].map(name => join(directory, name)),
        stepsOutfile: join(directory, "steps.mjs"), flowOutfile: join(directory, "flow.mjs"),
        format: "esm", bundleFinalOutput: false,
      });
    }
  }
  const builder = new FixtureBuilder({
    buildTarget: "standalone", workingDir: directory, dirs: ["."],
    stepsBundlePath: "steps.mjs", workflowsBundlePath: "flow.mjs", webhookBundlePath: "webhook.mjs",
    externalPackages: ["workflow", "workflow/api", "workflow/runtime"],
    discoverWorkflowsInNodeModules: false, sourcemap: false, suppressCreateWorkflowsBundleLogs: true,
  });
  const built = await builder.build();
  world = createWorld({ dataDir: join(directory, "world"), recoverActiveRuns: false });
  runtime.setWorld(world);
  await world.start();
  const handler = await import(pathToFileURL(join(directory, "flow.mjs")).href);
  world.registerHandler("__wkf_workflow_", handler.POST);
  const workflow = Object.values(built.manifest.workflows).flatMap(functions => Object.entries(functions))
    .find(([name]) => name === "dialogueOrchestratorWorkflow")?.[1];
  if (!workflow) throw new Error("Compiled production dialogue workflow was not registered");
  const run = await runtime.start(workflow, [{ scope: "scope" }], { world });
  const deadline = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error("dialogue pull fixture timed out")), 30_000);
  });
  const result = await Promise.race([run.returnValue, deadline]);
  clearTimeout(timeout);
  const published = (await readFile(join(directory, "published.jsonl"), "utf8")).trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
  if (result.status !== "idle" || result.laps !== 2 || published.map(item => item.offerId).join(",") !== "A-final,B-final") {
    throw new Error("Unexpected pull result: " + JSON.stringify({ result, published }));
  }
  const steps = await world.steps.list({ runId: run.runId, pagination: { limit: 100 } });
  console.log("DIALOGUE_PULL_WORKFLOW_RESULT=" + JSON.stringify({
    runId: run.runId, result, published, steps: steps.data.map(step => step.stepName), networkAttempts: 0,
  }));
} finally {
  clearTimeout(timeout);
  await world?.close();
  runtime.setWorld(undefined);
  await unlink(modulesLink).catch(error => { if (error.code !== "ENOENT") throw error; });
  await rm(directory, { recursive: true, force: true });
}
