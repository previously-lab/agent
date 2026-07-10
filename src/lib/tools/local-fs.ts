/**
 * Local filesystem tools — mock GitHub for development without real API calls.
 * Same whitelist constraints, same error handling, just reads from disk.
 */
import { isPathAllowed } from "@/lib/whitelist";
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from "fs";
import { join, dirname } from "path";

const DATA_ROOT = join(process.cwd());

const MAX_FILE_SIZE_BYTES = 1_000_000;

/** Demo mode: redirect memory/ reads to a pre-seeded persona dataset. */
const DEMO_MODE = process.env.DEMO_MODE === "true";
const DEMO_PATH_PREFIX = "memory/demo/personal_14";

/**
 * Resolve a path for demo mode.
 * When DEMO_MODE is set, all memory/ paths are redirected to the demo persona data.
 * Other allowed paths (tasks/, sessions/) continue to use real directories.
 */
function resolveDemoPath(originalPath: string): string {
  if (!DEMO_MODE) return originalPath;
  if (originalPath.startsWith("memory/")) {
    return originalPath.replace("memory/", DEMO_PATH_PREFIX + "/");
  }
  return originalPath;
}

export async function readFileLocal(path: string): Promise<string> {
  const resolvedPath = resolveDemoPath(path);

  if (!isPathAllowed(path)) {
    throw new Error(`Access denied: path "${path}" is outside allowed directories`);
  }

  const fullPath = join(DATA_ROOT, resolvedPath);
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
  const resolvedPath = resolveDemoPath(path);

  if (!isPathAllowed(path)) {
    throw new Error(`Access denied: path "${path}" is outside allowed directories`);
  }

  // Demo mode is strictly read-only: accept the write so callers/UI behave as
  // if it succeeded, but never persist it (the public demo has no auth).
  if (DEMO_MODE) {
    return { path, created: false };
  }

  if (Buffer.byteLength(content, "utf-8") > MAX_FILE_SIZE_BYTES) {
    throw new Error(`Content too large. Maximum is ${MAX_FILE_SIZE_BYTES} bytes.`);
  }

  const fullPath = join(DATA_ROOT, resolvedPath);
  const dir = dirname(fullPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const existed = existsSync(fullPath);
  writeFileSync(fullPath, content, "utf-8");

  return { path, created: !existed };
}

export async function listFilesLocal(
  path: string
): Promise<Array<{ name: string; type: "file" | "dir"; path: string }>> {
  const resolvedPath = resolveDemoPath(path);

  if (!isPathAllowed(path)) {
    throw new Error(`Access denied: path "${path}" is outside allowed directories`);
  }

  const fullPath = join(DATA_ROOT, resolvedPath);
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
