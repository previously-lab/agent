/**
 * Background-stream step functions (v0.19 §A.2.3, v0.21 §5) — full Node.js,
 * retried automatically on failure. Kept in a SEPARATE module from the
 * workflow entry (`question-run.ts`) so its Node-dependent imports never
 * enter the deterministic workflow sandbox — the same split as chat's
 * turn-workflow.ts / steps.ts.
 *
 * v0.21 P4: the boundary run is RETIRED — HQ's only trigger is the field's
 * report (reportToHQ → hq-run.ts), and closing a slice no longer starts any
 * background run. What remains here is the conversation's question
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

  const result = await runDocResearchPass({
    model,
    sliceId,
    excerpt: buildSliceExcerpt(slice),
    manifest: await buildRunManifest(),
    date,
  });
  console.log(
    `[QuestionRun] research: ${result.written.length} written, ${result.skipped.length} skipped`,
  );
  if (!result.ran || result.written.length === 0) {
    return { ran: result.ran, written: result.written };
  }

  // §A.3.3 notification: the payload is a REAL task case whose closed/tail
  // closing line is the completion credential; the statement is declarative
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
          "后台流的完成通知册——每当问题 run 的研究落地，结案行进尾部；" +
          "下一回合的回复段读到当天的尾部行后向用户陈述。",
      },
      date,
    );
  } catch {
    // already exists — the notice goes to the tail below either way
  }
  try {
    const applied = await applyCaseWriteIntent(
      {
        action: "close",
        category: NOTICE_CASE.category,
        caseName: NOTICE_CASE.caseName,
        note: statement,
      },
      date,
    );
    noticePath = applied.path;
  } catch {
    try {
      const applied = await applyCaseWriteIntent(
        {
          action: "appendTail",
          category: NOTICE_CASE.category,
          caseName: NOTICE_CASE.caseName,
          line: statement,
        },
        date,
      );
      noticePath = applied.path;
    } catch (e) {
      console.warn(
        "[QuestionRun] completion notice failed:",
        e instanceof Error ? e.message : e,
      );
    }
  }
  if (noticePath) {
    console.log(`[QuestionRun] completion notice → ${noticePath}`);
  }
  return { ran: true, written: result.written, ...(noticePath ? { noticePath } : {}) };
}
