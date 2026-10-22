import { mkdtemp, mkdir, copyFile, symlink, unlink, rm, readFile, readdir } from "node:fs/promises";
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
globalThis.fetch = async () => {
  networkAttempts += 1;
  throw new Error("Network is disabled in the compiled Workflow fixture");
};
try {
  await symlink(join(projectRoot, "node_modules"), modulesLink, "junction");
  await copyFile(join(projectRoot, "tests/fixtures/compiled-handoff.fixture"), join(directory, "fixture.ts"));
  await mkdir(join(directory, "ledger"));
  process.env.FIXTURE_DIR = join(directory, "ledger");
  process.env.WORKFLOW_TARGET_WORLD = "local";
  class FixtureBuilder extends BaseBuilder {
    async build() {
      return this.createCombinedBundle({
        inputFiles: [join(directory, "fixture.ts")],
        stepsOutfile: join(directory, "steps.mjs"),
        flowOutfile: join(directory, "flow.mjs"),
        format: "esm", bundleFinalOutput: false,
      });
    }
  }
  const builder = new FixtureBuilder({
    buildTarget: "standalone", workingDir: directory, dirs: ["."],
    stepsBundlePath: "steps.mjs", workflowsBundlePath: "flow.mjs", webhookBundlePath: "webhook.mjs",
    externalPackages: ["workflow", "workflow/api", "workflow/runtime", "ai"],
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
  const events = await world.events.list({ runId: run.runId, pagination: { limit: 100 } });
  const steps = await world.steps.list({ runId: run.runId, pagination: { limit: 100 } });
  console.log("COMPILED_WORKFLOW_RESULT=" + JSON.stringify({
    modelCalls, summaryAttempts, childStarts: starts.length, records: records.length,
    returnedChild: result, parentRunId: run.runId,
    eventTypes: events.data.map(event => event.eventType),
    steps: steps.data.map(step => ({ name: step.stepName, attempt: step.attempt, status: step.status })),
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
