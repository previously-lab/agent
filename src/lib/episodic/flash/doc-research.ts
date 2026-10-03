/**
 * Background research/hypothesis pass (v0.15 design §3.4, §3.5, §4.3).
 *
 * THE DEGRADED FORM, ON PURPOSE: the design's real background stream is an
 * independent durable run, which needs the v0.11 §10 groundwork (fitness
 * append-only, projection stripping, the evolution single-writer) — that
 * groundwork does not exist yet. What this module implements is the design's
 * own documented fallback (§9): a single boundary-triggered pass riding the
 * housekeeping tail, driven by the USER'S QUESTIONS (the "question" markers
 * the reply segment drops into agent.md). The agenda stays conservative —
 * NO automatic research, NO scheduled re-thinking: no marker, no pass.
 *
 * The whole pass is ONE function (`runDocResearchPass`) so it can be lifted
 * into an independent durable run wholesale when the groundwork lands.
 *
 * Discipline (same structural shape as the librarian):
 * - read-before-write: the topic homes named by the triggering markers enter
 *   the prompt BEFORE the call (their 名录 is the "what already exists"
 *   surface); the pass additionally gets read tools (readDoc / readTopicHome
 *   / readSlice) for cross-slice digging — it is a reader before it is a
 *   writer.
 * - evidence-while-writing: every landed entry carries the triggering slice
 *   id, stamped mechanically.
 * - writes are validated intents: the model returns write ops; engineering
 *   applies them through the src/lib/docs pure ops under the per-doc lock.
 *   A hypothesis whose body carries no falsification condition is REFUSED
 *   (§3.5: 无证伪条件不是假说) — the refusal is recorded, visible.
 *
 * Never throws: failures degrade to skipped items in the result.
 */
import { tool } from "ai";
import { z } from "zod";
import { runSubAgent } from "@/lib/agents/sub-agent-runner";
import { buildSubAgentSystem } from "@/lib/agents/prompts";
import type { ModelConfig } from "@/lib/models/registry";
import type { StrandIndex } from "@/lib/episodic/types";
import {
  appendEntry,
  buildDocFileName,
  createDocSkeleton,
  isValidDocFileName,
  markStatus,
  normalizeDocRef,
  rewriteAsOf,
  serializeDoc,
  type ParsedDoc,
} from "@/lib/docs";
import { readDocQuery, type DocsFs } from "@/lib/docs/docs-query";
import {
  fsListFiles,
  fsReadFile,
  fsWriteFile,
  type WriteBatch,
} from "@/lib/episodic/io-helpers";
import {
  getStrandFilePath,
  getTopicDocPath,
  readTopicDoc,
} from "@/lib/episodic/strand-files";
import { updateDocUnderLock } from "@/lib/episodic/doc-lock";
import {
  sliceIdToAgentPath,
  sliceIdToFilePath,
} from "@/lib/episodic/manager";
import {
  RESEARCH_RECORD_PREFIX,
  appendTopicDirectoryEntry,
  extractDocMarkers,
  extractProcessedMarkerIds,
  type DocMarker,
  type SliceExcerpt,
} from "./librarian";

// ─── The pass ──────────────────────────────────────────────────────────────

const writeOpSchema = z.object({
  kind: z.enum(["research", "hypothesis"]),
  mode: z
    .enum(["open", "append", "close"])
    .describe(
      "open: a new document (title required). " +
      "append: a dated 更新 entry to an existing document (target required). " +
      "close: the concluding 结案 entry + status closed (target required).",
    ),
  title: z
    .string()
    .optional()
    .describe("open only — the doc title. 命名纪律: state exactly what is being investigated/guessed, specific enough that a scope change would mean a NEW doc."),
  target: z
    .string()
    .optional()
    .describe("append/close only — the existing document file name."),
  entryTitle: z.string().describe("Free entry name (开篇/更新/结案/…)."),
  body: z
    .string()
    .describe(
      "The entry prose. research: question → findings → conclusion, the conclusion living next to its evidence chain. " +
      "hypothesis: the guess PLUS its falsification condition (无证伪条件不是假说 — a body without one is refused).",
    ),
  asOf: z.string().optional().describe("The one-sentence 截至 statement after this write."),
  topics: z.array(z.string()).catch([]).default([]).describe("Topic strands this document belongs to (双重散文断言 — the home gets the matching 名录 entry)."),
});

const researchSchema = z.object({
  writes: z.array(writeOpSchema).max(10),
  reasoning: z.string().describe("1-2 sentences for the developer log."),
});

const RESEARCH_SYSTEM = buildSubAgentSystem(`You are the background researcher of a personal memory system. The user asked questions a quick answer could not settle; you investigate ACROSS the record and leave durable documents.

You are shown: the triggering question markers, the slice they came from, and the current homes of the topics they name (their 名录 lists the documents already hanging under each topic — read any of them with readDoc before deciding to write). You may also read slices (readSlice) — the L0 evidence.

## Task

Per question, judge: is there enough in the record to write something durable?
- research: answer a question. 开篇 states the question and its origin; 更新 records findings (and says WHICH earlier belief each replaces); 结案 gives the conclusion next to its evidence chain. New evidence continuing the SAME question appends to the existing document; a changed scope means a NEW document (titles are permanent).
- hypothesis: a guess about the world/affairs WITH an explicit falsification condition. Evidence-arrived entries accumulate; 结案 states confirmed / refuted / retired in prose.

Writing nothing is a legal outcome — the record may simply be too thin. A question you did not write about stays for a later pass.

## Rules

1. Ground everything in what you actually read (documents, homes, slices). Cite slice ids in the prose when a fact comes from one.
2. Prose, in the user's language. No date bookkeeping — dates and evidence stamps are mechanical.
3. Append-only: never restate an existing entry; add the new finding with its date.
4. Scope honesty: a 沉淀 from one conversation is not your job — you write the cross-record view. If the question was already answered by an existing document, say so in reasoning and write nothing.

## Output

Call \`docResearchOutput\` with your writes (or empty) + reasoning.`);

function buildResearchPrompt(input: {
  sliceId: string;
  excerpt: SliceExcerpt;
  questions: DocMarker[];
  homes: Array<{ topic: string; text: string | null }>;
}): string {
  const questionBlocks = input.questions
    .map(
      (q) =>
        `### marker ${q.id}\ntitle: ${q.title}\nnote: ${q.note || "（无）"}\n` +
        `topics: ${q.topics.length > 0 ? q.topics.join("、") : "（无）"}`,
    )
    .join("\n\n");
  const homeBlocks = input.homes
    .map(
      ({ topic, text }) =>
        `### 主题之家 ${topic}\n\n${text ?? "（尚无之家）"}`,
    )
    .join("\n\n");

  return `## 触发切片 ${input.sliceId}

focus: ${input.excerpt.focus || "（无）"}
summary: ${input.excerpt.summary || "（无）"}

${input.excerpt.turnsExcerpt || "（无对话摘录）"}

## 用户的问题（驱动本次 pass 的全部议程——保守：除此之外不研究任何事）

${questionBlocks}

## 相关主题之家（写前已读；名录即"已有什么"）

${homeBlocks || "（标记未指名任何主题）"}

用 readDoc / readTopicHome / readSlice 继续取证，然后按指示给出写操作。`;
}

/** Does this hypothesis body carry a falsification condition? (§3.5) */
function hasFalsificationCondition(body: string): boolean {
  return body.includes("证伪");
}

export interface DocResearchPassInput {
  model: ModelConfig;
  /** The closed slice whose agent.md carries the question markers. */
  sliceId: string;
  excerpt: SliceExcerpt;
  strands: StrandIndex;
  /** User-local date (YYYY-MM-DD) stamping every write. */
  date: string;
  batch?: WriteBatch;
}

export interface DocResearchPassResult {
  ran: boolean;
  written: string[];
  skipped: Array<{ id: string; reason: string }>;
}

/**
 * The background research/hypothesis pass — ONE function, boundary-triggered,
 * question-driven. Picks up unprocessed "question" markers from the closed
 * slice's agent.md, investigates with read tools, and writes docs/research/
 * and docs/hypothesis/ through validated intents. Never throws.
 */
export async function runDocResearchPass(
  input: DocResearchPassInput,
): Promise<DocResearchPassResult> {
  const { model, sliceId, excerpt, strands, date, batch } = input;
  const skipped: Array<{ id: string; reason: string }> = [];

  let agentMd: string;
  try {
    agentMd = await fsReadFile(sliceIdToAgentPath(sliceId), batch);
  } catch {
    return { ran: false, written: [], skipped };
  }

  const processed = extractProcessedMarkerIds(agentMd, RESEARCH_RECORD_PREFIX);
  const questions = extractDocMarkers(agentMd).filter(
    (m) => m.kind === "question" && !processed.has(m.id),
  );
  if (questions.length === 0) return { ran: false, written: [], skipped };

  // Read-before-write, structural: the homes named by the questions enter
  // the prompt BEFORE the call.
  const homeTopics = [...new Set(questions.flatMap((q) => q.topics))].filter((t) =>
    Object.prototype.hasOwnProperty.call(strands, t),
  );
  const homes: Array<{ topic: string; text: string | null }> = [];
  for (const topic of homeTopics) {
    try {
      const home = await readTopicDoc(topic, batch);
      homes.push({ topic, text: home ? serializeDoc(home.doc).trim() : null });
    } catch {
      homes.push({ topic, text: null });
    }
  }

  // The read-tool surface, over the batch-aware fs (read-your-writes).
  const docsFs: DocsFs = {
    readText: (path) => fsReadFile(path, batch),
    listDir: (path) => fsListFiles(path),
  };
  const tools = {
    readDoc: tool({
      description:
        "Read a document by file name (e.g. 2026-09-05-手机购买调研 or 用户手机). " +
        "Resolves across all document kinds. Returns the full text, or a dead-link error.",
      inputSchema: z.object({ fileName: z.string() }),
      execute: async ({ fileName }) => {
        const result = await readDocQuery(docsFs, fileName);
        if ("error" in result) return result.error;
        return result.content;
      },
    }),
    readTopicHome: tool({
      description: "Read a topic home by strand name (full text; falls back to the legacy location).",
      inputSchema: z.object({ name: z.string() }),
      execute: async ({ name }) => {
        try {
          return await fsReadFile(getTopicDocPath(name), batch);
        } catch {
          try {
            return await fsReadFile(getStrandFilePath(name), batch);
          } catch {
            return `（主题之家 ${name} 不存在）`;
          }
        }
      },
    }),
    readSlice: tool({
      description:
        "Read a slice's core.md by slice id (YYYY-MM-DD-HHMM) — the L0 evidence. " +
        "Concrete facts (numbers, dates, quotes) may ONLY come from here.",
      inputSchema: z.object({ sliceId: z.string() }),
      execute: async ({ sliceId: id }) => {
        try {
          return await fsReadFile(sliceIdToFilePath(id), batch);
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
    prompt: buildResearchPrompt({ sliceId, excerpt, questions, homes }),
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
  const recordLines: string[] = [];
  const strandNames = new Set(Object.keys(strands));

  for (const op of result.report.writes) {
    // Resolve the target file name.
    let fileName: string;
    if (op.mode === "open") {
      if (!op.title?.trim()) {
        skipped.push({ id: "?", reason: `${op.kind} open without a title` });
        continue;
      }
      try {
        fileName = buildDocFileName(op.kind, date, op.title.trim());
      } catch (e) {
        skipped.push({ id: "?", reason: e instanceof Error ? e.message : String(e) });
        continue;
      }
    } else {
      const canonical = op.target ? normalizeDocRef(op.target) : null;
      if (!canonical || !isValidDocFileName(canonical, op.kind)) {
        skipped.push({ id: "?", reason: `illegal target: ${JSON.stringify(op.target)}` });
        continue;
      }
      fileName = canonical;
    }

    // A hypothesis without a falsification condition is not a hypothesis.
    if (op.kind === "hypothesis" && op.mode === "open" && !hasFalsificationCondition(op.body)) {
      skipped.push({ id: "?", reason: `hypothesis ${fileName} lacks a falsification condition` });
      continue;
    }

    try {
      const applied = await updateDocUnderLock(op.kind, fileName, batch, (current) => {
        if (op.mode !== "open" && !current) return null; // cannot append/close a ghost
        const base: ParsedDoc =
          current ??
          createDocSkeleton({
            fileName,
            kind: op.kind,
            opened: date,
            heading: op.title?.trim() ?? null,
          });
        let next = appendEntry(base, {
          date,
          title: op.entryTitle.trim() || (op.mode === "close" ? "结案" : current ? "更新" : "开篇"),
          body: `${op.body.trim()}\n\n（证据切片：${sliceId}）`,
        });
        const asOf = op.asOf?.trim();
        if (asOf) next = rewriteAsOf(next, { date, text: asOf });
        if (op.mode === "close") next = markStatus(next, "closed", date);
        return next;
      });
      if (!applied.wrote) {
        skipped.push({ id: "?", reason: `${op.mode} on missing document ${fileName}` });
        continue;
      }
      written.push(fileName);

      for (const topic of op.topics) {
        if (!strandNames.has(topic)) continue;
        await appendTopicDirectoryEntry({
          topic,
          docFileName: fileName,
          action: op.mode === "open" ? "开设" : op.mode === "close" ? "结案" : "更新",
          date,
          batch,
        });
      }
    } catch (e) {
      skipped.push({ id: "?", reason: e instanceof Error ? e.message : String(e) });
    }
  }

  // Every question marker this pass SAW is recorded as processed — the pass
  // is single-shot per boundary; an unanswered question stays visible in
  // reasoning, not as a growing backlog.
  for (const q of questions) {
    recordLines.push(
      `${RESEARCH_RECORD_PREFIX} {"id":${JSON.stringify(q.id)},"docs":${JSON.stringify(written)}}`,
    );
  }
  if (recordLines.length > 0) {
    try {
      const fresh = await fsReadFile(sliceIdToAgentPath(sliceId), batch).catch(() => "");
      const next = fresh.trimEnd()
        ? `${fresh.trimEnd()}\n\n${recordLines.join("\n")}\n`
        : `${recordLines.join("\n")}\n`;
      await fsWriteFile(sliceIdToAgentPath(sliceId), next, batch);
    } catch {
      // record loss → a question may be re-seen; append-only docs keep that non-fatal.
    }
  }

  return { ran: true, written, skipped };
}
