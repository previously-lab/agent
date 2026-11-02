/** Shared final-write validation; storage adapters supply uncached reads under their commit lock/version. */
import { assertDocumentWrite, isAuthoredDocumentPath } from "./write-limits";
import { historyDigest, isHistoryArchiveFileName, parseHistoryArchive } from "./history-archive";
import { WriteRefusal } from "./write-window";

export interface DocumentMaintenance { sourceRevision: string; archiveHeadRef: string }
export interface GuardedEntry { path: string; content: string | null; encoding?: "utf-8" | "base64" }
export interface DocumentWriteChecks {
  bases?: Map<string, string | null>;
  maintenance?: Map<string, DocumentMaintenance>;
}
export const HISTORY_GIT_ATTRIBUTES = "**/*-history-v1-*.md -text";
/** Archives and their byte-preserving checkout rule must land in the same commit. */
export async function withHistoryAttributes(entries: readonly GuardedEntry[], read: (path: string) => Promise<string | null>): Promise<GuardedEntry[]> {
  if (!entries.some((entry) => entry.content !== null && isHistoryArchiveFileName(entry.path))) return [...entries];
  const path = "memory/.gitattributes";
  const queued = entries.find((entry) => entry.path === path);
  const old = (queued ? queued.content : await read(path)) ?? "";
  const significant = old.split(/\r?\n/).filter((line) => line.trim() && !line.trimStart().startsWith("#"));
  if (significant.at(-1) === HISTORY_GIT_ATTRIBUTES) return [...entries];
  return [...entries.filter((entry) => entry.path !== path), { path, content: old + (old && !old.endsWith("\n") ? "\n" : "") + HISTORY_GIT_ATTRIBUTES + "\n" }];
}
export function absentDocumentError(error: unknown): boolean {
  const e = error as { code?: string; status?: number; message?: string } | null;
  return e?.code === "ENOENT" || e?.status === 404 || /^(File not found|Directory not found)|\bENOENT\b/.test(e?.message ?? "");
}
export async function validateDocumentEntries(entries: readonly GuardedEntry[], read: (path: string) => Promise<string | null>, checks: DocumentWriteChecks = {}, queuedPath?: string): Promise<void> {
  const identities = new Map<string, GuardedEntry>();
  for (const entry of entries) {
    const key = entry.path.toLowerCase();
    const prior = identities.get(key);
    if (prior && (prior.content !== entry.content || prior.encoding !== entry.encoding)) throw new WriteRefusal("rewrite_conflict", `Conflicting Windows path aliases in one batch: ${prior.path}, ${entry.path}`);
    identities.set(key, entry);
  }
  const pending = new Map(entries.map((entry) => [entry.path, entry]));
  const readArchive = async (ref: string): Promise<string | null> => {
    if (!/^[^\\.][^\\]*$/.test(ref) || ref.split("/").some((p) => p === ".." || p === ".")) return null;
    const path = `memory/${ref}.md`;
    const entry = pending.get(path);
    if (entry?.encoding === "base64") return null;
    return entry ? entry.content : read(path);
  };
  for (const entry of entries) {
    if (queuedPath !== undefined && entry.path !== queuedPath) continue;
    if (!isAuthoredDocumentPath(entry.path)) continue;
    if (entry.encoding === "base64") throw new WriteRefusal("commit_failed", "Authored Markdown cannot bypass document checks through binary encoding");
    const before = await read(entry.path);
    const revision = before === null ? null : historyDigest(before);
    if (checks.bases?.has(entry.path) && checks.bases.get(entry.path) !== revision && before !== entry.content) {
      throw new WriteRefusal("rewrite_conflict", `${entry.path} changed after the fresh write basis; re-read and replan the batch`);
    }
    if (isHistoryArchiveFileName(entry.path)) {
      if (before === null && entry.path.split("/").at(-1) !== entry.path.split("/").at(-1)!.toLowerCase()) throw new WriteRefusal("commit_failed", "New history archives must use canonical lowercase filenames");
      if (entry.content === null || (before !== null && before !== entry.content)) throw new WriteRefusal("already_exists", `History archive ${entry.path} is immutable; a different payload must never replace it`);
      if (!parseHistoryArchive(entry.content)) throw new WriteRefusal("commit_failed", `Invalid history archive payload/hash: ${entry.path}`);
    }
    if (entry.content === null || before === entry.content) continue;
    let verifiedMaintenance = false;
    const proof = checks.maintenance?.get(entry.path);
    if (proof && before !== null && proof.sourceRevision === revision) {
      let next: string | null = proof.archiveHeadRef;
      let payload = "", part = 1, parts = 1;
      const directory = entry.path.slice("memory/".length, entry.path.lastIndexOf("/") + 1);
      do {
        if (!next?.startsWith(directory) || !isHistoryArchiveFileName(`${next}.md`)) break;
        const raw = await readArchive(next);
        const archive = raw === null ? null : parseHistoryArchive(raw);
        if (!archive || archive.metadata.kind !== "source-snapshot" || archive.metadata.source_revision !== revision ||
          archive.metadata.source !== entry.path.split("/").at(-1) || archive.metadata.part !== part ||
          archive.metadata.byte_start !== Buffer.byteLength(payload, "utf8") || (part > 1 && archive.metadata.parts !== parts)) break;
        parts = archive.metadata.parts;
        payload += archive.payload;
        next = archive.metadata.next;
        part++;
      } while (part <= parts && part <= 100_000);
      verifiedMaintenance = part === parts + 1 && payload === before;
    }
    if (proof && !verifiedMaintenance) throw new WriteRefusal("rewrite_conflict", `Maintenance for ${entry.path} requires a complete, byte-identical archive of its fresh source`);
    assertDocumentWrite(entry.path, entry.content, before, verifiedMaintenance);
  }
}
