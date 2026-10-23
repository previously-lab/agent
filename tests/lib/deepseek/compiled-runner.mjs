import { mkdtemp, mkdir, cp, symlink, unlink, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const partialMode = process.argv[2] === "partial";
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const workflowRequire = createRequire(require.resolve("workflow"));
const nextRequire = createRequire(workflowRequire.resolve("@workflow/next"));
const corePath = workflowRequire.resolve("@workflow/core/runtime");
const coreRequire = createRequire(corePath);
const { BaseBuilder } = await import(pathToFileURL(nextRequire.resolve("@workflow/builders")).href);
const { createWorld } = await import(pathToFileURL(coreRequire.resolve("@workflow/world-local")).href);
const runtime = await import(pathToFileURL(corePath).href);
const directory = await mkdtemp(join(tmpdir(), "aftrbrez-deepseek-workflow-"));
const modulesLink = join(directory, "node_modules");
let world;
let timeout;
let modelCalls = 0;
let unexpectedNetwork = 0;
const requests = [];
globalThis.fetch = async (url, init) => {
  if (String(url) !== "https://api.deepseek.com/chat/completions") {
    unexpectedNetwork++;
    throw new Error("All network access is disabled in the compiled fixture");
  }
  const body = JSON.parse(init.body);
  requests.push(body);
  modelCalls++;
  const events = partialMode ? [
    { choices: [{ delta: { reasoning_content: "partial durable thought", content: "partial durable answer", tool_calls: [{ index: 0, id: "never-write", function: { name: "save", arguments: '{"text":' } }] }, finish_reason: null }], usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 } },
  ] : modelCalls === 1 ? [
    { choices: [{ delta: { reasoning_content: "fixture thought", tool_calls: [
      { index: 0, id: "stable-write", function: { name: "save", arguments: '{"text":"saved"}' } },
      { index: 1, id: "independent-read", function: { name: "read", arguments: "{}" } },
    ] }, finish_reason: null }] },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
  ] : [
    { choices: [{ delta: { content: "completed" }, finish_reason: null }] },
    { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
  ];
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } });
};
try {
  await symlink(join(projectRoot, "node_modules"), modulesLink, "junction");
  // Compile the production runtime itself. Only credential lookup is replaced;
  // fake fetch above can never reach an actual model endpoint.
  await cp(join(projectRoot, "src/lib/deepseek"), join(directory, "deepseek"), { recursive: true });
  await writeFile(join(directory, "deepseek/credentials.ts"), 'export function deepseekApiKey() { return "non-billable-fixture"; }\n');
  await mkdir(join(directory, "ledger"));
  process.env.FIXTURE_DIR = join(directory, "ledger");
  process.env.WORKFLOW_TARGET_WORLD = "local";
  await writeFile(join(directory, "fixture.ts"), `
import { appendFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getWritable } from "workflow";
import { z } from "zod";
import { DeepSeekAgent } from "./deepseek/workflow-agent";
import { tool, isStepCount } from "./deepseek/tools";
export async function save(input: { text: string }, options: { context: { scope: string }; messages: Array<{ role: string; deepseek?: { reasoning_content?: string } }> }) {
  "use step";
  if (options.context.scope !== "fixture-scope" || options.messages.at(-1)?.deepseek?.reasoning_content !== "fixture thought") throw new Error("tool context did not survive serialization");
  await appendFile(join(process.env.FIXTURE_DIR!, "attempts"), "attempt\\n");
  await appendFile(join(process.env.FIXTURE_DIR!, "order"), "save\\n");
  try { await writeFile(join(process.env.FIXTURE_DIR!, "record"), input.text, { flag: "wx" }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return "already saved"; throw error; }
  throw new Error("fixture: write succeeded, acknowledgement lost");
}
export async function read() {
  "use step";
  await appendFile(join(process.env.FIXTURE_DIR!, "order"), "read\\n");
  return "independent read";
}
export async function parent() {
  "use workflow";
  const agent = new DeepSeekAgent({ tools: {
    save: tool({ inputSchema: z.object({ text: z.string() }), contextSchema: z.object({ scope: z.string() }), execute: save }),
    read: tool({ inputSchema: z.object({}), execute: read }),
  }, toolsContext: { save: { scope: "fixture-scope" } } });
  const result = await agent.stream({ prompt: "fixture", stopWhen: isStepCount(3), writable: getWritable() });
  return { text: result.text, steps: result.steps.length };
}
export async function partial() {
  "use workflow";
  const snapshots: unknown[] = [];
  const agent = new DeepSeekAgent({ tools: { save: tool({ inputSchema: z.object({ text: z.string() }), execute: save }) } });
  try {
    await agent.stream({ prompt: "partial fixture", stopWhen: isStepCount(3), onStepEnd: (step) => { snapshots.push(step); } });
    throw new Error("fixture expected an interrupted stream");
  } catch (error) {
    return { snapshots, errorName: error instanceof Error ? error.name : "unknown" };
  }
}
`);
  class FixtureBuilder extends BaseBuilder {
    async build() {
      return this.createCombinedBundle({ inputFiles: [join(directory, "fixture.ts"), join(directory, "deepseek/steps.ts")],
        stepsOutfile: join(directory, "steps.mjs"), flowOutfile: join(directory, "flow.mjs"), format: "esm", bundleFinalOutput: false });
    }
  }
  const builder = new FixtureBuilder({ buildTarget: "standalone", workingDir: directory, dirs: ["."],
    stepsBundlePath: "steps.mjs", workflowsBundlePath: "flow.mjs", webhookBundlePath: "webhook.mjs",
    externalPackages: ["workflow", "workflow/api", "workflow/runtime"], discoverWorkflowsInNodeModules: false,
    sourcemap: false, suppressCreateWorkflowsBundleLogs: true });
  const built = await builder.build();
  world = createWorld({ dataDir: join(directory, "world"), recoverActiveRuns: false });
  runtime.setWorld(world); await world.start();
  const handler = await import(pathToFileURL(join(directory, "flow.mjs")).href);
  world.registerHandler("__wkf_workflow_", handler.POST);
  const workflow = Object.values(built.manifest.workflows).flatMap((functions) => Object.entries(functions)).find(([name]) => name === (partialMode ? "partial" : "parent"))[1];
  const run = await runtime.start(workflow, [], { world });
  const deadline = new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("compiled native runtime timed out")), 30000); });
  const result = await Promise.race([run.returnValue, deadline]);
  clearTimeout(timeout);
  const steps = await world.steps.list({ runId: run.runId, pagination: { limit: 100 } });
  const attempts = partialMode ? 0 : (await readFile(join(directory, "ledger/attempts"), "utf8")).trim().split("\n").length;
  const record = partialMode ? null : await readFile(join(directory, "ledger/record"), "utf8");
  const order = partialMode ? [] : (await readFile(join(directory, "ledger/order"), "utf8")).trim().split("\n");
  console.log("NATIVE_WORKFLOW_RESULT=" + JSON.stringify({ result, modelCalls, unexpectedNetwork, attempts, record, order,
    secondMessages: requests[1]?.messages,
    steps: steps.data.map((step) => ({ name: step.stepName, attempt: step.attempt, status: step.status })) }));
} finally {
  clearTimeout(timeout); await world?.close(); runtime.setWorld(undefined);
  await unlink(modulesLink).catch((error) => { if (error.code !== "ENOENT") throw error; });
  if (!directory.startsWith(join(tmpdir(), "aftrbrez-deepseek-workflow-"))) throw new Error("Unexpected fixture cleanup target");
  await rm(directory, { recursive: true, force: true });
}
