/**
 * The question run's research/hypothesis pass (v0.19 §A.2.3-b; was the
 * degraded v0.15 boundary pass).
 *
 * THE DEGRADED FORM, ON PURPOSE: the design's real question run is an
 * independent durable run — the lift is another lane's job (A3). What this
 * module implements until then is the same shape riding the housekeeping
 * tail: driven ONLY by the user's "question" markers (no automatic research,
 * no scheduled re-thinking: no marker, no pass). The agenda stays
 * conservative — the markers ARE the agenda.
 *
 * Discipline (same structural shape as the case writer):
 * - writer-is-reader: the case manifest enters the prompt, and the pass gets
 *   READ tools (readCase / readSlice) for cross-record digging — it is a
 *   reader before it is a writer.
 * - evidence-while-writing: the triggering slice id is stamped mechanically.
 * - writes are validated intents applied through the five case ops (§B.3)
 *   under the per-case lock. A hypothesis whose body carries no falsification
 *   condition is REFUSED (§B.6: 无证伪条件拒开) — the refusal is recorded,
 *   visible.
 *
 * Never throws: failures degrade to skipped items in the result.
 */
import { tool } from "ai";
import { z } from "zod";
import { runSubAgent } from "@/lib/agents/sub-agent-runner";
import { buildSubAgentSystem } from "@/lib/agents/prompts";
import type { ModelConfig } from "@/lib/models/registry";
import {
  CASE_CATEGORIES,
  isValidCaseName,
  type CaseCategory,
} from "@/lib/docs";
import {
  fsWriteFile,
  type WriteBatch,
} from "@/lib/episodic/io-helpers";
import { sliceIdToAgentPath } from "@/lib/episodic/manager";
import { readSlicePart, readSlicePartResolved } from "../paths";
import {
  RESEARCH_RECORD_PREFIX,
  applyCaseWriteIntent,
  extractDocMarkers,
  extractProcessedMarkerIds,
  makeCaseReadTool,
  renderManifest,
  type CaseWriterManifest,
  type DocMarker,
  type SliceExcerpt,
} from "./librarian";

// ─── The pass ──────────────────────────────────────────────────────────────

const writeOpSchema = z.object({
  action: z
    .enum(["open", "updateIndex", "appendTail", "addPiece", "close"])
    .describe(
      "open: a NEW case (category + caseName; body = the index.md 正文). " +
      "updateIndex: rewrite the 正文 of an EXISTING living case. " +
      "appendTail: one dated line on a SEALED case. " +
      "addPiece: a dated piece inside an existing case. " +
      "close: seal a case (note = 去向/结论).",
    ),
  category: z.enum(CASE_CATEGORIES),
  caseName: z.string().describe("The case name — permanent at birth; legal per the red-line rule."),
  /** open/updateIndex/addPiece: the 正文 (updateIndex = the WHOLE new body). */
  body: z.string().optional(),
  /** appendTail only. */
  line: z.string().optional(),
  /** addPiece only — the piece title. */
  title: z.string().optional(),
  /** close only. */
  note: z.string().optional(),
});

const researchSchema = z.object({
  writes: z.array(writeOpSchema).max(10),
  reasoning: z.string().describe("1-2 sentences for the developer log."),
});

const RESEARCH_SYSTEM = buildSubAgentSystem(`You are the question-run researcher of a personal memory system (v0.19). The user asked questions a quick answer could not settle; you investigate ACROSS the record and leave durable CASES (research/ = answered questions, hypotheses/ = guesses with falsification conditions).

You are shown: the triggering question markers, the slice they came from, and the case manifest (the whole memory tree, paths only). Read what you need with readCase (case documents) and readSlice (the L0 evidence — concrete facts live ONLY there).

## Task

Per question, judge: is there enough in the record to write something durable?
- research: answer a question. A case's index.md carries what is known and where it stands; pieces hold dated expansions; close seals it with the conclusion next to its evidence chain. New evidence continuing the SAME question updates the living case; a changed scope means a NEW case (names are permanent).
- hypothesis: a guess about the world/affairs WITH an explicit falsification condition — without one the write is refused. Evidence entries accumulate; close states confirmed / refuted / retired in prose.

Writing nothing is a legal outcome — the record may simply be too thin. A question you did not write about stays for a later pass.

## Rules

1. Ground everything in what you actually read (cases, slices). Cite slice ids in the prose when a fact comes from one.
2. Prose, in the user's language. No date bookkeeping — dates and evidence stamps are mechanical.
3. Living cases are rewritten whole (updateIndex); sealed cases grow only via appendTail/addPiece. Never restate what a case already carries.
4. Scope honesty: if the question was already answered by an existing case, say so in reasoning and write nothing.

## Output

Call \`docResearchOutput\` with your writes (or empty) + reasoning.`);

/** Does this hypothesis body carry a falsification condition? (§B.6) */
function hasFalsificationCondition(body: string): boolean {
  return body.includes("证伪");
}

export interface DocResearchPassInput {
  model: ModelConfig;
  /** The slice whose agent.md carries the question markers. */
  sliceId: string;
  excerpt: SliceExcerpt;
  /** The listTree manifest — what cases exist before the pass starts.
   *  Optional at the seam: absent → empty tree (readCase becomes the only
   *  discovery surface — degraded but functional). */
  manifest?: CaseWriterManifest;
  /** User-local date (YYYY-MM-DD) stamping every write. */
  date: string;
  batch?: WriteBatch;
  /** @deprecated R3a: strands are dead. Ignored. */
  strands?: unknown;
}

export interface DocResearchPassResult {
  ran: boolean;
  written: string[];
  skipped: Array<{ id: string; reason: string }>;
}

/**
 * The question research/hypothesis pass — ONE function, question-driven.
 * Picks up unprocessed "question" markers from the slice's agent.md,
 * investigates with readCase/readSlice, and writes research/ hypotheses/
 * cases through the five ops under the per-case lock. Never throws.
 */
export async function runDocResearchPass(
  input: DocResearchPassInput,
): Promise<DocResearchPassResult> {
  const { model, sliceId, excerpt, date, batch } = input;
  const manifest = input.manifest ?? { truncated: false, tree: {} };
  const skipped: Array<{ id: string; reason: string }> = [];

  let agentMd: string;
  try {
    // Dual-root read (v0.19 R2): the mailbox of a slice created before the
    // root move lives under the legacy slices root.
    agentMd = await readSlicePart(sliceId, "agent", batch);
  } catch {
    return { ran: false, written: [], skipped };
  }

  const processed = extractProcessedMarkerIds(agentMd, RESEARCH_RECORD_PREFIX);
  const questions = extractDocMarkers(agentMd).filter(
    (m) => m.kind === "question" && !processed.has(m.id),
  );
  if (questions.length === 0) return { ran: false, written: [], skipped };

  const questionBlocks = (questions as DocMarker[])
    .map(
      (q) =>
        `### marker ${q.id}\ntitle: ${q.title}\nnote: ${q.note || "（无）"}`,
    )
    .join("\n\n");

  const prompt = `## 触发切片 ${sliceId}

focus: ${excerpt.focus || "（无）"}
summary: ${excerpt.summary || "（无）"}

${excerpt.turnsExcerpt || "（无对话摘录）"}

## 用户的问题（驱动本次 pass 的全部议程——保守：除此之外不研究任何事）

${questionBlocks}

## case 清单（listTree 全树；"已有什么"的目录）

${renderManifest(manifest.tree)}
${manifest.truncated ? "\n（清单可能被截断——缺失的 case 以 readCase 的死链为准）\n" : ""}
用 readCase / readSlice 取证，然后按指示给出写操作。`;

  const tools = {
    readCase: makeCaseReadTool(batch),
    readSlice: tool({
      description:
        "Read a slice's core.md by slice id (YYYY-MM-DD-HHMM) — the L0 evidence. " +
        "Concrete facts (numbers, dates, quotes) may ONLY come from here.",
      inputSchema: z.object({ sliceId: z.string() }),
      execute: async ({ sliceId: id }: { sliceId: string }) => {
        try {
          // Dual-root read (v0.19 R2): evidence slices may predate the
          // records root move.
          return await readSlicePart(id, "core", batch);
        } catch {
          return `（切片 ${id} 不存在或不可读）`;
        }
      },
    }),
    docResearchOutput: tool({
      description: "Report the research/hypothesis writes (or empty) + reasoning.",
      inputSchema: researchSchema,
    }),
  };

  const result = await runSubAgent({
    model,
    system: RESEARCH_SYSTEM,
    prompt,
    temperature: 0,
    maxSteps: 15,
    timeoutMs: 120_000,
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
    };
  }

  const written: string[] = [];

  for (const op of result.report.writes) {
    const identity = `${op.category}/${op.caseName}`;
    if (!isValidCaseName(op.caseName)) {
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
      let applied: { path: string };
      switch (op.action) {
        case "open": {
          if (!op.body?.trim()) throw new Error("open requires a body");
          applied = await applyCaseWriteIntent(
            { action: "open", category, caseName: op.caseName, body: `${op.body.trim()}\n\n（证据切片：${sliceId}）` },
            date, batch,
          );
          break;
        }
        case "updateIndex": {
          if (!op.body?.trim()) throw new Error("updateIndex requires a body");
          applied = await applyCaseWriteIntent(
            { action: "rewriteIndex", category, caseName: op.caseName, body: `${op.body.trim()}\n\n（证据切片：${sliceId}）` },
            date, batch,
          );
          break;
        }
        case "appendTail": {
          if (!op.line?.trim()) throw new Error("appendTail requires a line");
          applied = await applyCaseWriteIntent(
            { action: "appendTail", category, caseName: op.caseName, line: `${op.line.trim()}（证据切片：${sliceId}）` },
            date, batch,
          );
          break;
        }
        case "addPiece": {
          if (!op.title?.trim() || !op.body?.trim()) {
            throw new Error("addPiece requires a title and a body");
          }
          applied = await applyCaseWriteIntent(
            { action: "addPiece", category, caseName: op.caseName, title: op.title.trim(), body: `${op.body.trim()}\n\n（证据切片：${sliceId}）` },
            date, batch,
          );
          break;
        }
        case "close": {
          if (!op.note?.trim()) throw new Error("close requires a note (去向说明)");
          applied = await applyCaseWriteIntent(
            { action: "close", category, caseName: op.caseName, note: op.note.trim() },
            date, batch,
          );
          break;
        }
      }
      written.push(applied.path.replace(/^memory\//, ""));
    } catch (e) {
      skipped.push({ id: "?", reason: e instanceof Error ? e.message : String(e) });
    }
  }

  // Every question marker this pass SAW is recorded as processed — the pass
  // is single-shot per boundary; an unanswered question stays visible in
  // reasoning, not as a growing backlog.
  const recordLines: string[] = [];
  for (const q of questions) {
    recordLines.push(
      `${RESEARCH_RECORD_PREFIX} {"id":${JSON.stringify(q.id)},"docs":${JSON.stringify(written)}}`,
    );
  }
  if (recordLines.length > 0) {
    try {
      // Dual-root read (the slice may predate the root move), and the record
      // append goes back to the root the mailbox was actually read from —
      // splitting markers (legacy) from records (new) would re-see every
      // question on the next pass.
      const resolved = await readSlicePartResolved(sliceId, "agent", batch).catch(() => null);
      const fresh = resolved?.content ?? "";
      const next = fresh.trimEnd()
        ? `${fresh.trimEnd()}\n\n${recordLines.join("\n")}\n`
        : `${recordLines.join("\n")}\n`;
      await fsWriteFile(resolved?.path ?? sliceIdToAgentPath(sliceId), next, batch);
    } catch {
      // record loss → a question may be re-seen; the case tail is append-only,
      // keeping that a duplicate dated line: visible, non-fatal.
    }
  }

  return { ran: true, written, skipped };
}
