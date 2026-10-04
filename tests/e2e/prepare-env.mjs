/**
 * Prepares the isolated e2e state roots before the dev server boots — chained
 * into the Playwright webServer command, so it reads the same PREVIOUSLY_HOME /
 * MEMORY_ROOT env vars the server gets (set in playwright.config.ts).
 *
 * Wipes both roots for a clean run, then seeds a user config pinning the chat
 * model to bridge/claude so the model-selector spec gets a deterministic,
 * locale-independent trigger label regardless of which API keys the host
 * machine happens to export.
 */
import { rm, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const home = process.env.PREVIOUSLY_HOME;
const memoryRoot = process.env.MEMORY_ROOT;
if (!home || !memoryRoot) {
  throw new Error("prepare-env: PREVIOUSLY_HOME and MEMORY_ROOT must be set");
}
// Paranoia guard: only ever wipe directories under the previously-e2e temp root.
for (const dir of [home, memoryRoot]) {
  if (!dir.includes("previously-e2e")) {
    throw new Error(`prepare-env: refusing to wipe unexpected path: ${dir}`);
  }
}

for (const dir of [home, memoryRoot]) {
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
}

// memory/config/settings.json re-roots at MEMORY_ROOT/config/settings.json.
await mkdir(path.join(memoryRoot, "config"), { recursive: true });
await writeFile(
  path.join(memoryRoot, "config", "settings.json"),
  JSON.stringify({ model: { provider: "bridge/claude" } }, null, 2) + "\n",
);
