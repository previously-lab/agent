/**
 * Memory-quality signal instrumentation (design v0.15 §4.4, trimmed in v0.19
 * R4/R5).
 *
 * The recall colleague is retired: the `recall_verify` / `recall_rework`
 * producers (v1.0 §2.6) are gone with it.
 *
 * What this module still produces:
 *
 *   - "doc_rework" — the document-side probe (§4.4): the main agent reads a
 *     document with readDoc, then opens with readSlice one of the slices THAT
 *     document referenced: the document was not credited for the fact it
 *     carried.
 *   - "interaction_regenerate" / "interaction_interrupt" — the user's own
 *     hands on the UI (regenerate = the previous reply was rejected;
 *     interrupt = cut off mid-stream).
 *
 * v0.19 R4/R5: the fitness store is RETIRED (design v0.19 §C.2 — selection
 * pressure is prose self-assessment under self/ now), so signals no longer
 * land in any machine-readable store. Each signal is one compact structured
 * line in the CURRENT slice's agent.md (human/audit-readable, via manager.ts's
 * writeAgentTimeline) plus a server-log line for run-log reconciliation
 * (§D.4 附 3: the fitness instruments' home is the run log, not disk state).
 *
 * The per-conversation record is module-level per-process state — the same
 * pattern manager.ts already uses for the active slice. Workflow steps in one
 * process share the module, so the doc read recorded by readDocExecute is
 * visible to a later readSliceExecute. The map is FIFO-bounded:
 * conversations are short-lived and an unbounded map would leak across the
 * process lifetime.
 *
 * Every write is best-effort (failures are swallowed with a console.warn —
 * instrumentation must never fail a tool).
 */

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
 * Emit a doc_rework signal: one compact audit line in the current slice's
 * agent.md plus a server-log line. Best-effort — each failure is warned and
 * swallowed; this function never throws and never fails the calling tool.
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

  console.log(`[ReworkSignal] doc_rework ${conversationSliceId} — ${detail}`);

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

/** Interaction-signal types — the user's own hands on the UI: regenerate =
 *  the previous reply was rejected; interrupt = the reply was cut off
 *  mid-stream. */
export type InteractionSignalType =
  | "interaction_regenerate"
  | "interaction_interrupt";

/**
 * Emit an interaction signal (regenerate / interrupt): one compact audit
 * line in the slice's agent.md plus a server-log line. Same never-throws
 * discipline as logDocReworkSignal.
 */
export async function logInteractionSignal(
  type: InteractionSignalType,
  sliceId: string,
  detail: string,
  batch?: WriteBatch,
): Promise<void> {
  if (!sliceId) return;
  const ts = new Date().toISOString();
  void batch; // the fitness-store write this batch fed is retired

  console.log(`[InteractionSignal] ${type} ${sliceId} — ${detail}`);

  try {
    await writeAgentTimeline(sliceId, `- **${type}** ${ts} — ${detail}.`);
  } catch (e) {
    console.warn(
      "[InteractionSignal] agent.md append failed:",
      e instanceof Error ? e.message : e,
    );
  }
}
