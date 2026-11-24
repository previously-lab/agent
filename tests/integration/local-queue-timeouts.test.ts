import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("workflow/next", () => ({ withWorkflow: (config: unknown) => config }));
vi.mock("next-intl/plugin", () => ({ default: () => (config: unknown) => config }));
afterEach(() => vi.unstubAllEnvs());

it("disables the local Workflow SDK's header and body deadlines for active deliveries", async () => {
  vi.stubEnv("WORKFLOW_LOCAL_HEADERS_TIMEOUT_MS", undefined);
  vi.stubEnv("WORKFLOW_LOCAL_BODY_TIMEOUT_MS", undefined);
  const projectRequire = createRequire(import.meta.url);
  const workflowRequire = createRequire(projectRequire.resolve("workflow"));
  const coreRequire = createRequire(workflowRequire.resolve("@workflow/core/runtime"));
  const worldDist = dirname(coreRequire.resolve("@workflow/world-local"));
  const queueUrl = pathToFileURL(join(worldDist, "queue.js")).href;
  const { getQueueAgentOptions } = await import(/* @vite-ignore */ queueUrl);
  expect(getQueueAgentOptions()).toMatchObject({ headersTimeout: 30_000, bodyTimeout: 30_000 });

  await import("../../next.config");
  expect(getQueueAgentOptions()).toMatchObject({ headersTimeout: 0, bodyTimeout: 0 });
});
