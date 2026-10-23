import { mkdtemp, mkdir, copyFile, cp, symlink, unlink, rm, appendFile, readFile, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const workflowRequire = createRequire(require.resolve("workflow"));
const nextRequire = createRequire(workflowRequire.resolve("@workflow/next"));
const corePath = workflowRequire.resolve("@workflow/core/runtime");
const coreRequire = createRequire(corePath);
const { BaseBuilder } = await import(pathToFileURL(nextRequire.resolve("@workflow/builders")).href);
const { createWorld } = await import(pathToFileURL(coreRequire.resolve("@workflow/world-local")).href);
const runtime = await import(pathToFileURL(corePath).href);
const directory = await mkdtemp(join(tmpdir(), "aftrbrez-compiled-workflow-"));
const modulesLink = join(directory, "node_modules");
let world;
let timeout;
let networkAttempts = 0;
globalThis.fetch = async (url) => {
  if (String(url) !== "https://api.deepseek.com/chat/completions") {
    networkAttempts += 1;
    throw new Error("Network is disabled in the compiled Workflow fixture");
  }
  await appendFile(join(directory, "ledger/model-calls"), "called\n");
  const events = [
    { choices: [{ delta: { reasoning_content: "fixture thinking", content: "fixture answer" }, finish_reason: null }] },
    { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
  ];
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n", {
    headers: { "Content-Type": "text/event-stream" },
  });
};
try {
  await symlink(join(projectRoot, "node_modules"), modulesLink, "junction");
  await copyFile(join(projectRoot, "tests/fixtures/compiled-handoff.fixture"), join(directory, "fixture.ts"));
  // Compile production orchestration and HTTP/SSE code. Only credential lookup
  // is replaced; the fetch above never dispatches a real network request.
  await cp(join(projectRoot, "src/lib/deepseek"), join(directory, "deepseek"), { recursive: true });
  await writeFile(join(directory, "deepseek/credentials.ts"), 'export function deepseekApiKey() { return "non-billable-fixture"; }\n');
  await mkdir(join(directory, "ledger"));
  process.env.FIXTURE_DIR = join(directory, "ledger");
  process.env.WORKFLOW_TARGET_WORLD = "local";
  class FixtureBuilder extends BaseBuilder {
    async build() {
      return this.createCombinedBundle({
        inputFiles: [join(directory, "fixture.ts"), join(directory, "deepseek/steps.ts")],
        stepsOutfile: join(directory, "steps.mjs"),
        flowOutfile: join(directory, "flow.mjs"),
        format: "esm", bundleFinalOutput: false,
      });
    }
  }
  const builder = new FixtureBuilder({
    buildTarget: "standalone", workingDir: directory, dirs: ["."],
    stepsBundlePath: "steps.mjs", workflowsBundlePath: "flow.mjs", webhookBundlePath: "webhook.mjs",
    externalPackages: ["workflow", "workflow/api", "workflow/runtime"],
    discoverWorkflowsInNodeModules: false, sourcemap: false,
    suppressCreateWorkflowsBundleLogs: true,
  });
  const built = await builder.build();
  world = createWorld({ dataDir: join(directory, "world"), recoverActiveRuns: false });
  runtime.setWorld(world);
  await world.start();
  const handler = await import(pathToFileURL(join(directory, "flow.mjs")).href);
  world.registerHandler("__wkf_workflow_", handler.POST);
  const workflow = Object.values(built.manifest.workflows).flatMap(functions => Object.entries(functions)).find(([name]) => name === "parent")[1];
  const run = await runtime.start(workflow, ["one-record"], { world });
  const deadline = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error("compiled workflow fixture timed out")), 30_000);
  });
  const result = await Promise.race([run.returnValue, deadline]);
  const starts = (await readFile(join(directory, "ledger/child-starts"), "utf8")).trim().split("\n");
  for (const id of starts) await Promise.race([runtime.getRun(id).returnValue, deadline]);
  clearTimeout(timeout);
  const modelCalls = (await readFile(join(directory, "ledger/model-calls"), "utf8")).trim().split("\n").length;
  const summaryAttempts = (await readFile(join(directory, "ledger/summary-attempts"), "utf8")).trim().split("\n").length;
  const records = (await readdir(join(directory, "ledger"))).filter(name => name.startsWith("record-"));
  const recordText = await readFile(join(directory, "ledger/record-one-record"), "utf8");
  const events = await world.events.list({ runId: run.runId, pagination: { limit: 100 } });
  const steps = await world.steps.list({ runId: run.runId, pagination: { limit: 100 } });
  const childSteps = await Promise.all(starts.map(async runId => {
    const child = await world.steps.list({ runId, pagination: { limit: 100 } });
    return child.data.map(step => ({ name: step.stepName, attempt: step.attempt, status: step.status }));
  }));
  console.log("COMPILED_WORKFLOW_RESULT=" + JSON.stringify({
    modelCalls, summaryAttempts, childStarts: starts.length, records: records.length, recordText,
    returnedChild: result, parentRunId: run.runId,
    eventTypes: events.data.map(event => event.eventType),
    steps: steps.data.map(step => ({ name: step.stepName, attempt: step.attempt, status: step.status })),
    childSteps,
    uniqueChildren: new Set(starts).size,
    networkAttempts,
  }));
} finally {
  clearTimeout(timeout);
  await world?.close();
  runtime.setWorld(undefined);
  // Remove the dependency junction itself before deleting this owned temp dir.
  await unlink(modulesLink).catch(error => { if (error.code !== "ENOENT") throw error; });
  if (!directory.startsWith(join(tmpdir(), "aftrbrez-compiled-workflow-"))) throw new Error("Refusing to remove an unexpected fixture path");
  await rm(directory, { recursive: true, force: true });
}
