/** A separate Node process opening the actual dialogue store. The test driver
 * supplies only private fixture roots; this worker never loads a dotenv file. */
import { existsSync, realpathSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const source = join(repo, "src");
const privateRoot = process.env.AFTRBREZ_DIALOGUE_TEST_ROOT;
if (!process.send || !privateRoot || !isAbsolute(privateRoot)) {
  throw new Error("Dialogue peer requires an isolated IPC fixture");
}
const root = realpathSync(privateRoot);
if (dirname(root) !== realpathSync(tmpdir()) || !basename(root).startsWith("aftrbrez-dialogue-test-")) {
  throw new Error("Dialogue peer refused a non-fixture root");
}
for (const [key, child] of Object.entries({
  PREVIOUSLY_HOME: "home", MEMORY_ROOT: "memory", SESSIONS_ROOT: "sessions",
  TASKS_ROOT: "tasks", WORKFLOW_LOCAL_DATA_DIR: "workflow", DIALOGUE_RUNTIME_DIR: "dialogue",
})) {
  if (resolve(process.env[key] ?? "") !== join(root, child)) throw new Error(`Dialogue peer refused ${key}`);
}
for (const key of ["DIALOGUE_DATABASE_URL", "DIALOGUE_SQLITE_PATH", "DATABASE_URL", "POSTGRES_URL"]) {
  if (process.env[key]) throw new Error(`File dialogue peer does not allow ${key}`);
}

function sourceFile(candidate) {
  const inside = relative(source, candidate);
  if (inside === ".." || inside.startsWith("../") || inside.startsWith("..\\") || isAbsolute(inside)) return;
  return [candidate, `${candidate}.ts`, join(candidate, "index.ts")]
    .find((path) => path.endsWith(".ts") && existsSync(path));
}

// Native Node TypeScript support executes the product modules in a different
// process. Resolve the same @/ and extensionless TS imports as the app.
registerHooks({
  resolve(specifier, context, nextResolve) {
    let file;
    if (specifier.startsWith("@/")) file = sourceFile(resolve(source, specifier.slice(2)));
    if (specifier.startsWith(".") && context.parentURL?.startsWith(pathToFileURL(source).href + "/")) {
      file = sourceFile(resolve(dirname(fileURLToPath(context.parentURL)), specifier));
    }
    return nextResolve(file ? pathToFileURL(file).href : specifier, context);
  },
});

const [{ createDialogueStore }, { createLocalDialogueStorage }] = await Promise.all([
  import(pathToFileURL(join(source, "lib/dialogue/store.ts")).href),
  import(pathToFileURL(join(source, "lib/dialogue/local.ts")).href),
]);
const store = createDialogueStore(createLocalDialogueStorage(process.env.DIALOGUE_RUNTIME_DIR));
const systemNow = Date.now;
let timeOffset = 0;
Date.now = () => systemNow() + timeOffset;
process.on("message", async ({ id, method, args }) => {
  try {
    // Advance the local adapter's clock without sleeping through its lease.
    // All transactions, persisted timestamps and cross-process locks are real.
    if (method === "fixture.advanceClock") {
      if (!Number.isSafeInteger(args[0]) || args[0] < 0 || args[0] > 120_000) throw new Error("Invalid fixture clock advance");
      timeOffset += args[0];
      process.send({ id, ok: true });
      return;
    }
    const operation = store[method];
    if (typeof operation !== "function") throw new Error(`Unknown dialogue operation: ${method}`);
    const value = await Reflect.apply(operation, store, args);
    process.send({ id, ok: true, value });
  } catch (error) {
    process.send({ id, ok: false, message: error instanceof Error ? error.message : String(error) });
  }
});
process.send({ ready: true, pid: process.pid });
