/**
 * The question run's research/hypothesis pass (v0.19 §A.2.3-b).
 *
 * A3 HAS LANDED: this pass now runs as the QUESTION RUN — an independent
 * durable run (src/app/api/evolution/question-run.ts), triggered by the
 * user's "question" markers in a slice's agent.md mailbox. It is no longer
 * "the degraded form riding the housekeeping tail"; the one-function shape
 * stayed exactly because the lift was planned, and the pass still takes all
 * of its agenda from the markers (conservative: no marker, no run; the
 * markers ARE the agenda).
 *
 * Discipline (same structural shape as the case writer):
 * - writer-is-reader: the case manifest enters the prompt, and the pass gets
 *   READ tools (readCase / readSlice) for cross-record digging — it is a
 *   reader before it is a writer.
 * - evidence-while-writing: historical writes carry the trigger mechanically;
 *   current views accept only refs successfully read in the run-local scope.
 * - writes are validated intents applied through the case write ops (§B.3 —
 *   open / rewriteIndex / appendTail / addPiece / reviseUnderstanding) under
 *   the per-case lock. A hypothesis whose body
 *   carries no falsification condition is REFUSED (§B.6: 无证伪条件拒开) —
 *   the refusal is recorded, visible.
 *
 * Never throws: failures degrade to skipped items in the result.
 */
import { tool } from "@/lib/deepseek/tools";
import { z } from "zod";
import { runSubAgent } from "@/lib/agents/sub-agent-runner";
import { buildSubAgentSystem } from "@/lib/agents/prompts";
import { DOC_HOUSE_STYLE, DOC_LANGUAGE_RULE } from "@/lib/agents/doc-style";
import type { ModelConfig } from "@/lib/models/registry";
import {
  CASE_CATEGORIES,
  DOC_WRITE_WINDOW_RULE,
  MEMORY_IS_GIT_RULE,
  isValidCaseName,
  sanitizeCaseSegment,
  type CaseCategory,
} from "@/lib/docs";
import {
  fsWriteFile,
  type WriteBatch,
} from "@/lib/episodic/io-helpers";
import { readSlicePart, readSlicePartResolved } from "../paths";
import {
  RESEARCH_RECORD_PREFIX,
  applyCaseWriteIntent,
  applyCaseCurrentUnderstanding,
  createCaseReadScope,
  currentUnderstandingSchema,
  extractDocMarkers,
  extractProcessedMarkerIds,
  hasFalsificationCondition,
  makeCaseReadTool,
  makeCrossSliceReadTool,
  renderManifest,
  sliceExcerptNotice,
  type CaseWriterManifest,
  type DocMarker,
  type SliceExcerpt,
} from "./librarian";

// ─── The pass ──────────────────────────────────────────────────────────────

const writeOpSchema = z.object({
  action: z
    .enum(["open", "updateIndex", "appendTail", "addPiece", "reviseUnderstanding"])
    .describe(
      "open: a NEW case. updateIndex: rewrite an existing in-window index. " +
      "appendTail: ONE dated line that never reopens the settled body. addPiece: a dated piece. " +
      "reviseUnderstanding: change only _current.md (requires currentUnderstanding).",
    ),
  category: z.enum(CASE_CATEGORIES),
  caseName: z.string().describe("The case name — permanent at birth; legal per the red-line rule."),
  /** open/updateIndex/addPiece: the historical body (updateIndex = the WHOLE new body). */
  body: z.string().optional(),
  /** appendTail only. */
  line: z.string().optional(),
  /** addPiece only — the piece title. */
  title: z.string().optional(),
  currentUnderstanding: currentUnderstandingSchema.optional(),
  /** The exact current question marker id(s) this write answers. */
  questionIds: z
    .array(z.string())
    .optional()
    .describe(
      "Exact marker id(s) from the current question agenda that this write answers. " +
        "A shared write serving several questions must list every one of them. " +
        "Unknown or already-processed ids are rejected wholesale. " +
        "With exactly one question on the agenda it may be omitted (then inferred); " +
        "with several, omitting it means the write still lands globally but answers no question.",
    ),
});

const researchSchema = z.object({
  writes: z.array(writeOpSchema).max(10),
  reasoning: z.string().describe("1-2 sentences for the developer log."),
});

const RESEARCH_SYSTEM = buildSubAgentSystem(`You are the question-run researcher of a personal memory system (v0.19). The user asked questions a quick answer could not settle; you investigate ACROSS the record and leave durable CASES (research/ = answered questions, hypotheses/ = guesses with falsification conditions).

${MEMORY_IS_GIT_RULE}

You are shown: the triggering question markers, a compact slice excerpt, and the case manifest. Use readCase for full case history and readSlice for original semantic records. Slice reads accept ids, zero-based turn ranges, and bounded pages; follow every continuation cursor needed for the question. Every existing write target requires its own successful full readCase in this run — manifest membership and a claimed read are not receipts.

## Task

Per question, judge: is there enough in the record to write something durable?
- research: answer a question. Historical index.md text and dated pieces keep the record; update an in-window index or append once settled, and never reopen settled history through a tail.
- hypothesis: a guess WITH an explicit falsification condition — state it as 'falsify if: …' (证伪条件: …); without one the write is refused.
- current understanding: use reviseUnderstanding with currentUnderstanding { body, evidence }, or attach that field to another write. It changes only free-prose _current.md, archives the previous view as dated history, and works for any category without a trait template.

Writing nothing is a legal outcome — the record may simply be too thin. A question you did not write about stays for a later pass.

## Rules

1. Ground facts in evidence actually returned by readCase/readSlice. Label user report, direct observation, external verification, interpretation, counterevidence, and unknowns honestly; grounded competing explanations are welcome.
2. currentUnderstanding.evidence must contain only records/... or case refs actually read in this run. Do not invent evidence or verification.
3. ${DOC_LANGUAGE_RULE} Dates and mechanical evidence stamps on historical writes are not your bookkeeping; cite current-view evidence explicitly.
4. ${DOC_WRITE_WINDOW_RULE} Tail supplements and current-view revisions never reopen a settled index.
5. Scope honesty: if the question was already answered by an existing case, say so in reasoning and write nothing.
6. Every write names the question(s) it answers via \`questionIds\` — the exact marker ids shown above. A shared write serving several questions must list every one of them; unknown or already-processed ids are rejected wholesale, so never invent or reuse an old id. With exactly one question on the agenda you may omit \`questionIds\` (it is inferred); with several, omitting it means the write still lands in the case tree but is credited to no question.

## Output

Call \`docResearchOutput\` with your writes (or empty) + reasoning.

${DOC_HOUSE_STYLE}`);

export interface DocResearchPassInput {
  model: ModelConfig;
  /** The slice whose agent.md carries the question markers. */
  sliceId: string;
  excerpt: SliceExcerpt;
  /** The survey manifest — what cases exist before the pass starts.
   *  Optional at the seam: absent → empty tree (readCase becomes the only
   *  discovery surface — degraded but functional). */
  manifest?: CaseWriterManifest;
  /** User-local date (YYYY-MM-DD) stamping every write. */
  date: string;
  batch?: WriteBatch;
  /** @deprecated R3a: strands are dead. Ignored. */
  strands?: unknown;
}

export interface DocResearchQuestionProduct {
  markerId: string;
  caseRef: string;       // `${category}/${caseName}`
  productRef: string;    // applied.path with leading `memory/` removed
  outcome: "written" | "existing";
}

export interface DocResearchPassResult {
  ran: boolean;
  written: string[];
  skipped: Array<{ id: string; reason: string }>;
  /** Per-question accepted products — the basis for the processed records. */
  productsByQuestion: DocResearchQuestionProduct[];
}

/**
 * The question research/hypothesis pass — ONE function, question-driven.
 * Picks up unprocessed "question" markers from the slice's agent.md,
 * investigates with readCase/readSlice, and writes research/ hypotheses/
 * cases through the case write ops under the per-case lock. Never throws.
 */
export async function runDocResearchPass(
  input: DocResearchPassInput,
): Promise<DocResearchPassResult> {
  const { model, sliceId, excerpt, date, batch } = input;
  const manifest = input.manifest ?? { truncated: false, tree: {} };
  const skipped: Array<{ id: string; reason: string }> = [];
  const scope = createCaseReadScope();

  let agentMd: string;
  try {
    // Dual-root read (v0.19 R2): the mailbox of a slice created before the
    // root move lives under the legacy slices root.
    agentMd = await readSlicePart(sliceId, "agent", batch);
  } catch {
    return { ran: false, written: [], skipped, productsByQuestion: [] };
  }

  const processed = extractProcessedMarkerIds(agentMd, RESEARCH_RECORD_PREFIX);
  const questions = extractDocMarkers(agentMd).filter(
    (m) => m.kind === "question" && !processed.has(m.id),
  );
  if (questions.length === 0) return { ran: false, written: [], skipped, productsByQuestion: [] };

  const questionBlocks = (questions as DocMarker[])
    .map(
      (q) =>
        `### marker ${q.id}\ntitle: ${q.title}\nnote: ${q.note || "(none)"}`,
    )
    .join("\n\n");

  const prompt = `## Triggering slice ${sliceId}

focus: ${excerpt.focus || "(none)"}
summary: ${excerpt.summary || "(none)"}

${sliceExcerptNotice(excerpt)}

${excerpt.turnsExcerpt || "(no conversation excerpt)"}

## The user's questions (the pass's whole agenda — conservative: research nothing beyond them)

${questionBlocks}

## Case manifest (discovery paths only, never read receipts)

${renderManifest(manifest.tree)}
${manifest.truncated ? "\n(the manifest may be truncated — a missing case shows as a readCase dead link)\n" : ""}
Gather evidence with readCase / readSlice, then report the writes as instructed.`;

  const tools = {
    readCase: makeCaseReadTool(batch, scope),
    readSlice: makeCrossSliceReadTool({ batch, scope }),
    docResearchOutput: tool({
      description: "Report the research/hypothesis writes (or empty) + reasoning.",
      inputSchema: researchSchema,
    }),
  };

  const result = await runSubAgent({
    role: "recall",
    model,
    system: RESEARCH_SYSTEM,
    prompt,
    maxSteps: 15,
    tools,
    toolChoice: "auto",
    reportToolName: "docResearchOutput",
    reportSchema: researchSchema,
    progress: { toolName: "doc-research" },
  });
  if (!result.ok || !result.report) {
    return {
      ran: true,
      written: [],
      skipped: [...skipped, { id: "*", reason: result.error ?? "no research report" }],
      productsByQuestion: [],
    };
  }

  const written: string[] = [];
  const products = new Map<string, DocResearchQuestionProduct>();
  const currentIds = new Set(questions.map((q) => q.id));

  const recordProduct = (
    markerIds: string[],
    caseRef: string,
    applied: { path: string; noop?: boolean },
  ): void => {
    const productRef = applied.path.replace(/^memory\//, "");
    if (!applied.noop && !written.includes(productRef)) written.push(productRef);
    for (const markerId of markerIds) {
      const key = JSON.stringify([markerId, productRef]);
      const previous = products.get(key);
      products.set(key, {
        markerId,
        caseRef,
        productRef,
        outcome: previous?.outcome === "written" || !applied.noop
          ? "written"
          : "existing",
      });
    }
  };

  for (const op of result.report.writes) {
    // Resolve the question mapping BEFORE any write: an explicit list that
    // carries an unknown / not-current id refuses the whole intent — no file,
    // no product, no processed record. Absent ids infer the marker only when
    // exactly one question is current; with several, no guessing.
    let mappedIds: string[] = [];
    if (op.questionIds) {
      const unknown = op.questionIds.filter((id) => !currentIds.has(id));
      if (unknown.length > 0) {
        skipped.push({
          id: "?",
          reason: `unknown or not-current questionIds: ${JSON.stringify(unknown)}`,
        });
        continue;
      }
      mappedIds = [...new Set(op.questionIds)];
    } else if (questions.length === 1) {
      mappedIds = [questions[0].id];
    }
    const caseName = sanitizeCaseSegment(op.caseName);
    const identity = `${op.category}/${caseName}`;
    if (!caseName || !isValidCaseName(caseName)) {
      skipped.push({ id: "?", reason: `illegal case name: ${JSON.stringify(op.caseName)}` });
      continue;
    }
    // research questions land in research/; hypotheses in hypotheses/. The
    // writer names the category; engineering only enforces the red lines.
    const category: CaseCategory = op.category;
    if ((category !== "research" && category !== "hypotheses") && op.action === "open") {
      // Opening arbitrary categories from the question run is allowed by the
      // type table (§B.6: 问题 run writes research/hypotheses) — refuse the rest.
      skipped.push({ id: "?", reason: `question run may only open research/ or hypotheses/ cases, not ${category}/` });
      continue;
    }
    // A hypothesis without a falsification condition is not a hypothesis.
    if (
      category === "hypotheses" &&
      op.action === "open" &&
      !hasFalsificationCondition(op.body ?? "")
    ) {
      skipped.push({ id: "?", reason: `hypothesis ${identity} lacks a falsification condition` });
      continue;
    }

    try {
      let applied: { path: string; noop?: boolean } | null = null;
      switch (op.action) {
        case "open": {
          if (!op.body?.trim()) throw new Error("open requires a body");
          applied = await applyCaseWriteIntent(
            { action: "open", category, caseName, body: `${op.body.trim()}\n\n(refs: ${sliceId})` },
            date, batch, scope,
          );
          break;
        }
        case "updateIndex": {
          if (!op.body?.trim()) throw new Error("updateIndex requires a body");
          applied = await applyCaseWriteIntent(
            { action: "rewriteIndex", category, caseName, body: `${op.body.trim()}\n\n(refs: ${sliceId})` },
            date, batch, scope,
          );
          break;
        }
        case "appendTail": {
          if (!op.line?.trim()) throw new Error("appendTail requires a line");
          applied = await applyCaseWriteIntent(
            { action: "appendTail", category, caseName, line: `${op.line.trim()} (refs: ${sliceId})` },
            date, batch, scope,
          );
          break;
        }
        case "addPiece": {
          if (!op.title?.trim() || !op.body?.trim()) {
            throw new Error("addPiece requires a title and a body");
          }
          applied = await applyCaseWriteIntent(
            { action: "addPiece", category, caseName, title: sanitizeCaseSegment(op.title), body: `${op.body.trim()}\n\n(refs: ${sliceId})` },
            date, batch, scope,
          );
          break;
        }
        case "reviseUnderstanding": {
          if (!op.currentUnderstanding) {
            throw new Error("reviseUnderstanding requires currentUnderstanding { body, evidence }");
          }
          break;
        }
      }
      if (applied) recordProduct(mappedIds, identity, applied);
    } catch (e) {
      skipped.push({ id: "?", reason: e instanceof Error ? e.message : String(e) });
      continue;
    }
    if (op.currentUnderstanding) {
      try {
        const applied = await applyCaseCurrentUnderstanding({
          category,
          caseName,
          current: op.currentUnderstanding,
          date,
          batch,
          scope,
          refreshRead: op.action !== "reviseUnderstanding",
        });
        recordProduct(mappedIds, identity, applied);
      } catch (e) {
        skipped.push({ id: `${identity}/_current.md`, reason: e instanceof Error ? e.message : String(e) });
      }
    }
  }

  // A processed marker needs an accepted product mapped to THAT question.
  // Refused, unanswered, and multi-question unmapped writes stay actionable.
  const productsByQuestion = [...products.values()];
  if (productsByQuestion.length > 0) {
    try {
      // Dual-root read (the slice may predate the root move), and the record
      // append goes back to the root the mailbox was actually read from —
      // splitting markers (legacy) from records (new) would re-see every
      // question on the next pass.
      const resolved = await readSlicePartResolved(sliceId, "agent", batch);
      if (!resolved) throw new Error("Question mailbox could not be read back");
      const fresh = resolved.content;
      const alreadyProcessed = extractProcessedMarkerIds(fresh, RESEARCH_RECORD_PREFIX);
      const recordLines = questions.flatMap((question) => {
        if (alreadyProcessed.has(question.id)) return [];
        const docs = productsByQuestion
          .filter((product) => product.markerId === question.id)
          .map((product) => product.productRef);
        return docs.length > 0
          ? [`${RESEARCH_RECORD_PREFIX} ${JSON.stringify({ id: question.id, docs })}`]
          : [];
      });
      if (recordLines.length === 0) return { ran: true, written, skipped, productsByQuestion };
      const next = fresh.trimEnd()
        ? `${fresh.trimEnd()}\n\n${recordLines.join("\n")}\n`
        : `${recordLines.join("\n")}\n`;
      await fsWriteFile(resolved.path, next, batch);
    } catch {
      // record loss → a question may be re-seen; the case tail is append-only,
      // keeping that a duplicate dated line: visible, non-fatal.
    }
  }

  return { ran: true, written, skipped, productsByQuestion };
}
