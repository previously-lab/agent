/**
 * Per-document lock + locked read-modify-write for the document system
 * (v0.15 design §4.3 rule 1).
 *
 * Two writers (the immediate stream's scribe section and the background
 * research pass, and later the independent background run) can target the
 * same document file from the same process. The lock serializes their
 * read-modify-write cycles per FILE NAME — the document's identity — reusing
 * the keyed-mutex prototype from slice-mutex.ts (`withSliceLock("doc:<文件名>")`).
 *
 * Discipline (same as slice-mutex): the lock is acquired and released INSIDE
 * a single write step — never held across step boundaries, so the workflow's
 * deterministic-replay constraint is untouched. Cross-PROCESS conflicts are
 * not covered (same as slices): append-only entries make them non-fatal —
 * the loser re-reads and appends its content as a new dated entry (§4.3
 * rule 2), and the batch flush's non-fast-forward rejection surfaces the
 * race at commit time.
 *
 * `updateDocUnderLock` makes the discipline structural: the read (fresh —
 * a read that FEEDS A WRITE may not come from the data cache, see
 * io-helpers), the pure mutation, the name validation, and the write all
 * happen inside the lock, so no caller can accidentally do the read outside
 * it.
 */
import { withSliceLock } from "./slice-mutex";
import { fsReadFile, fsWriteFile, type WriteBatch } from "./io-helpers";
import {
  isValidDocFileName,
  parseDoc,
  serializeDoc,
  type DocKind,
  type ParsedDoc,
} from "@/lib/docs";

/** The docs root (design §1): subdirectories are the closed type set. */
export const DOCS_ROOT = "memory/docs";

/** Repo-relative path of a document file. Kind is positional (the directory). */
export function docFilePath(kind: DocKind, fileName: string): string {
  return `${DOCS_ROOT}/${kind}/${fileName}`;
}

/**
 * Run `fn` holding the per-document lock for `fileName`. Calls for the same
 * document serialize in arrival order; different documents run concurrently.
 */
export function withDocLock<T>(fileName: string, fn: () => Promise<T>): Promise<T> {
  return withSliceLock(`doc:${fileName}`, fn);
}

/**
 * Read + parse a document by kind and file name. Returns null when the file
 * is missing — an absent document is a normal state (the filesystem is the
 * index), never an error. Parsing is tolerant by the notation contract.
 */
export async function readDocFile(
  kind: DocKind,
  fileName: string,
  batch?: WriteBatch,
): Promise<ParsedDoc | null> {
  let raw: string;
  try {
    raw = await fsReadFile(docFilePath(kind, fileName), batch, { fresh: true });
  } catch {
    return null;
  }
  return parseDoc(raw, fileName, kind);
}

/**
 * Locked read-modify-write on one document:
 *   1. validate the file name against the naming red line (the writer's
 *      last-resort guard — a doc name must never collide with the slice-id
 *      namespace),
 *   2. read the current doc INSIDE the lock (fresh — never the data cache;
 *      batch-pending writes still win, preserving read-your-writes),
 *   3. apply the pure mutation (built on src/lib/docs write-ops),
 *   4. serialize + queue the write into the caller's batch.
 *
 * A mutation returning null means "nothing worth writing" — no file touch
 * (an empty run is a legal outcome, design §3.2). Throws on an illegal file
 * name; I/O failures propagate to the caller, whose contract is to degrade
 * (the document passes are best-effort, never turn-fatal).
 */
export async function updateDocUnderLock(
  kind: DocKind,
  fileName: string,
  batch: WriteBatch | undefined,
  mutate: (current: ParsedDoc | null) => ParsedDoc | null,
): Promise<{ path: string; wrote: boolean }> {
  return withDocLock(fileName, async () => {
    if (!isValidDocFileName(fileName, kind)) {
      throw new Error(`Illegal ${kind} document file name: ${JSON.stringify(fileName)}`);
    }
    const current = await readDocFile(kind, fileName, batch);
    const next = mutate(current);
    const path = docFilePath(kind, fileName);
    if (!next) return { path, wrote: false };
    await fsWriteFile(path, serializeDoc(next), batch);
    return { path, wrote: true };
  });
}
