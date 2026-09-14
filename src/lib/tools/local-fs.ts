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
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from "fs";
import { join, dirname } from "path";

const MAX_FILE_SIZE_BYTES = 1_000_000;

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

export async function listFilesLocal(
  path: string,
  opts?: ReadOptions
): Promise<Array<{ name: string; type: "file" | "dir"; path: string }>> {
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
): Promise<Array<{ name: string; type: "file" | "dir"; path: string }>> {
  const fullPath = resolveLocalDataPath(path);
  if (!existsSync(fullPath)) {
    throw new Error(`Directory not found: "${path}"`);
  }

  const stat = statSync(fullPath);
  if (stat.isFile()) {
    return [{ name: path.split("/").pop() ?? path, type: "file", path }];
  }

  const entries = readdirSync(fullPath);
  return entries.map((name) => {
    const entryPath = join(fullPath, name);
    const entryStat = statSync(entryPath);
    return {
      name,
      type: entryStat.isDirectory() ? "dir" as const : "file" as const,
      path: `${path.replace(/\/$/, "")}/${name}`,
    };
  });
}
