/**
 * Background-stream step functions (v0.19 §A.2.3, v0.21 §5) — full Node.js,
 * retried automatically on failure. Kept in a SEPARATE module from the
 * workflow entry (`question-run.ts`) so its Node-dependent imports never
 * enter the deterministic workflow sandbox — the same split as chat's
 * turn-workflow.ts / steps.ts.
 *
 * v0.21 P4 retired the boundary run, and v0.30 retired the field's dispatch
 * with it: the reflection unit is woken by the mechanical bell
 * (reflection-wake.ts → reflection-run.ts) and reads the record itself,
 * and closing a slice no longer starts any background run. What remains here
 * is the
 * conversation's question
 * sub-stream body; the capabilities the HQ agent's tools reuse live in lib/
 * (the writer passes) and hq-context.ts (buildRunManifest /
 * buildRunCardReaders / backgroundModel).
 *
 * HQ stores RESULTS ONLY (v0.21 §5): an idle round writes nothing — there is
 * no run ledger anymore (the old self/evolution reflection line, written on
 * every pass and doubled as the mechanical re-run dedup, is gone). Dedup is
 * entirely writer-is-reader: a re-run reads the current case state and goes
 * idle when it already reflects the slice. A substantive veto leaves its
 * REASON as prose in self/ or the relevant case body.
 *
 *   questionRun — the conversation's sub-stream for user-requested long
 *     work (v0.21 §2): the doc-research pass investigates and writes
 *     research/ hypotheses/ cases; when anything landed, a tasks/
 *     completion notice is what the NEXT turn's reply segment reads and
 *     states. The runs have no mouth — products land in cases.
 */
import { loadSlice, readSlicePart } from "@/lib/episodic";
import {
  buildSliceExcerpt,
  extractDocMarkers,
  extractProcessedMarkerIds,
  RESEARCH_RECORD_PREFIX,
} from "@/lib/episodic/flash/librarian";
import { runDocResearchPass } from "@/lib/episodic/flash/doc-research";
import { createBatch, flushBatch } from "@/lib/episodic/io-helpers";
import { withTaskLedgerBatch } from "@/lib/tasks/store";
import { isValidTaskRef, taskRefForCase } from "@/lib/tasks/contracts";
import { isValidCaseName, sanitizeCaseSegment } from "@/lib/docs/case-naming";
import { stableTaskOperationId } from "@/lib/chat/task-identity";
// A step module may export ONLY step functions — the run-shared helpers
// therefore live in their own module (see hq-context.ts for the rule).
import { backgroundModel, buildRunManifest } from "./hq-context";

// ─── Shared input shapes (serializable — they cross the run boundary) ──────

export interface QuestionRunInput {
  /** The slice whose agent.md mailbox carries the question markers. */
  sliceId: string;
  /** User-local date (YYYY-MM-DD). */
  date: string;
}

// ─── The question run (§A.2.3-b) ───────────────────────────────────────────

export interface QuestionRunOutcome {
  ran: boolean;
  /** Persisted research paths, reported only after the batch flush succeeds. */
  written: string[];
  /** Stable slice+marker result events committed in the same batch. */
  resultIds?: string[];
}

export async function executeQuestionRun(
  input: QuestionRunInput,
): Promise<QuestionRunOutcome> {
  "use step";
  const { sliceId, date } = input;
  const idle: QuestionRunOutcome = { ran: false, written: [] };

  const slice = await loadSlice(sliceId).catch(() => null);
  if (!slice) {
    console.warn(`[QuestionRun] ${sliceId} unreadable — nothing to research`);
    return idle;
  }
  const model = backgroundModel();
  if (!model) {
    console.warn("[QuestionRun] no default model configured — idle");
    return idle;
  }

  // The pass scans/dedups/records markers internally; we scan here only to
  // know WHICH questions are on the agenda (the notification names them).
  // Dual-root read — the slice's mailbox may predate the records root move.
  const agentMd = await readSlicePart(sliceId, "agent").catch(() => "");
  const processed = extractProcessedMarkerIds(agentMd, RESEARCH_RECORD_PREFIX);
  const questions = extractDocMarkers(agentMd).filter(
    (m) => m.kind === "question" && !processed.has(m.id),
  );
  if (questions.length === 0) {
    console.log(`[QuestionRun] ${sliceId} carries no unanswered questions — idle`);
    return idle;
  }

  // ONE batch for the whole run: the research pass's case writes, the
  // mailbox record lines, and the completion notice all land as a SINGLE
  // commit (`Question run — {sliceId}`); an idle run never reaches here. The
  // batch is a per-call object — never module-global — and the same
  // threading works unchanged on the local backend.
  const batch = createBatch();

  const result = await runDocResearchPass({
    model,
    sliceId,
    excerpt: buildSliceExcerpt(slice),
    manifest: await buildRunManifest(),
    date,
    batch,
  });
  console.log(
    `[QuestionRun] research: ${result.written.length} written, ${result.skipped.length} skipped`,
  );
  if (!result.ran) return { ran: false, written: [] };

  const agenda = questions.flatMap((question) => {
    const products = result.productsByQuestion.filter((product) => product.markerId === question.id);
    if (products.length === 0) return [];
    const derived = sanitizeCaseSegment(question.title);
    const caseName = isValidCaseName(derived) ? derived : `问题-${derived}`;
    const taskRef = question.target && isValidTaskRef(question.target)
      ? question.target
      : taskRefForCase(caseName);
    return [{ question, taskRef, products }];
  });
  if (agenda.length === 0) {
    // Unmapped durable writing may still be useful, but it completes no
    // particular question and must never create a guessed result event.
    await flushBatch(batch, `Question run — ${sliceId}`);
    return { ran: true, written: result.written };
  }
  const now = new Date().toISOString();
  const resultIds = await withTaskLedgerBatch(batch, async (mutate) => {
    await mutate({
      type: "reconcile_legacy",
      operationId: stableTaskOperationId("question:reconcile", [sliceId, ...questions.map((q) => q.id)]),
      now,
      entries: agenda.map(({ question, taskRef }) => ({ ref: taskRef, summary: question.title })),
    });
    const ids: string[] = [];
    for (const { question, taskRef, products } of agenda) {
      const id = stableTaskOperationId("question-result", [sliceId, question.id]);
      await mutate({
        type: "record_result",
        operationId: stableTaskOperationId("question:record", [sliceId, question.id]),
        now,
        result: {
          id,
          taskRef,
          evidence: {
            producerRunId: `executeQuestionRun:${sliceId}:${question.id}`,
            statement: `查了：${question.title} —— 结果见 ${[...new Set(products.map((product) => product.productRef))].join("、")}。`,
          },
        },
      });
      ids.push(id);
    }
    // The local lock must protect the full read/modify/commit, too. A
    // conflict rejects for a fresh whole-run retry; never rebase old JSON.
    await flushBatch(batch, `Question run — ${sliceId}`);
    return ids;
  });

  console.log(`[QuestionRun] committed ${resultIds.length} result event(s)`);
  return { ran: true, written: result.written, resultIds };
}
