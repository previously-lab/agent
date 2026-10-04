/**
 * Memory-quality signal instrumentation (design v0.15 §4.4).
 *
 * The recall colleague is retired: the `recall_verify` / `recall_rework`
 * producers (v1.0 §2.6) are gone with it. Historical fitness data may still
 * contain those values — every READER must tolerate them (the analyzer treats
 * them as legacy noise, parsing never crashes on them).
 *
 * What this module still produces:
 *
 *   - "doc_rework" — the document-side probe (§4.4): the main agent reads a
 *     document with readDoc, then opens with readSlice one of the slices THAT
 *     document referenced: the document was not credited for the fact it
 *     carried. This is the implicit memory-quality demerit now. It lands in
 *     the fitness store's recall BUCKET (the bucket is "memory quality" in
 *     meaning — the mechanism serves memory no matter which producer
 *     emitted); the analyzer decides what the ratio means, including §7's
 *     adjudication of whole mechanisms.
 *   - "interaction_regenerate" / "interaction_interrupt" — the user's own
 *     hands on the UI (regenerate = the previous reply was rejected;
 *     interrupt = cut off mid-stream).
 *
 * The per-conversation record is module-level per-process state — the same
 * pattern manager.ts already uses for the active slice. Workflow steps in one
 * process share the module, so the doc read recorded by readDocExecute is
 * visible to a later readSliceExecute. The map is FIFO-bounded:
 * conversations are short-lived and an unbounded map would leak across the
 * process lifetime.
 *
 * Every emitted signal lands in TWO places, both best-effort (failures are
 * swallowed with a console.warn — instrumentation must never fail a tool):
 *   1. the fitness store (machine-readable, for the analyzer stage), and
 *   2. one compact structured line in the CURRENT slice's agent.md
 *      (human/audit-readable), via manager.ts's writeAgentTimeline.
 */

import { appendSignal } from "@/lib/evolution/store";
import type { WriteBatch } from "@/lib/episodic/io-helpers";
import { writeAgentTimeline } from "./manager";

/**
 * The documents the main agent opened this conversation, each with the slice
 * ids its text references (extracted by the readDoc executor via docs-query's
 * extractSliceIds). When a later readSlice opens one of THOSE slices, the
 * document was not credited for the fact it carried.
 */
const docReads = new Map<string, Map<string, Set<string>>>();

/** Bound per conversation — instrumentation state, not memory. */
const MAX_TRACKED_DOCS_PER_CONVERSATION = 50;

/**
 * Record a document the main agent read this conversation, with the slice
 * ids the document's text references. Later readSlice calls are classified
 * against this record by checkDocRework. FIFO-bounded.
 */
export function recordDocRead(
  conversationSliceId: string,
  docFileName: string,
  referencedSliceIds: string[],
): void {
  if (!conversationSliceId || !docFileName) return;
  let docs = docReads.get(conversationSliceId);
  if (!docs) {
    docs = new Map();
    docReads.set(conversationSliceId, docs);
  }
  docs.delete(docFileName);
  docs.set(docFileName, new Set(referencedSliceIds));
  while (docs.size > MAX_TRACKED_DOCS_PER_CONVERSATION) {
    const oldest = docs.keys().next().value;
    if (oldest === undefined) break;
    docs.delete(oldest);
  }
}

/**
 * Classify a main-agent readSlice against the documents read earlier in this
 * conversation: if the opened slice is one a read document pointed at, the
 * document was not credited for that fact. Returns the document's file name
 * (the identity of the demerit's target), or null when no read document
 * referenced this slice. Pure read of the module record — the side-effecting
 * counterpart is logDocReworkSignal.
 */
export function checkDocRework(
  conversationSliceId: string,
  readSliceId: string,
): string | null {
  const docs = docReads.get(conversationSliceId);
  if (!docs) return null;
  if (readSliceId === conversationSliceId) return null;
  for (const [fileName, sliceIds] of docs) {
    if (sliceIds.has(readSliceId)) return fileName;
  }
  return null;
}

/**
 * Emit a doc_rework signal: the machine-readable fitness store entry plus
 * one compact audit line in the current slice's agent.md. BOTH writes are
 * best-effort — each failure is warned and swallowed; this function never
 * throws and never fails the calling tool.
 */
export async function logDocReworkSignal(
  conversationSliceId: string,
  readSliceId: string,
  docFileName: string,
): Promise<void> {
  const ts = new Date().toISOString();
  const detail =
    `main agent read slice ${readSliceId} that document ` +
    `"${docFileName}" references — the document was not credited ` +
    "for the fact it carried";

  try {
    await appendSignal({
      ts,
      sliceId: conversationSliceId,
      type: "doc_rework",
      detail,
    });
  } catch (e) {
    console.warn(
      "[ReworkSignal] fitness-store write failed:",
      e instanceof Error ? e.message : e,
    );
  }

  try {
    await writeAgentTimeline(
      conversationSliceId,
      `- **doc_rework** ${ts} — ${detail}.`,
    );
  } catch (e) {
    console.warn(
      "[ReworkSignal] agent.md append failed:",
      e instanceof Error ? e.message : e,
    );
  }
}

/** Interaction-signal types — the user's own hands on the UI (design §2.6
 *  extended): regenerate = the previous reply was rejected; interrupt = the
 *  reply was cut off mid-stream. Both are dissatisfaction candidates for the
 *  interaction bucket; the analyzer decides, these only record the fact. */
export type InteractionSignalType =
  | "interaction_regenerate"
  | "interaction_interrupt";

/**
 * Emit an interaction signal (regenerate / interrupt): the machine-readable
 * fitness store entry plus one compact audit line in the slice's agent.md.
 * Same double-write, never-throws discipline as logDocReworkSignal.
 */
export async function logInteractionSignal(
  type: InteractionSignalType,
  sliceId: string,
  detail: string,
  batch?: WriteBatch,
): Promise<void> {
  if (!sliceId) return;
  const ts = new Date().toISOString();

  try {
    await appendSignal({ ts, sliceId, type, detail }, batch);
  } catch (e) {
    console.warn(
      "[InteractionSignal] fitness-store write failed:",
      e instanceof Error ? e.message : e,
    );
  }

  try {
    await writeAgentTimeline(sliceId, `- **${type}** ${ts} — ${detail}.`);
  } catch (e) {
    console.warn(
      "[InteractionSignal] agent.md append failed:",
      e instanceof Error ? e.message : e,
    );
  }
}
