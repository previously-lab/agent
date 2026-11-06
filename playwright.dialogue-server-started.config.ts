import { defineConfig } from "@playwright/test";
import path from "node:path";
import dialogueConfig from "./playwright.dialogue.config";

const webServer = dialogueConfig.webServer;
if (!webServer || Array.isArray(webServer)) throw new Error("Expected the dialogue E2E webServer object");
const preload = `--require "${path.resolve("tests/e2e/dialogue-server-started-preload.cjs").replaceAll("\\", "/")}"`;

/** v2 server-started dialogue runs beside the developer server on the existing
 * isolated E2E port/state roots. Old dialogue behavior stays in its own suite. */
export default defineConfig({
  ...dialogueConfig,
  testMatch: "**/dialogue-server-started.spec.ts",
  webServer: {
    ...webServer,
    env: { ...webServer.env, NODE_OPTIONS: preload },
  },
});
