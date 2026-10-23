/**
 * Prepares the isolated e2e state roots before the dev server boots — chained
 * into the Playwright webServer command, so it reads the same PREVIOUSLY_HOME /
 * MEMORY_ROOT env vars the server gets (set in playwright.config.ts).
 *
 * Wipes only the three known roots for a clean, offline run.
 */
import { rm, mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import os from "node:os";

const home = process.env.PREVIOUSLY_HOME;
const memoryRoot = process.env.MEMORY_ROOT;
const workflowRoot = process.env.WORKFLOW_LOCAL_DATA_DIR;
if (!home || !memoryRoot) {
  throw new Error("prepare-env: PREVIOUSLY_HOME and MEMORY_ROOT must be set");
}
// Resolve every recursive-delete target and require the exact intended paths.
const fixtureRoot = path.resolve(os.tmpdir(), "previously-e2e");
for (const [name, dir] of [["home", home], ["memory", memoryRoot], ...(workflowRoot ? [["workflow", workflowRoot]] : [])]) {
  if (path.resolve(dir) !== path.join(fixtureRoot, name)) {
    throw new Error(`prepare-env: refusing to wipe unexpected path: ${dir}`);
  }
}

for (const dir of [home, memoryRoot, ...(workflowRoot ? [workflowRoot] : [])]) {
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
}

// memory/config/settings.json re-roots at MEMORY_ROOT/config/settings.json.
await mkdir(path.join(memoryRoot, "config"), { recursive: true });
await writeFile(
  path.join(memoryRoot, "config", "settings.json"),
  JSON.stringify({ model: { provider: "deepseek-flash" } }, null, 2) + "\n",
);

// A git root, so the agent-flow spec can assert on the commit log the same way
// production does (Summary / Reflection round prefixes, the `seen:` trailer).
// Best-effort: a host without git keeps the filesystem-only assertions.
try {
  execFileSync("git", ["init", "-q"], { cwd: memoryRoot, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "e2e@previously.local"], {
    cwd: memoryRoot,
    stdio: "ignore",
  });
  execFileSync("git", ["config", "user.name", "previously e2e"], {
    cwd: memoryRoot,
    stdio: "ignore",
  });
} catch {
  /* no git on this host — the spec degrades to filesystem assertions */
}
