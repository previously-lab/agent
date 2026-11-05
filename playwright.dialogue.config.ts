import { defineConfig, devices } from "@playwright/test";
import path from "node:path";
import {
  E2E_BASE_URL, E2E_HOME, E2E_MEMORY_ROOT, E2E_TASKS_ROOT, E2E_SESSIONS_ROOT,
  E2E_PORT, E2E_WORKFLOW_ROOT, E2E_DIALOGUE_RUNTIME_ROOT, E2E_DIALOGUE_PROVIDER_ROOT,
} from "./tests/e2e/env";

const preload = (file: string) => `--require "${path.resolve(file).replaceAll("\\", "/")}"`;

/** Real API + durable Workflow + ordinary file store. Only the model transport
 * is mocked. Never reuse the developer's 3000 server or the UI-route mocks. */
export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "**/dialogue-workflow.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  reporter: "list",
  use: { baseURL: E2E_BASE_URL, trace: "retain-on-failure" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["iPhone 13"] } },
  ],
  webServer: {
    command: `node tests/e2e/prepare-env.mjs && node scripts/generate-identity.mjs && pnpm exec next dev --turbopack --port ${E2E_PORT}`,
    port: E2E_PORT,
    reuseExistingServer: false,
    timeout: 180_000,
    env: {
      PREVIOUSLY_MODE: "client",
      PREVIOUSLY_BRAIN: "",
      PREVIOUSLY_HOME: E2E_HOME,
      MEMORY_ROOT: E2E_MEMORY_ROOT,
      TASKS_ROOT: E2E_TASKS_ROOT,
      SESSIONS_ROOT: E2E_SESSIONS_ROOT,
      WORKFLOW_LOCAL_DATA_DIR: E2E_WORKFLOW_ROOT,
      WORKFLOW_TARGET_WORLD: "local",
      WORKFLOW_LOCAL_RECOVER_ACTIVE_RUNS: "0",
      DIALOGUE_RUNTIME_DIR: E2E_DIALOGUE_RUNTIME_ROOT,
      NEXT_DIST_DIR: ".next-dialogue-e2e",
      STORAGE: "local",
      PREVIOUSLY_E2E_PLAIN_DIR: "1",
      AFTRBREZ_DIALOGUE_PROVIDER_ROOT: E2E_DIALOGUE_PROVIDER_ROOT,
      DEEPSEEK_API_KEY: "previously-dialogue-offline-fixture",
      OPENAI_API_KEY: "",
      ANTHROPIC_API_KEY: "",
      TAVILY_API_KEY: "",
      EXA_API_KEY: "",
      BRAVE_SEARCH_API_KEY: "",
      NODE_OPTIONS: preload("tests/e2e/dialogue-offline-preload.cjs"),
    },
  },
});
