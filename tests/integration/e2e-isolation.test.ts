import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-isolation-")); });
afterEach(() => {
  vi.unstubAllEnvs();
  const relative = path.relative(os.tmpdir(), root);
  expect(relative.startsWith("e2e-isolation-") && !relative.includes(path.sep)).toBe(true);
  fs.rmSync(root, { recursive: true, force: true });
});

function fixtureEnv(): NodeJS.ProcessEnv {
  const fixture = path.join(root, "previously-e2e");
  return { ...process.env, TMPDIR: root, TMP: root, TEMP: root, NODE_OPTIONS: "",
    PREVIOUSLY_HOME: path.join(fixture, "home"), MEMORY_ROOT: path.join(fixture, "memory"),
    TASKS_ROOT: path.join(fixture, "tasks"), SESSIONS_ROOT: path.join(fixture, "sessions"),
    WORKFLOW_LOCAL_DATA_DIR: path.join(fixture, "workflow") };
}
function prepare(env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [path.resolve("tests/e2e/prepare-env.mjs")], { env, encoding: "utf8", timeout: 10_000 });
}

describe("E2E storage isolation", () => {
  it("configures every writable data root explicitly for the server", async () => {
    vi.stubEnv("E2E_EXTERNAL_BASE_URL", "");
    const { default: config } = await import("../../playwright.config");
    const server = config.webServer;
    if (!server || Array.isArray(server)) throw new Error("Expected the isolated E2E web server");
    const { E2E_MEMORY_ROOT, E2E_TASKS_ROOT, E2E_SESSIONS_ROOT } = await import("../e2e/env");
    expect(server.env).toMatchObject({ MEMORY_ROOT: E2E_MEMORY_ROOT, TASKS_ROOT: E2E_TASKS_ROOT, SESSIONS_ROOT: E2E_SESSIONS_ROOT });
    for (const key of ["MEMORY_ROOT", "TASKS_ROOT", "SESSIONS_ROOT"]) vi.stubEnv(key, server.env![key]);
    const { resolveLocalDataPath } = await import("@/lib/whitelist");
    expect(resolveLocalDataPath("sessions/attachment-drafts/fixture.json")).toBe(path.join(E2E_SESSIONS_ROOT, "attachment-drafts/fixture.json"));
  });

  it("prepares sessions and tasks along with the other throwaway roots", () => {
    const env = fixtureEnv();
    for (const name of ["TASKS_ROOT", "SESSIONS_ROOT"]) {
      fs.mkdirSync(env[name]!, { recursive: true });
      fs.writeFileSync(path.join(env[name]!, "old-fixture"), "old fixture");
    }
    const result = prepare(env);
    expect(result.status, result.stderr).toBe(0);
    expect(fs.readdirSync(env.SESSIONS_ROOT!)).toEqual([]);
    expect(fs.readdirSync(env.TASKS_ROOT!)).toEqual([]);
    expect(fs.existsSync(path.join(env.MEMORY_ROOT!, "config/settings.json"))).toBe(true);
  });

  it.each(["missing", "repository"])("rejects a %s sessions root before wiping any fixture data", (kind) => {
    const env = fixtureEnv();
    fs.mkdirSync(env.PREVIOUSLY_HOME!, { recursive: true });
    const marker = path.join(env.PREVIOUSLY_HOME!, "keep");
    fs.writeFileSync(marker, "preserve");
    if (kind === "missing") delete env.SESSIONS_ROOT;
    else env.SESSIONS_ROOT = path.resolve("sessions");
    const result = prepare(env);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(kind === "missing" ? "SESSIONS_ROOT must be set" : "refusing to wipe unexpected path");
    expect(fs.readFileSync(marker, "utf8")).toBe("preserve");
  });
});
