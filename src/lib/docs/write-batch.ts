import type { WriteBatch } from "@/lib/episodic/io-helpers";
import { WriteRefusal } from "./write-window";
const origins = new WeakMap<WriteBatch, WriteBatch>();
export function assertBatchOpen(batch: WriteBatch): void {
  if (batch.state && batch.state !== "open") throw new WriteRefusal("commit_failed", `Batch is ${batch.state}; create a new batch and re-read`);
}
export function forkWriteBatch(parent?: WriteBatch): WriteBatch {
  if (parent) assertBatchOpen(parent);
  const copy = (): WriteBatch => ({ entries: new Map(parent?.entries), encodings: new Map(parent?.encodings),
    baseHeadSha: parent?.baseHeadSha, documentBases: new Map(parent?.documentBases), maintenance: new Map(parent?.maintenance) });
  const fork = copy(); origins.set(fork, copy()); return fork;
}
/** Merge only this operation's delta, after checking every changed key. Unrelated writes survive. */
export function mergeWriteBatch(target: WriteBatch, source: WriteBatch): void {
  assertBatchOpen(target);
  const origin = origins.get(source);
  if (!origin) throw new Error("A write operation must be forked before merging");
  const changed = [...source.entries].filter(([path, value]) => value !== origin.entries.get(path) || source.encodings?.get(path) !== origin.encodings?.get(path));
  if (target.baseHeadSha && source.baseHeadSha && target.baseHeadSha !== source.baseHeadSha) throw new WriteRefusal("rewrite_conflict", "Batch HEAD changed while drafting");
  for (const [path, value] of changed) {
    if (target.entries.get(path) !== origin.entries.get(path) && target.entries.get(path) !== value) throw new WriteRefusal("rewrite_conflict", `Pending ${path} changed while drafting; re-read it`);
    if (target.documentBases?.has(path) && source.documentBases?.has(path) && target.documentBases.get(path) !== source.documentBases.get(path)) throw new WriteRefusal("rewrite_conflict", `Write basis changed for ${path}`);
  }
  target.baseHeadSha ??= source.baseHeadSha;
  target.documentBases ??= new Map(); target.maintenance ??= new Map();
  target.encodings ??= new Map();
  for (const [path, value] of changed) {
    target.entries.set(path, value);
    const encoding = source.encodings?.get(path);
    if (encoding) target.encodings?.set(path, encoding); else target.encodings?.delete(path);
    if (source.documentBases?.has(path)) target.documentBases.set(path, source.documentBases.get(path)!);
    if (source.maintenance?.has(path)) target.maintenance.set(path, source.maintenance.get(path)!);
  }
}
