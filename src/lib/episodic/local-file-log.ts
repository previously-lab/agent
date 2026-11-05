/** Plain-file commit ledger for local memory roots that are not Git repos. */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getMemoryRoot } from "@/lib/whitelist";
import type { GuardedEntry } from "@/lib/docs/write-validation";

export const LOCAL_FILE_LOG_PATH = "memory/config/local-commit-log.json";

interface LocalFileCommit {
  oid: string;
  message: string;
  committedAtMs: number;
  parents: string[];
}

interface LocalFileLog { version: 1; entries: LocalFileCommit[] }

function readLog(root: string): LocalFileLog {
  const path = join(root, "config", "local-commit-log.json");
  if (!existsSync(path)) return { version: 1, entries: [] };
  const value = JSON.parse(readFileSync(path, "utf8")) as LocalFileLog;
  if (value?.version !== 1 || !Array.isArray(value.entries) || value.entries.some(entry =>
    !entry || !/^[a-f0-9]{64}$/.test(entry.oid) || typeof entry.message !== "string"
    || !Number.isFinite(entry.committedAtMs) || !Array.isArray(entry.parents)
    || entry.parents.some(parent => typeof parent !== "string" || !/^[a-f0-9]{64}$/.test(parent)))) {
    throw new Error("Invalid local commit ledger");
  }
  return value;
}

/** Newest-first, matching isomorphic-git's local log reader. */
export function readLocalFileCommits(root: string): LocalFileCommit[] {
  return [...readLog(root).entries].reverse();
}

/** Runs inside commitLocalBatch's lock/rollback window. */
export function withLocalFileCommit(entries: readonly GuardedEntry[], message: string): GuardedEntry[] {
  if (entries.some(entry => entry.path === LOCAL_FILE_LOG_PATH)) {
    throw new Error("The local commit ledger is reserved for storage commits");
  }
  const log = readLog(getMemoryRoot());
  const payload = entries.map(entry => ({
    path: entry.path,
    content: entry.content,
    ...(entry.encoding ? { encoding: entry.encoding } : {}),
  })).sort((a, b) => a.path.localeCompare(b.path));
  // The same message and exact writes are one idempotent operation on retry.
  const oid = createHash("sha256").update(JSON.stringify({ message, payload })).digest("hex");
  if (log.entries.some(entry => entry.oid === oid)) return [...entries];
  const parent = log.entries.at(-1)?.oid;
  const next: LocalFileLog = { version: 1, entries: [...log.entries, {
    oid, message, committedAtMs: Date.now(), parents: parent ? [parent] : [],
  }] };
  return [...entries, { path: LOCAL_FILE_LOG_PATH, content: JSON.stringify(next) + "\n" }];
}
