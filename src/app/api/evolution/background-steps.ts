/**
 * Background-stream step functions (v0.19 §A.2.3, v0.21 §5) — full Node.js,
 * retried automatically on failure. Kept in a SEPARATE module from the
 * workflow entry (`question-run.ts`) so its Node-dependent imports never
 * enter the deterministic workflow sandbox — the same split as chat's
 * turn-workflow.ts / steps.ts.
 *
 * v0.21 P4 retired the boundary run, and v0.30 retired the field's dispatch
 * with it: the reflection unit is woken by the mechanical bell
 * (reflection-wake.ts → hq-run.ts) and reads the record itself, and closing
 * a slice no longer starts any background run. What remains here is the
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
  applyCaseWriteIntent,
  extractDocMarkers,
  extractProcessedMarkerIds,
  RESEARCH_RECORD_PREFIX,
} from "@/lib/episodic/flash/librarian";
import { runDocResearchPass } from "@/lib/episodic/flash/doc-research";
import { createBatch, flushBatch } from "@/lib/episodic/io-helpers";
import { isRefConflictError } from "@/lib/tools/batch-write";
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

/** The standing notification case: background findings to tell the user. */
const NOTICE_CASE = { category: "tasks", caseName: "后台回复" } as const;

export interface QuestionRunOutcome {
  ran: boolean;
  written: string[];
  /** The tasks/ case path carrying the completion statement, when posted. */
  noticePath?: string;
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
  if (!result.ran || result.written.length === 0) {
    return { ran: result.ran, written: result.written };
  }

  // §A.3.3 notification: the payload is a REAL task case whose dated tail
  // lines are the completion credential; the statement is declarative
  // only (a mechanical template — no promises are structurally possible).
  // The next turn's reply segment picks up today's tail lines and states them.
  const statement =
    `查了：${questions.map((q) => q.title).join("；")} —— ` +
    `结果已写入 ${result.written.join("、")}。`;
  let noticePath: string | undefined;
  try {
    await applyCaseWriteIntent(
      {
        action: "open",
        category: NOTICE_CASE.category,
        caseName: NOTICE_CASE.caseName,
        body:
          "问题 run 是这场对话的子流；这是它的完成通知册——每当问题 run 的研究落地，" +
          "结案行进尾部；下一回合的回复段读到当天的尾部行后向用户陈述。",
      },
      date,
      batch,
    );
  } catch {
    // already exists — the notice goes to the tail below either way
  }
  try {
    const applied = await applyCaseWriteIntent(
      {
        action: "appendTail",
        category: NOTICE_CASE.category,
        caseName: NOTICE_CASE.caseName,
        line: statement,
      },
      date,
      batch,
    );
    noticePath = applied.path;
  } catch (e) {
    console.warn(
      "[QuestionRun] completion notice failed:",
      e instanceof Error ? e.message : e,
    );
  }
  // The run's ONE commit. A bounded PLAIN retry covers a ref that moved
  // under us: commitBatchToGitHub re-reads HEAD per attempt, so a retry
  // rebases our tree onto the moved ref. The run writes only case/mailbox
  // files — never the live slice's core.md — so no merge-on-conflict is
  // needed (the R6 reasoning lives in hq-agent.ts). A lost flush costs the
  // run's writes, never the run.
  let flushAttempts = 0;
  for (;;) {
    try {
      await flushBatch(batch, `Question run — ${sliceId}`);
      break;
    } catch (err) {
      if (!isRefConflictError(err) || flushAttempts >= 2) {
        console.warn(
          "[QuestionRun] flush failed (queued writes lost):",
          err instanceof Error ? err.message : err,
        );
        break;
      }
      flushAttempts += 1;
      console.warn(
        `[QuestionRun] flush conflict — rebasing onto the moved ref (retry ${flushAttempts}/2):`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  if (noticePath) {
    console.log(`[QuestionRun] completion notice → ${noticePath}`);
  }
  return { ran: true, written: result.written, ...(noticePath ? { noticePath } : {}) };
}
