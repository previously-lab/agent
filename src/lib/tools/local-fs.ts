/**
 * Local filesystem tools — mock GitHub for development without real API calls.
 * Same whitelist constraints, same error handling, just reads from disk.
 *
 * Files resolve under the repo root by default; `memory/` paths re-root at
 * MEMORY_ROOT when that env var is set (see @/lib/whitelist).
 *
 * READS ARE NEVER CACHED — deliberately, and the decision is written down in
 * `ttlForPath`: a dev filesystem is written by processes that never touch our
 * write path (an editor, a `git checkout`, the CLI in client/bridge mode), so
 * no tag is ever revalidated on those writes and any TTL would be a window of
 * stale data on the backend where a human is looking straight at the file.
 * The reads still go through `cachedFetch` at `CACHE_TTLS.UNCACHED` so that
 * "which backends cache" is answered in one place (`ttlForPath`) instead of
 * being the absence of a call here.
 */
import { isPathAllowed, resolveLocalDataPath } from "@/lib/whitelist";
import {
  cachedFetch,
  ttlForPath,
  type ReadOptions,
} from "@/lib/cache/data-cache";
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync, rmSync } from "fs";
import { join, dirname } from "path";

const MAX_FILE_SIZE_BYTES = 1_000_000;

// ─── SIMULATED LOCAL LATENCY (dev-only, env-gated) ──────────────────────────
// The local backend stands in for GitHub, where every read is a round trip.
// `PREVIOUSLY_LOCAL_LATENCY_MS` makes the two DIRECT paths (a real file read,
// a real directory list) sleep that long — one tick per simulated request —
// so first-paint behaviour can be measured against a realistic backend
// without deploying. `PREVIOUSLY_LOCAL_LATENCY_LOG=1` prints one line per
// simulated request (the read census). Both are unset in production, and the
// GitHub backend never reads them.

const LATENCY_MS = (() => {
  const n = Number(process.env.PREVIOUSLY_LOCAL_LATENCY_MS ?? "0");
  return Number.isFinite(n) && n > 0 ? n : 0;
})();

const LATENCY_LOG = process.env.PREVIOUSLY_LOCAL_LATENCY_LOG === "1";

async function simulateLatency(op: string, path: string): Promise<void> {
  if (LATENCY_LOG) console.log(`[latency] ${Date.now()} ${op} ${path}`);
  if (LATENCY_MS > 0) {
    await new Promise((resolve) => setTimeout(resolve, LATENCY_MS));
  }
}

/**
 * Every file path under `root` (repo-relative), ONE walk and ONE simulated
 * latency tick — the local stand-in for GitHub's single recursive Trees
 * call. Direct fs on purpose: paying a tick per directory here would model a
 * backend nobody has.
 */
export async function walkPathsLocal(
  root: string,
  maxEntries = 50_000,
): Promise<string[]> {
  await simulateLatency("walk", root);
  const base = resolveLocalDataPath(root);
  const out: string[] = [];
  const stack: Array<{ abs: string; rel: string }> = [{ abs: base, rel: root }];
  while (stack.length && out.length < maxEntries) {
    const { abs, rel } = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const childRel = `${rel}/${e.name}`;
      if (e.isDirectory()) stack.push({ abs: join(abs, e.name), rel: childRel });
      else out.push(childRel);
    }
  }
  return out;
}

export async function readFileLocal(
  path: string,
  opts?: ReadOptions
): Promise<string> {
  if (!isPathAllowed(path)) {
    throw new Error(`Access denied: path "${path}" is outside allowed directories`);
  }

  // `opts.fresh` is a no-op on this backend — the read is already direct.
  return cachedFetch(
    ["local", "file", path],
    ttlForPath(path, "local"),
    [],
    () => readLocalDirect(path),
    opts,
  );
}

async function readLocalDirect(path: string): Promise<string> {
  await simulateLatency("read", path);
  const fullPath = resolveLocalDataPath(path);
  if (!existsSync(fullPath)) {
    throw new Error(`File not found: "${path}"`);
  }

  const stat = statSync(fullPath);
  if (stat.isDirectory()) {
    throw new Error(`"${path}" is a directory, not a file`);
  }
  if (stat.size > MAX_FILE_SIZE_BYTES) {
    throw new Error(`File too large (${stat.size} bytes). Maximum is ${MAX_FILE_SIZE_BYTES} bytes.`);
  }

  return readFileSync(fullPath, "utf-8");
}

/** The file's last-write date, local `YYYY-MM-DD` — a real stored fact the
 *  dossier's letterhead prints as its date line. Null when the file does
 *  not exist. */
export async function fileModifiedDateLocal(
  path: string,
): Promise<string | null> {
  if (!isPathAllowed(path)) {
    throw new Error(`Access denied: path "${path}" is outside allowed directories`);
  }
  const fullPath = resolveLocalDataPath(path);
  if (!existsSync(fullPath)) return null;
  const m = statSync(fullPath).mtime;
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${m.getFullYear()}-${pad(m.getMonth() + 1)}-${pad(m.getDate())}`;
}

export async function writeFileLocal(
  path: string,
  content: string
): Promise<{ path: string; created: boolean }> {
  if (!isPathAllowed(path)) {
    throw new Error(`Access denied: path "${path}" is outside allowed directories`);
  }

  if (Buffer.byteLength(content, "utf-8") > MAX_FILE_SIZE_BYTES) {
    throw new Error(`Content too large. Maximum is ${MAX_FILE_SIZE_BYTES} bytes.`);
  }

  const fullPath = resolveLocalDataPath(path);
  const dir = dirname(fullPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const existed = existsSync(fullPath);
  writeFileSync(fullPath, content, "utf-8");

  return { path, created: !existed };
}

/**
 * Delete a file. Whitelist-checked like every other access here. A missing
 * file is NOT an error — deletes are idempotent (a queued delete may race a
 * file that never landed, and the settle path re-reads listings anyway).
 */
export async function deleteFileLocal(path: string): Promise<void> {
  if (!isPathAllowed(path)) {
    throw new Error(`Access denied: path "${path}" is outside allowed directories`);
  }

  const fullPath = resolveLocalDataPath(path);
  try {
    rmSync(fullPath, { force: true });
  } catch {
    // unreadable / already gone — idempotent delete
  }
}

/**
 * Write raw bytes (attachments). Same whitelist and size discipline as the
 * text writer — the caller enforces the binary fuse (5MB) BEFORE calling;
 * this layer enforces it again as the last-resort guard.
 */
export async function writeBinaryFileLocal(
  path: string,
  data: Buffer
): Promise<{ path: string; created: boolean }> {
  if (!isPathAllowed(path)) {
    throw new Error(`Access denied: path "${path}" is outside allowed directories`);
  }

  if (data.byteLength > MAX_BINARY_FILE_SIZE_BYTES) {
    throw new Error(
      `File too large (${data.byteLength} bytes). Maximum is ${MAX_BINARY_FILE_SIZE_BYTES} bytes.`
    );
  }

  const fullPath = resolveLocalDataPath(path);
  const dir = dirname(fullPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const existed = existsSync(fullPath);
  writeFileSync(fullPath, data);

  return { path, created: !existed };
}

/** Read raw bytes (attachments). Throws when the file does not exist. */
export async function readBinaryFileLocal(path: string): Promise<Buffer> {
  if (!isPathAllowed(path)) {
    throw new Error(`Access denied: path "${path}" is outside allowed directories`);
  }

  const fullPath = resolveLocalDataPath(path);
  if (!existsSync(fullPath)) {
    throw new Error(`File not found: "${path}"`);
  }
  if (statSync(fullPath).isDirectory()) {
    throw new Error(`"${path}" is a directory, not a file`);
  }

  return readFileSync(fullPath);
}

/** Binary fuse ceiling — attachments above this are REFUSED, never truncated. */
export const MAX_BINARY_FILE_SIZE_BYTES = 5 * 1024 * 1024;

export async function listFilesLocal(
  path: string,
  opts?: ReadOptions
): Promise<Array<{ name: string; type: "file" | "dir"; path: string; size?: number }>> {
  if (!isPathAllowed(path)) {
    throw new Error(`Access denied: path "${path}" is outside allowed directories`);
  }

  // Uncached for the same reason as `readFileLocal`; `listFilesLocal` is also
  // how dev discovers slice directories, so a stale listing would hide a file
  // the developer is looking at in their editor.
  return cachedFetch(
    ["local", "list", path],
    ttlForPath(path, "local"),
    [],
    () => listLocalDirect(path),
    opts,
  );
}

async function listLocalDirect(
  path: string
): Promise<Array<{ name: string; type: "file" | "dir"; path: string; size?: number }>> {
  await simulateLatency("list", path);
  const fullPath = resolveLocalDataPath(path);
  if (!existsSync(fullPath)) {
    throw new Error(`Directory not found: "${path}"`);
  }

  const stat = statSync(fullPath);
  if (stat.isFile()) {
    return [{ name: path.split("/").pop() ?? path, type: "file", path, size: stat.size }];
  }

  const entries = readdirSync(fullPath);
  return entries.map((name) => {
    const entryPath = join(fullPath, name);
    const entryStat = statSync(entryPath);
    return {
      name,
      type: entryStat.isDirectory() ? "dir" as const : "file" as const,
      path: `${path.replace(/\/$/, "")}/${name}`,
      // Present for files; the per-case attachment fuse (25MB) sums these.
      ...(entryStat.isDirectory() ? {} : { size: entryStat.size }),
    };
  });
}
