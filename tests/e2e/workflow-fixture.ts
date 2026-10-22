import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { E2E_WORKFLOW_ROOT } from "./env";

// Use the installed SDK's storage and serializer, without starting a workflow
// or queue delivery. The server's real actions read exactly these run entities.
const fixtureRequire = createRequire(join(process.cwd(), "package.json"));
const sdkRequire = createRequire(fixtureRequire.resolve("workflow"));
async function fixtureWorld() {
  const local = await import(pathToFileURL(sdkRequire.resolve("@workflow/world-local")).href);
  const serialization = await import(pathToFileURL(join(dirname(sdkRequire.resolve("@workflow/core")), "serialization.js")).href);
  const world = local.createWorld({ dataDir: E2E_WORKFLOW_ROOT, recoverActiveRuns: false });
  await world.start();
  return { world, serialize: serialization.dehydrateWorkflowReturnValue as (value: unknown, runId: string, key: undefined) => Promise<Uint8Array> };
}

export async function seedWorkflowRun(output?: unknown) {
  const { world, serialize } = await fixtureWorld();
  const created = await world.events.create(null, {
    eventType: "run_created",
    specVersion: world.specVersion,
    eventData: { deploymentId: "fixture", workflowName: "workflow//fixture", input: await serialize([], "fixture", undefined) },
  });
  const runId = created.run.runId as string;
  await world.events.create(runId, { eventType: "run_started", specVersion: world.specVersion });
  const complete = async (value: unknown) => {
    await world.events.create(runId, {
      eventType: "run_completed", specVersion: world.specVersion,
      eventData: { output: await serialize(value, runId, undefined) },
    });
  };
  if (output !== undefined) await complete(output);
  return { runId, complete };
}
