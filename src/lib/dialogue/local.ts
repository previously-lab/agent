import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, open, readdir, readFile, unlink } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { bufferedFiles, retryConflict, type DialogueFiles, type DialogueStorage } from "./storage";

type MapNode = { entries: Record<string, string> } | { children: Record<string, string> };
interface Head { revision: number; map: string | null; due: number | null }
const FIRST: Head = { revision: 0, map: null, due: null };
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const isMissing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";

async function read(path: string): Promise<string | null> {
  try { return await readFile(path, "utf8"); }
  catch (error) { if (isMissing(error)) return null; throw error; }
}

async function syncDir(dir: string): Promise<void> {
  // NTFS hard-link creation is atomic, but Node cannot open Windows
  // directories for fsync. This adapter tests process-crash durability;
  // sudden device/power loss on Windows is subject to filesystem guarantees.
  if (process.platform === "win32") return;
  const handle = await open(dir, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

/** Write a complete, fsynced file, then atomically give it a unique name.
 * The destination is never replaced. No lock or expiry can admit two writers
 * for the same revision, including after process death or scheduler pauses. */
async function createOnce(dir: string, name: string, body: string): Promise<boolean> {
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `tmp-${randomUUID()}`);
  const handle = await open(tmp, "wx", 0o600);
  try {
    try { await handle.writeFile(body, "utf8"); await handle.sync(); }
    finally { await handle.close(); }
    try { await link(tmp, join(dir, name)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return false; throw error; }
    await syncDir(dir);
    return true;
  } finally { await unlink(tmp).catch((error) => { if (!isMissing(error)) throw error; }); }
}

export function createLocalDialogueStorage(directory: string): DialogueStorage {
  if (!isAbsolute(directory)) throw new Error("DIALOGUE_RUNTIME_DIR must be an absolute path");
  const root = resolve(directory);
  const dirs = (scope: string) => {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(scope)) throw new Error("Invalid dialogue scope");
    const base = join(root, "scopes", scope);
    return { revisions: join(base, "revisions"), objects: join(base, "objects") };
  };
  const hints = new Map<string, Head>();
  const revisionName = (n: number) => `${n}.json`;
  async function head(scope: string): Promise<Head> {
    const { revisions } = dirs(scope);
    let current = hints.get(scope);
    if (!current) {
      const names = await readdir(revisions).catch((error) => { if (isMissing(error)) return []; throw error; });
      const max = names.reduce((n, name) => /^\d+\.json$/.test(name) ? Math.max(n, Number(name.slice(0, -5))) : n, 0);
      if (max) {
        const found = await read(join(revisions, revisionName(max)));
        if (!found) throw new Error("Dialogue revision disappeared");
        current = JSON.parse(found) as Head;
      } else current = FIRST;
    }
    while (true) {
      const next = await read(join(revisions, revisionName(current.revision + 1)));
      if (next === null) break;
      current = JSON.parse(next) as Head;
    }
    const hint = hints.get(scope);
    if (!hint || hint.revision < current.revision) hints.set(scope, current);
    return current;
  }

  function objects(scope: string) {
    const { objects: dir } = dirs(scope);
    const objectDir = (sha: string) => join(dir, sha.slice(0, 2));
    const cache = new Map<string, Promise<MapNode>>();
    async function get(sha: string): Promise<string> {
      if (!/^[a-f0-9]{64}$/.test(sha)) throw new Error("Invalid dialogue object id");
      const text = await read(join(objectDir(sha), sha));
      if (text === null || hash(text) !== sha) throw new Error("Dialogue object is missing or damaged");
      return text;
    }
    async function put(body: string): Promise<string> {
      const sha = hash(body);
      if (await read(join(objectDir(sha), sha)) === null) await createOnce(objectDir(sha), sha, body);
      return sha;
    }
    function node(sha: string): Promise<MapNode> {
      let item = cache.get(sha);
      if (!item) { item = get(sha).then((body) => JSON.parse(body) as MapNode); cache.set(sha, item); }
      return item;
    }
    async function getFile(ref: string | null, path: string): Promise<string | null> {
      const key = hash(path);
      for (let depth = 0; ref; depth++) {
        const page = await node(ref);
        if ("entries" in page) {
          const body = page.entries[key];
          return body ? get(body) : null;
        }
        ref = page.children[key[depth]] ?? null;
      }
      return null;
    }
    async function pack(entries: Record<string, string>, depth: number): Promise<string | null> {
      const pairs = Object.entries(entries);
      if (!pairs.length) return null;
      if (pairs.length <= 48 || depth >= 64) return put(JSON.stringify({ entries }));
      const shards = new Map<string, Record<string, string>>();
      for (const [key, value] of pairs) {
        const prefix = key[depth];
        const shard = shards.get(prefix) ?? {};
        shard[key] = value;
        shards.set(prefix, shard);
      }
      const children: Record<string, string> = {};
      for (const [prefix, shard] of shards) children[prefix] = (await pack(shard, depth + 1))!;
      return put(JSON.stringify({ children }));
    }
    async function replace(ref: string | null, updates: [string, string | null][], depth: number): Promise<string | null> {
      const page = ref ? await node(ref) : { entries: {} };
      if ("entries" in page) {
        const entries = { ...page.entries };
        for (const [key, sha] of updates) { if (sha) entries[key] = sha; else delete entries[key]; }
        return pack(entries, depth);
      }
      const children = { ...page.children };
      const shards = new Map<string, typeof updates>();
      for (const item of updates) {
        const prefix = item[0][depth];
        const shard = shards.get(prefix) ?? [];
        shard.push(item);
        shards.set(prefix, shard);
      }
      for (const [prefix, shard] of shards) {
        const child = await replace(children[prefix] ?? null, shard, depth + 1);
        if (child) children[prefix] = child; else delete children[prefix];
      }
      return Object.keys(children).length ? put(JSON.stringify({ children })) : null;
    }
    return {
      getFile,
      async apply(ref: string | null, updates: Map<string, string | null>) {
        const next = await Promise.all([...updates].map(async ([path, body]): Promise<[string, string | null]> => [hash(path), body === null ? null : await put(body)]));
        return replace(ref, next, 0);
      },
    };
  }

  return {
    async view<T>(scope: string, operation: (files: DialogueFiles, now: number) => Promise<T>) {
      const initial = await head(scope);
      return operation(bufferedFiles((path) => objects(scope).getFile(initial.map, path)).files, Date.now());
    },
    async transaction<T>(scope: string, operation: (files: DialogueFiles, now: number) => Promise<T>) {
      for (let attempt = 0; attempt < 16; attempt++) {
        const initial = await head(scope);
        const files = objects(scope);
        const buffer = bufferedFiles((path) => files.getFile(initial.map, path));
        const result = await operation(buffer.files, Date.now());
        if (!buffer.writes.size && buffer.due === undefined) return result;
        const next: Head = { revision: initial.revision + 1, map: await files.apply(initial.map, buffer.writes), due: buffer.due === undefined ? initial.due : buffer.due };
        if (await createOnce(dirs(scope).revisions, revisionName(next.revision), JSON.stringify(next))) {
          hints.set(scope, next);
          return result;
        }
        await retryConflict(attempt);
      }
      throw new Error("Dialogue files were busy; retry the same operation");
    },
    async dueScopes(now, limit) {
      const scopes = await readdir(join(root, "scopes"), { withFileTypes: true }).catch((error) => { if (isMissing(error)) return []; throw error; });
      const due = await Promise.all(scopes.filter((entry) => entry.isDirectory() && /^[A-Za-z0-9_-]{1,128}$/.test(entry.name)).map(async (entry) => ({ scope: entry.name, due: (await head(entry.name)).due })));
      return due.filter((entry) => entry.due !== null && entry.due <= now).sort((a, b) => a.due! - b.due!).slice(0, limit).map(({ scope }) => scope);
    },
  };
}
