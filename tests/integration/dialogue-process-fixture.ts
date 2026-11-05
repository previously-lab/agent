import { fork } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DialogueStore } from "@/lib/dialogue/store";

const peerScript = fileURLToPath(new URL("./dialogue-process-peer.mjs", import.meta.url));
const denyNetwork = fileURLToPath(new URL("../e2e/deny-network.cjs", import.meta.url));

function withDeadline<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Dialogue fixture timed out: ${label}`)), 8_000);
    }),
  ]).finally(() => clearTimeout(timer));
}

type PeerReply = { id: number; ok: true; value: unknown } | { id: number; ok: false; message: string };

export async function createDialogueProcessFixture() {
  const temp = await realpath(tmpdir());
  const root = await realpath(await mkdtemp(join(temp, "aftrbrez-dialogue-test-")));
  const dirs = {
    PREVIOUSLY_HOME: join(root, "home"), MEMORY_ROOT: join(root, "memory"),
    SESSIONS_ROOT: join(root, "sessions"), TASKS_ROOT: join(root, "tasks"),
    WORKFLOW_LOCAL_DATA_DIR: join(root, "workflow"),
    DIALOGUE_RUNTIME_DIR: join(root, "dialogue"),
  };
  await Promise.all(Object.values(dirs).map((dir) => mkdir(dir)));
  const peers = new Set<() => Promise<void>>();

  async function connect() {
    const forkOptions: Parameters<typeof fork>[2] & { windowsHide: true } = {
      windowsHide: true,
      execArgv: ["--experimental-transform-types", "--require", denyNetwork],
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      // Explicit allowlist: a fixture process cannot inherit provider or DB
      // credentials, repo roots, dotenv preload, or a production Workflow world.
      env: {
        SystemRoot: process.env.SystemRoot, PATH: process.env.PATH,
        TEMP: temp, TMP: temp, TMPDIR: temp,
        AFTRBREZ_DIALOGUE_TEST_ROOT: root,
        NODE_ENV: "test", STORAGE: "local", PREVIOUSLY_MODE: "client", PREVIOUSLY_BRAIN: "",
        WORKFLOW_TARGET_WORLD: "local", WORKFLOW_LOCAL_RECOVER_ACTIVE_RUNS: "0",
        ...dirs,
      },
    };
    const child = fork(peerScript, [], forkOptions);
    let stderr = "";
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-4096); });
    const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
    const ready = Promise.withResolvers<number>();
    const exited = Promise.withResolvers<void>();
    let isClosed = false;
    let next = 0;
    const fail = (error: Error) => {
      ready.reject(error);
      for (const request of pending.values()) request.reject(error);
    };
    child.on("error", fail);
    child.once("close", (code, signal) => {
      isClosed = true;
      fail(new Error(`Dialogue fixture peer exited (${code ?? signal}): ${stderr.trim()}`));
      exited.resolve();
    });
    child.on("message", (message: { ready: true; pid: number } | PeerReply) => {
      if ("ready" in message) { ready.resolve(message.pid); return; }
      const request = pending.get(message.id);
      if (!request) return;
      if (message.ok) request.resolve(message.value);
      else request.reject(new Error(message.message));
    });

    async function terminate() {
      if (!isClosed) child.kill("SIGKILL");
      await withDeadline(exited.promise, "peer exit");
      peers.delete(terminate);
    }
    peers.add(terminate);
    const pid = await withDeadline(ready.promise, "peer startup").catch(async (error: unknown) => {
      await terminate();
      throw error;
    });
    async function call<T>(method: string, ...args: unknown[]): Promise<T> {
      const id = ++next;
      const reply = Promise.withResolvers<unknown>();
      pending.set(id, reply);
      child.send({ id, method, args }, (error) => { if (error) reply.reject(error); });
      try { return await withDeadline(reply.promise, method) as T; }
      finally { pending.delete(id); }
    }
    return {
      pid, terminate,
      advanceClock: (ms: number) => call<void>("fixture.advanceClock", ms),
      invoke: <M extends keyof DialogueStore>(method: M, ...args: Parameters<DialogueStore[M]>) =>
        call<Awaited<ReturnType<DialogueStore[M]>>>(method, ...args),
    };
  }

  return {
    root,
    connect,
    async close() {
      await Promise.all([...peers].map((terminate) => terminate()));
      const target = await realpath(root);
      if (target !== root || dirname(target) !== temp || !basename(target).startsWith("aftrbrez-dialogue-test-")) {
        throw new Error("Refusing to remove a non-fixture dialogue root");
      }
      await rm(target, { recursive: true, force: true });
    },
  };
}
