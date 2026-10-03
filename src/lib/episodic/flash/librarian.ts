/**
 * Librarian + scribe — the document write path at the housekeeping boundary
 * (v0.15 design §3.2, §4.3).
 *
 * THE LIBRARIAN (主题之家维护, §3.2): evolved from the old strand-consolidator
 * description pass. Invoked at the slice-close boundary (the existing
 * mechanical trigger), it judges FOR ITSELF whether anything is worth
 * writing — an empty run is a legal outcome (axiom D: the old ≥5-new-slices /
 * 7-day-cooldown / ≤10-per-pass semantic gates are all deleted; cost
 * discipline comes from the rarity of the trigger — close boundaries only —
 * plus the engineering fuses: step cap + timeout).
 *
 * Writer-is-reader (§4.3) is STRUCTURAL here, not a prompt plea: the
 * engineering layer assembles the closed slice's content and the full current
 * text of every touched topic home into the prompt BEFORE the call, and the
 * model has no write tools — it returns write-intents that engineering
 * validates and applies through the src/lib/docs pure ops under the per-doc
 * lock. The old consolidator's "blind description" disease (prompt carried
 * only slice ids, no content, no read tools) cannot recur in this shape.
 *
 * Evidence-while-writing (§4.3): every entry the pass lands carries the
 * triggering slice id, stamped MECHANICALLY by the engineering layer — the
 * model can no more forget it than it can forge it.
 *
 * THE SCRIBE (书记段, §3.1/§3.6): picks up the structured one-line markers
 * the reply segment drops into the slice's agent.md ("这值得沉淀 / 这该开个
 * 任务") and writes them into docs/research (sediment), docs/<entityKind>/
 * (entity updates), or docs/task/ (date-anchored task docs). Markers are the
 * inter-stream mailbox (§3.1); a processed marker gets a `[doc-scribe]`
 * record line in the same agent.md so a marker is never written twice.
 *
 * THE MARKER CONTRACT (owned by this module, consumed by the future reply
 * segment — v0.11): one line in agent.md,
 *   [doc-marker] {"v":1,"id":"<turnId>-<n>","kind":"sediment|task|question",
 *     "docType":"research|entity","entityKind":"event|person|object|place|org",
 *     "target":"<existing doc file name, optional>","title":"...",
 *     "dateAnchor":"YYYY-MM-DD (task only)","note":"...","topics":["..."]}
 * "question" markers are NOT the scribe's — they route to the background
 * research pass (flash/doc-research.ts).
 *
 * Never throws at the top level: every failure degrades to a skipped item in
 * the result, so housekeeping is never taken down by a document write.
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
  isValidDate,
  isValidDocFileName,
  markStatus,
  normalizeDocRef,
  rewriteAsOf,
  serializeDoc,
  type DocKind,
  type ParsedDoc,
} from "@/lib/docs";
import {
  fsReadFile,
  fsWriteFile,
  type WriteBatch,
} from "@/lib/episodic/io-helpers";
import { readTopicDoc } from "@/lib/episodic/strand-files";
import { updateDocUnderLock } from "@/lib/episodic/doc-lock";
import { sliceIdToAgentPath } from "@/lib/episodic/manager";

// ─── Shared bits ───────────────────────────────────────────────────────────

/** What the writer read before writing — the slice, excerpted. */
export interface SliceExcerpt {
  focus: string;
  summary: string;
  turnsExcerpt: string;
}

/**
 * Excerpt a slice for a writer pass: its archived marks plus a bounded tail
 * of the conversation. The excerpt is the pass's READ of the slice — bounded
 * so the prompt stays small, but real content, never bare ids.
 */
export function buildSliceExcerpt(slice: {
  focus?: string;
  summary?: string;
  turns: Array<{ role: string; content: string }>;
}): SliceExcerpt {
  const turnsExcerpt = slice.turns
    .slice(-8)
    .map(
      (t) =>
        `${t.role === "user" ? "用户" : "agent"}: ` +
        t.content.replace(/\s+/g, " ").trim().slice(0, 300),
    )
    .join("\n");
  return {
    focus: slice.focus ?? "",
    summary: slice.summary ?? "",
    turnsExcerpt,
  };
}

/** Evidence-while-writing, mechanical: the triggering slice id rides every entry. */
function stampEvidence(body: string, sliceId: string): string {
  return `${body.trim()}\n\n（证据切片：${sliceId}）`;
}

/** Strip the `.md` for prose references (design §2.2: the suffix may be omitted). */
function proseRef(fileName: string): string {
  return fileName.replace(/\.md$/, "");
}

// ─── Topic-home directory entries (名录) ───────────────────────────────────

/**
 * Append a 名录 entry to a topic's home ("《…》开设" / "《…》结案" / …), in
 * the SAME batch as the document write that occasioned it (design §3.2:
 * 文档开设/结案时同一次 WriteBatch 给之家追加名录条目; the batch is not a
 * transaction — a half-failure is visible, never blocking).
 *
 * A home that does not exist yet is OPENED by this call — 第一篇文档落地时
 * 新开之家 is one of the two legitimate birth moments (§3.2). The topic name
 * must pass the topic naming rule; an illegal name is refused, never written.
 */
export async function appendTopicDirectoryEntry(input: {
  topic: string;
  docFileName: string;
  /** The directory verb — a prose convention (开设/结案/作废/更新), not an enum. */
  action: string;
  date: string;
  note?: string;
  batch?: WriteBatch;
}): Promise<{ ok: boolean; reason?: string }> {
  const { topic, docFileName, action, date, note, batch } = input;
  const fileName = `${topic}.md`;
  if (!isValidDocFileName(fileName, "topic")) {
    return { ok: false, reason: `illegal topic name: ${JSON.stringify(topic)}` };
  }
  try {
    // Legacy fallback: a home that exists only in the OLD location becomes
    // the mutation's base, so the write lands in docs/topic WITHOUT losing
    // the legacy 初始描述 entry (an in-lock read of the new location still
    // wins when it exists).
    const preRead = await readTopicDoc(topic, batch);
    await updateDocUnderLock("topic", fileName, batch, (current) => {
      const base =
        current ??
        preRead?.doc ??
        createDocSkeleton({ fileName, kind: "topic", opened: date, heading: topic });
      return appendEntry(base, {
        date,
        title: "名录",
        body: `《${proseRef(docFileName)}》${action}。${note?.trim() ?? ""}`.trim(),
      });
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

// ─── Merge fallout: void the merged-from homes (mechanical) ────────────────

/**
 * When the strand-merge machinery collapses key `from` into `to`, the
 * merged-from home gets a dated 作废 entry ("已并入《X》") and status `void`
 * — the home is NOT deleted; its history stays readable (design §3.2). A
 * strand with no home (bare index) has nothing to void. Mechanical — no LLM.
 */
export async function voidMergedTopicHomes(
  merges: Array<{ from: string; to: string }>,
  date: string,
  batch?: WriteBatch,
): Promise<{ voided: string[]; skipped: Array<{ name: string; reason: string }> }> {
  const voided: string[] = [];
  const skipped: Array<{ name: string; reason: string }> = [];
  for (const { from, to } of merges) {
    const fileName = `${from}.md`;
    if (!isValidDocFileName(fileName, "topic")) {
      skipped.push({ name: from, reason: "illegal topic name" });
      continue;
    }
    try {
      const preRead = await readTopicDoc(from, batch);
      if (!preRead) {
        skipped.push({ name: from, reason: "no home file" });
        continue;
      }
      const result = await updateDocUnderLock("topic", fileName, batch, (current) => {
        const base = current ?? preRead.doc;
        const withEntry = appendEntry(base, {
          date,
          title: `作废 — 已并入《${to}》`,
          body:
            `strands 键 «${from}» 已并入 «${to}»。本之家自即日起作废，` +
            `历史条目保留备查；后续动态见《${to}》。`,
        });
        return markStatus(withEntry, "void", date);
      });
      if (result.wrote) voided.push(from);
      else skipped.push({ name: from, reason: "no home file" });
    } catch (e) {
      skipped.push({ name: from, reason: e instanceof Error ? e.message : String(e) });
    }
  }
  return { voided, skipped };
}

// ─── The librarian pass (LLM, close-boundary) ──────────────────────────────

const librarianSchema = z.object({
  homes: z
    .array(
      z.object({
        strand: z.string().describe("The strand key this write targets. MUST be one listed in the user message."),
        action: z
          .enum(["skip", "open", "append"])
          .describe(
            "skip: nothing worth writing (a legal, often correct answer). " +
            "open: create this strand's home (it has none yet). " +
            "append: add a dated 动态 entry to the existing home.",
          ),
        entryTitle: z.string().optional().describe("Free entry name, e.g. 动态 / 开篇. Required for open/append."),
        body: z.string().optional().describe("The entry prose. Required for open/append."),
        asOf: z.string().optional().describe("New one-sentence 截至 understanding of the topic, when it moved."),
      }),
    )
    .max(50),
  reasoning: z.string().describe("1-2 sentences for the developer log, incl. why strands were skipped."),
});

const LIBRARIAN_SYSTEM = buildSubAgentSystem(`You are the librarian of a personal memory system. You maintain TOPIC HOMES (主题之家): one prose home per topic strand — what the topic is, what happened to it, which documents hang under it.

A "strand" is a keyword threading through time slices. When a slice closes, you are shown: the slice's content (excerpt), and the strands it touched WITH their current homes in full. You have already read everything you may write about — never invent beyond the shown material.

## Task

Decide, PER STRAND, whether the closed slice carries something worth recording in its home:
- append: the topic moved — something happened, an understanding changed, a decision landed. Write one dated 动态 entry.
- open: the strand has no home yet AND it has become a real thread worth a home (a one-off mention is NOT — it stays in the slices).
- skip: nothing worth writing. Skipping everything is a legal, often correct outcome. Restraint is the default: the home is the topic's long-term memory, not a chat log.

## Rules

1. Ground every entry in the shown slice content. No speculation, no boilerplate ("用户继续讨论了…" is not an entry).
2. Entries are prose, in the user's language. Never put slice rosters or date bookkeeping in the prose — dates and evidence are stamped mechanically.
3. Update the 截至 sentence (asOf) only when the one-sentence understanding of the topic actually moved.
4. A home is append-only: you may add entries and refresh the 截至 sentence, never rewrite old entries.

## Output

Call \`librarianOutput\` with one decision per strand + a short reasoning note.`);

function buildLibrarianPrompt(input: {
  excerpt: SliceExcerpt;
  closedSliceId: string;
  homes: Array<{ name: string; sliceCount: number; doc: ParsedDoc | null }>;
}): string {
  const homeBlocks = input.homes
    .map(({ name, sliceCount, doc }) => {
      const current = doc
        ? serializeDoc(doc).trim()
        : "（尚无之家——值得时才开设）";
      return `### ${name}（${sliceCount} 片）\n\n${current}`;
    })
    .join("\n\n");

  return `## 刚关闭的切片 ${input.closedSliceId}

focus: ${input.excerpt.focus || "（无）"}
summary: ${input.excerpt.summary || "（无）"}

${input.excerpt.turnsExcerpt || "（无对话摘录）"}

## 触及的主题之家（全文如上，写前已读）

${homeBlocks}

按指示给出每个主题的决定。`;
}

export interface LibrarianPassInput {
  model: ModelConfig;
  closedSliceId: string;
  excerpt: SliceExcerpt;
  /** The post-consolidation strand index (authoritative key set). */
  strands: StrandIndex;
  /** Merges applied this boundary — their merged-from homes are voided first. */
  merges: Array<{ from: string; to: string }>;
  /** User-local date (YYYY-MM-DD) stamping every write. */
  date: string;
  batch?: WriteBatch;
}

export interface LibrarianPassResult {
  voided: string[];
  llmRan: boolean;
  written: string[];
  skipped: Array<{ name: string; reason: string }>;
}

/**
 * The librarian pass. Mechanical merge fallout first (void merged-from
 * homes), then — when the closed slice touched any strand — one LLM call
 * over the touched homes. Never throws.
 */
export async function runLibrarianPass(
  input: LibrarianPassInput,
): Promise<LibrarianPassResult> {
  const { model, closedSliceId, excerpt, strands, merges, date, batch } = input;
  const skipped: Array<{ name: string; reason: string }> = [];

  const mergeFallout = await voidMergedTopicHomes(merges, date, batch);
  skipped.push(...mergeFallout.skipped);

  const relPath = closedSliceId.replace(/-/g, "/");
  const touched = Object.keys(strands).filter((k) => strands[k].includes(relPath));
  if (touched.length === 0) {
    return { voided: mergeFallout.voided, llmRan: false, written: [], skipped };
  }

  // Writer-is-reader: the homes enter the prompt BEFORE the call, in full.
  const homes: Array<{ name: string; sliceCount: number; doc: ParsedDoc | null }> = [];
  for (const name of touched) {
    try {
      const home = await readTopicDoc(name, batch);
      homes.push({ name, sliceCount: strands[name].length, doc: home?.doc ?? null });
    } catch (e) {
      skipped.push({ name, reason: e instanceof Error ? e.message : String(e) });
    }
  }
  if (homes.length === 0) {
    return { voided: mergeFallout.voided, llmRan: false, written: [], skipped };
  }

  const result = await runSubAgent({
    model,
    system: LIBRARIAN_SYSTEM,
    prompt: buildLibrarianPrompt({ excerpt, closedSliceId, homes }),
    temperature: 0,
    maxSteps: 50,
    timeoutMs: 30_000,
    tools: {
      librarianOutput: tool({
        description: "Report the per-strand home decisions.",
        inputSchema: librarianSchema,
      }),
    },
    toolChoice: "required",
    reportToolName: "librarianOutput",
    reportSchema: librarianSchema,
    progress: { toolName: "librarian" },
  });
  if (!result.ok || !result.report) {
    return {
      voided: mergeFallout.voided,
      llmRan: true,
      written: [],
      skipped: [...skipped, { name: "*", reason: result.error ?? "no librarian report" }],
    };
  }

  const written: string[] = [];
  const validStrands = new Set(touched);
  for (const op of result.report.homes) {
    if (op.action === "skip") continue;
    if (!validStrands.has(op.strand)) {
      skipped.push({ name: op.strand, reason: "not a touched strand" });
      continue;
    }
    const body = op.body?.trim();
    if (!body) {
      skipped.push({ name: op.strand, reason: "empty entry body" });
      continue;
    }
    const fileName = `${op.strand}.md`;
    if (!isValidDocFileName(fileName, "topic")) {
      skipped.push({ name: op.strand, reason: "illegal topic name" });
      continue;
    }
    try {
      // A legacy-only home (read above for the prompt) is the write's base,
      // so appending never drops the migrated 初始描述 entry.
      const preRead = homes.find((h) => h.name === op.strand)?.doc ?? null;
      const applied = await updateDocUnderLock("topic", fileName, batch, (current) => {
        const base =
          current ??
          preRead ??
          createDocSkeleton({ fileName, kind: "topic", opened: date, heading: op.strand });
        let next = appendEntry(base, {
          date,
          title: (op.entryTitle?.trim() || (current ? "动态" : "开篇")).trim(),
          body: stampEvidence(body, closedSliceId),
        });
        const asOf = op.asOf?.trim();
        if (asOf) next = rewriteAsOf(next, { date, text: asOf });
        return next;
      });
      if (applied.wrote) written.push(op.strand);
    } catch (e) {
      skipped.push({ name: op.strand, reason: e instanceof Error ? e.message : String(e) });
    }
  }

  return { voided: mergeFallout.voided, llmRan: true, written, skipped };
}

// ─── Markers: the agent.md mailbox (pure parsing) ──────────────────────────

export const DOC_MARKER_PREFIX = "[doc-marker]";
export const SCRIBE_RECORD_PREFIX = "[doc-scribe]";
export const RESEARCH_RECORD_PREFIX = "[doc-research]";

const markerSchema = z.object({
  v: z.literal(1),
  /** Unique within the slice (convention: <turnId>-<seq>) — the dedup key. */
  id: z.string().min(1),
  kind: z.enum(["sediment", "task", "question"]),
  /** sediment only: research (default) or entity. */
  docType: z.enum(["research", "entity"]).optional(),
  /** sediment+entity only: which of the five entity kinds. */
  entityKind: z.enum(["event", "person", "object", "place", "org"]).optional(),
  /** Optional existing document file name this marker updates. */
  target: z.string().optional(),
  /** The doc's title (命名纪律: specific enough that a scope change means a new doc). */
  title: z.string().min(1),
  /** task only: the date anchor the user stated. */
  dateAnchor: z.string().optional(),
  /** What this is about — the reply segment's one-line note. */
  note: z.string().default(""),
  /** Topic strands (strands.json keys) this doc belongs to. */
  topics: z.array(z.string()).catch([]).default([]),
});

export type DocMarker = z.infer<typeof markerSchema>;

/**
 * Extract every well-formed marker line from an agent.md text. Tolerant:
 * malformed lines are skipped silently (a broken marker is visible in the
 * file itself; the mailbox never blocks the writer). Duplicate ids collapse
 * to the first occurrence.
 */
export function extractDocMarkers(agentMd: string): DocMarker[] {
  const out: DocMarker[] = [];
  const seen = new Set<string>();
  for (const line of agentMd.split("\n")) {
    const t = line.trim();
    if (!t.startsWith(DOC_MARKER_PREFIX)) continue;
    try {
      const parsed = markerSchema.safeParse(
        JSON.parse(t.slice(DOC_MARKER_PREFIX.length).trim()),
      );
      if (parsed.success && !seen.has(parsed.data.id)) {
        seen.add(parsed.data.id);
        out.push(parsed.data);
      }
    } catch {
      // malformed JSON — skip
    }
  }
  return out;
}

/**
 * The ids a writer pass already processed (its record lines in agent.md).
 * A marker with a record is never written twice.
 */
export function extractProcessedMarkerIds(agentMd: string, prefix: string): Set<string> {
  const ids = new Set<string>();
  for (const line of agentMd.split("\n")) {
    const t = line.trim();
    if (!t.startsWith(prefix)) continue;
    try {
      const rec: unknown = JSON.parse(t.slice(prefix.length).trim());
      if (rec && typeof rec === "object" && typeof (rec as { id?: unknown }).id === "string") {
        ids.add((rec as { id: string }).id);
      }
    } catch {
      // malformed record — skip
    }
  }
  return ids;
}

// ─── The scribe pass (书记段) ──────────────────────────────────────────────

const scribeSchema = z.object({
  entries: z
    .array(
      z.object({
        id: z.string().describe("The marker id this entry answers."),
        entryTitle: z.string().describe("Free entry name, e.g. 开篇 / 更新."),
        body: z.string().describe("The entry prose, grounded in the slice excerpt and the marker note."),
        asOf: z.string().optional().describe("For a new or moved document: the one-sentence 截至 statement."),
      }),
    )
    .max(20),
  reasoning: z.string().describe("1-2 sentences for the developer log."),
});

const SCRIBE_SYSTEM = buildSubAgentSystem(`You are the scribe of a personal memory system. A conversation slice left MARKERS — one-line notes the reply segment dropped when it judged something worth sedimenting (a search/recall worth keeping, a task the user stated). Your job: write each marker into its document.

You are shown: the slice excerpt, and per marker the marker itself plus the CURRENT text of its target document when one exists. You have already read everything you may write about.

## Task

One entry per marker:
- sediment (research): the opening entry states the question and why it was asked; entries record what THIS conversation established. A sediment is one conversation's search/recall, honestly scoped — not a cross-time investigation.
- sediment (entity): record this conversation's new facts about the thing. A new document's opening entry says what it is and why it will be mentioned again.
- task: the opening entry states WHAT is to be done, the date anchor, the background, and links; the status stream starts here ("状态：待办" unless the slice shows otherwise).

## Rules

1. Ground every entry in the slice excerpt and the marker note. No invention.
2. Prose, in the user's language. No slice rosters, no date bookkeeping — dates and evidence ids are stamped mechanically.
3. Entries append; only the 截至 sentence may be (re)stated. Never contradict a shown existing entry — add the new fact with its date.

## Output

Call \`scribeOutput\` with one entry per marker you wrote + a short reasoning note. Writing nothing for a marker leaves it for a later pass.`);

interface ScribeTarget {
  marker: DocMarker;
  kind: DocKind;
  fileName: string;
  existed: boolean;
  currentText: string | null;
}

/**
 * Resolve a marker to its target document. Returns null (+reason) when the
 * marker cannot name a legal document — a scribe never writes an illegal
 * name (the slice-id namespace red line included).
 */
function resolveScribeTarget(
  marker: DocMarker,
  date: string,
): { kind: DocKind; fileName: string } | { error: string } {
  if (marker.kind === "task") {
    try {
      return { kind: "task", fileName: buildDocFileName("task", date, marker.title) };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }
  // sediment
  const kind: DocKind =
    marker.docType === "entity" ? (marker.entityKind ?? "object") : "research";
  if (marker.docType === "entity" && !marker.entityKind) {
    return { error: "entity sediment requires entityKind" };
  }
  if (marker.target) {
    const canonical = normalizeDocRef(marker.target);
    if (canonical && isValidDocFileName(canonical, kind)) {
      return { kind, fileName: canonical };
    }
    return { error: `illegal target document: ${JSON.stringify(marker.target)}` };
  }
  try {
    return { kind, fileName: buildDocFileName(kind, date, marker.title) };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

export interface ScribePassInput {
  model: ModelConfig;
  /** The slice whose agent.md is the mailbox (closed slice at a boundary, else the active one). */
  sliceId: string;
  excerpt: SliceExcerpt;
  /** Post-consolidation strand index — 名录 entries only land on real strands. */
  strands: StrandIndex;
  /** User-local date (YYYY-MM-DD) stamping every write. */
  date: string;
  batch?: WriteBatch;
}

export interface ScribePassResult {
  ran: boolean;
  written: string[];
  skipped: Array<{ id: string; reason: string }>;
}

/**
 * The scribe pass: read the slice's agent.md, pick up unprocessed
 * sediment/task markers, write their documents (read-before-write under the
 * per-doc lock), append 名录 entries to the markers' topic homes, and record
 * each processed marker back into the same agent.md. Never throws.
 */
export async function runScribePass(input: ScribePassInput): Promise<ScribePassResult> {
  const { model, sliceId, excerpt, strands, date, batch } = input;
  const skipped: Array<{ id: string; reason: string }> = [];

  let agentMd: string;
  try {
    agentMd = await fsReadFile(sliceIdToAgentPath(sliceId), batch);
  } catch {
    return { ran: false, written: [], skipped }; // no agent.md yet — nothing to pick up
  }

  const processed = extractProcessedMarkerIds(agentMd, SCRIBE_RECORD_PREFIX);
  const todo = extractDocMarkers(agentMd).filter(
    (m) => (m.kind === "sediment" || m.kind === "task") && !processed.has(m.id),
  );
  if (todo.length === 0) return { ran: false, written: [], skipped };

  // Resolve targets + pre-read the existing docs (writer-is-reader).
  const targets: ScribeTarget[] = [];
  for (const marker of todo) {
    const resolved = resolveScribeTarget(marker, date);
    if ("error" in resolved) {
      skipped.push({ id: marker.id, reason: resolved.error });
      continue;
    }
    let currentText: string | null = null;
    try {
      currentText = await fsReadFile(
        `memory/docs/${resolved.kind}/${resolved.fileName}`,
        batch,
        { fresh: true },
      );
    } catch {
      currentText = null; // does not exist yet — will be opened
    }
    targets.push({
      marker,
      kind: resolved.kind,
      fileName: resolved.fileName,
      existed: currentText !== null,
      currentText,
    });
  }
  if (targets.length === 0) return { ran: false, written: [], skipped };

  const markerBlocks = targets
    .map(({ marker, kind, fileName, existed, currentText }) => {
      const head =
        `### marker ${marker.id}（kind=${marker.kind}${marker.docType ? `/${marker.docType}` : ""}` +
        `${marker.entityKind ? `/${marker.entityKind}` : ""}）\n` +
        `title: ${marker.title}\nnote: ${marker.note || "（无）"}` +
        `${marker.dateAnchor ? `\n日期锚: ${marker.dateAnchor}` : ""}\n` +
        `目标文档: docs/${kind}/${fileName}（${existed ? "已存在，全文如下" : "将开设"}）`;
      return currentText ? `${head}\n\n${currentText.trim()}` : head;
    })
    .join("\n\n");

  const prompt = `## 切片 ${sliceId}

focus: ${excerpt.focus || "（无）"}
summary: ${excerpt.summary || "（无）"}

${excerpt.turnsExcerpt || "（无对话摘录）"}

## 待落笔的标记（写前已读目标文档）

${markerBlocks}

按指示给出每个标记的条目。`;

  const result = await runSubAgent({
    model,
    system: SCRIBE_SYSTEM,
    prompt,
    temperature: 0,
    maxSteps: 50,
    timeoutMs: 30_000,
    tools: {
      scribeOutput: tool({
        description: "Report the per-marker document entries.",
        inputSchema: scribeSchema,
      }),
    },
    toolChoice: "required",
    reportToolName: "scribeOutput",
    reportSchema: scribeSchema,
    progress: { toolName: "doc-scribe" },
  });
  if (!result.ok || !result.report) {
    return {
      ran: true,
      written: [],
      skipped: [...skipped, { id: "*", reason: result.error ?? "no scribe report" }],
    };
  }

  const byMarker = new Map(targets.map((t) => [t.marker.id, t]));
  const written: string[] = [];
  const recordLines: string[] = [];
  const strandNames = new Set(Object.keys(strands));

  for (const entry of result.report.entries) {
    const target = byMarker.get(entry.id);
    if (!target) {
      skipped.push({ id: entry.id, reason: "report answers an unknown marker" });
      continue;
    }
    const body = entry.body?.trim();
    if (!body) {
      skipped.push({ id: entry.id, reason: "empty entry body" });
      continue;
    }
    const { marker, kind, fileName } = target;
    // The task's date anchor is a mechanical fact — it rides the entry
    // whether the prose remembers it or not.
    const anchorLine =
      marker.kind === "task" && marker.dateAnchor && isValidDate(marker.dateAnchor)
        ? `日期锚：${marker.dateAnchor}\n\n`
        : "";
    try {
      await updateDocUnderLock(kind, fileName, batch, (current) => {
        const base =
          current ??
          createDocSkeleton({ fileName, kind, opened: date, heading: marker.title });
        let next = appendEntry(base, {
          date,
          title: entry.entryTitle.trim() || (current ? "更新" : "开篇"),
          body: stampEvidence(anchorLine + body, sliceId),
        });
        const asOf = entry.asOf?.trim();
        if (asOf) next = rewriteAsOf(next, { date, text: asOf });
        return next;
      });
      written.push(fileName);

      // 名录 entries — same batch, best-effort, only onto real strands.
      for (const topic of marker.topics) {
        if (!strandNames.has(topic)) continue;
        await appendTopicDirectoryEntry({
          topic,
          docFileName: fileName,
          action: target.existed ? "更新" : "开设",
          date,
          batch,
        });
      }
      recordLines.push(
        `${SCRIBE_RECORD_PREFIX} {"id":${JSON.stringify(entry.id)},"doc":${JSON.stringify(fileName)}}`,
      );
    } catch (e) {
      skipped.push({ id: entry.id, reason: e instanceof Error ? e.message : String(e) });
    }
  }

  // The mailbox bookkeeping: processed markers get a record line in the SAME
  // agent.md, so the next pass (any stream) never double-writes them.
  if (recordLines.length > 0) {
    try {
      const fresh = await fsReadFile(sliceIdToAgentPath(sliceId), batch).catch(() => "");
      const next = fresh.trimEnd()
        ? `${fresh.trimEnd()}\n\n${recordLines.join("\n")}\n`
        : `${recordLines.join("\n")}\n`;
      await fsWriteFile(sliceIdToAgentPath(sliceId), next, batch);
    } catch {
      // record loss means a marker may be re-processed — append-only docs
      // make that a duplicate dated entry, visible and non-fatal (§4.3 rule 2).
    }
  }

  return { ran: true, written, skipped };
}
