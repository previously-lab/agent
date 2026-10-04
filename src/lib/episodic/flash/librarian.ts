/**
 * Case writers + scribe — the document write path (v0.19 §A.2.3, §B.3, §B.6).
 *
 * THE CASE WRITER (边界 run ①, the old librarian re-shaped): invoked once per
 * closed slice, it judges FOR ITSELF whether anything is worth writing — an
 * empty run is a legal outcome (强制触发 ≠ 强制变异; axiom D: no semantic
 * gates). Tags are dead (R2): "which cases did this slice touch" is the
 * WRITER'S OWN judgment over the case manifest — writer-is-reader is
 * structural (§A.2.3): engineering assembles the listTree manifest into the
 * prompt, the writer reads the current text of the cases it judges relevant
 * via the readCase tool, then returns write-intents that engineering applies
 * through the five case ops (§B.3) under the per-case lock. It has no write
 * tools — the old "blind description" disease cannot recur.
 *
 * THE SCRIBE (书记段序 7, §A.2.2): picks up the structured one-line markers
 * the reply segment drops into the slice's agent.md and writes them into
 * cases: tasks/<名> (date-anchored), research/<名> (sediment), or the five
 * entity categories. A processed marker gets a `[doc-scribe]` record line in
 * the same agent.md so a marker is never written twice.
 *
 * THE MARKER CONTRACT (owned by this module, §A.3.1): one line in agent.md,
 *   [doc-marker] {"v":1,"id":"<turnId>-<n>","kind":"sediment|task|question",
 *     "docType":"research|entity","entityKind":"event|person|object|place|org",
 *     "target":"<existing case ref 分类/case名, optional>","title":"...",
 *     "dateAnchor":"YYYY-MM-DD (task only)","note":"...","topics":["..."]}
 * `topics` is LEGACY (the strand layer is gone) — tolerated, ignored.
 * "question" markers are NOT the scribe's — they route to the research pass
 * (flash/doc-research.ts).
 *
 * Evidence-while-writing: the triggering slice id is stamped mechanically
 * into every landed body — the model can no more forget it than forge it.
 *
 * Never throws at the top level: every failure degrades to a skipped item in
 * the result, so the caller is never taken down by a document write.
 */
import { tool } from "ai";
import { z } from "zod";
import { runSubAgent } from "@/lib/agents/sub-agent-runner";
import { buildSubAgentSystem } from "@/lib/agents/prompts";
import type { ModelConfig } from "@/lib/models/registry";
import {
  CASE_CATEGORIES,
  appendTail,
  caseIndexPath,
  casePiecePath,
  closeDoc,
  createCase,
  createDoc,
  isCaseCategory,
  isValidCaseName,
  parseCaseDoc,
  parseCaseRef,
  resolveCaseRefPaths,
  rewriteBody,
  serializeCaseDoc,
  type CaseCategory,
} from "@/lib/docs";
import {
  fsReadFile,
  fsWriteFile,
  type WriteBatch,
} from "@/lib/episodic/io-helpers";
import { withSliceLock } from "@/lib/episodic/slice-mutex";
import { sliceIdToAgentPath } from "@/lib/episodic/manager";
import { readSlicePart, readSlicePartResolved } from "../paths";

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

/** Evidence-while-writing, mechanical: the triggering slice id rides every landed body. */
function stampEvidence(body: string, sliceId: string): string {
  return `${body.trim()}\n\n（证据切片：${sliceId}）`;
}

// ─── Markers: the agent.md mailbox (pure parsing, §A.3.1 — unchanged) ───────

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
  /** Optional existing case reference (分类/case名) this marker updates. */
  target: z.string().optional(),
  /** The case's name (命名纪律: specific enough that a scope change means a new case). */
  title: z.string().min(1),
  /** task only: the date anchor the user stated. */
  dateAnchor: z.string().optional(),
  /** What this is about — the reply segment's one-line note. */
  note: z.string().default(""),
  /** LEGACY (strands are gone) — tolerated, ignored by the case writers. */
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

// ─── The case write machinery (the five ops, §B.3) ─────────────────────────

/**
 * One validated write intent, in the writer's vocabulary. Engineering applies
 * it through the five pure ops under the per-case lock — the ops themselves
 * are the enforcement point for illegal transitions (rewriteBody on a sealed
 * doc, appendTail on a living one, open on an existing case all throw, loud
 * and visible).
 */
export type CaseWriteIntent =
  | { action: "open"; category: CaseCategory; caseName: string; body: string }
  | { action: "rewriteIndex"; category: CaseCategory; caseName: string; body: string }
  | { action: "appendTail"; category: CaseCategory; caseName: string; line: string }
  | { action: "addPiece"; category: CaseCategory; caseName: string; title: string; body: string }
  | { action: "close"; category: CaseCategory; caseName: string; note: string };

export interface CaseWriteOutcome {
  /** The repo-relative path written. */
  path: string;
  /** True when a new file was created (open / addPiece). */
  created: boolean;
}

/**
 * Apply one write intent: per-case lock (`doc:<分类>/<case名>`, §A.3.4), a
 * FRESH read of the case's index.md inside the lock, the pure op, serialize,
 * write through the batch-aware fs. Throws on every contract violation — the
 * caller records the refusal as a visible skip.
 */
export async function applyCaseWriteIntent(
  intent: CaseWriteIntent,
  date: string,
  batch?: WriteBatch,
): Promise<CaseWriteOutcome> {
  const { category, caseName } = intent;
  if (!isCaseCategory(category)) {
    throw new Error(`unknown category: ${JSON.stringify(category)}`);
  }
  if (!isValidCaseName(caseName)) {
    throw new Error(`illegal case name: ${JSON.stringify(caseName)}`);
  }
  const identity = `${category}/${caseName}`;
  const indexPath = caseIndexPath(category, caseName);

  return withSliceLock(`doc:${identity}`, async () => {
    let currentRaw: string | null = null;
    try {
      currentRaw = await fsReadFile(indexPath, batch, { fresh: true });
    } catch {
      currentRaw = null; // no index.md yet — the case does not exist (in this root)
    }
    const current =
      currentRaw === null
        ? null
        : parseCaseDoc(currentRaw, { category, caseName, fileName: "index.md" });

    switch (intent.action) {
      case "open": {
        if (current) {
          throw new Error(`case ${identity} already exists — use updateIndex / appendTail / addPiece`);
        }
        const doc = createCase({ category, caseName, opened: date, body: intent.body });
        await fsWriteFile(indexPath, serializeCaseDoc(doc), batch);
        return { path: indexPath, created: true };
      }
      case "rewriteIndex": {
        if (!current) throw new Error(`case ${identity} does not exist — open it first`);
        // Throws when sealed (sealed 正文 is frozen — the tail is writable).
        const next = rewriteBody(current, intent.body);
        await fsWriteFile(indexPath, serializeCaseDoc(next), batch);
        return { path: indexPath, created: false };
      }
      case "appendTail": {
        if (!current) throw new Error(`case ${identity} does not exist — open it first`);
        // Throws while 还在写 (drafts are rewritten, not annotated).
        const next = appendTail(current, { date, text: intent.line });
        await fsWriteFile(indexPath, serializeCaseDoc(next), batch);
        return { path: indexPath, created: false };
      }
      case "addPiece": {
        if (!current) throw new Error(`case ${identity} does not exist — open it first`);
        // buildPieceFileName inside createDoc throws on an illegal title.
        const doc = createDoc({ category, caseName, date, title: intent.title, body: intent.body });
        const piecePath = casePiecePath(category, caseName, doc.fileName);
        await fsWriteFile(piecePath, serializeCaseDoc(doc), batch);
        return { path: piecePath, created: true };
      }
      case "close": {
        if (!current) throw new Error(`case ${identity} does not exist — open it first`);
        // Throws when already sealed.
        const next = closeDoc(current, { date, note: intent.note });
        await fsWriteFile(indexPath, serializeCaseDoc(next), batch);
        return { path: indexPath, created: false };
      }
    }
  });
}

/**
 * The readCase read-tool every case writer gets: two-segment reference →
 * the current full text, or a visible dead-link line. Writer-is-reader is
 * structural — a writer reads a case before naming it in a write intent.
 */
export function makeCaseReadTool(batch?: WriteBatch) {
  return tool({
    description:
      "Read a case by its two-segment reference: '分类/case名' → the case's index.md; " +
      "'分类/case名/篇名' → one dated piece. Returns the full text, or a dead-link note.",
    inputSchema: z.object({ ref: z.string() }),
    execute: async ({ ref }: { ref: string }) => {
      const parsed = parseCaseRef(ref);
      if (!parsed) return `（无法解析的引用 "${ref}" — 应是 分类/case名[/篇名]）`;
      for (const path of resolveCaseRefPaths(parsed)) {
        try {
          return await fsReadFile(path, batch);
        } catch {
          continue;
        }
      }
      return `（死链：${ref} — 新根与旧根都未找到。先 listTree 看清单。）`;
    },
  });
}

/** The set of existing case identities (`分类/case名`) in a listTree manifest. */
export function caseIdentsOfManifest(tree: Record<string, string[]>): Set<string> {
  const idents = new Set<string>();
  for (const [top, paths] of Object.entries(tree)) {
    if (!isCaseCategory(top)) continue;
    for (const p of paths) {
      const segs = p.split("/");
      if (segs.length >= 2 && segs[1]) idents.add(`${top}/${segs[1]}`);
    }
  }
  return idents;
}

/** Render the manifest for a writer prompt: grouped paths, compactly. */
export function renderManifest(tree: Record<string, string[]>): string {
  const blocks = Object.entries(tree)
    .map(([top, paths]) => `### ${top}/\n${paths.join("\n")}`)
    .join("\n\n");
  return blocks || "（清单为空——记忆还没有任何 case）";
}

// ─── The case-writer pass (边界 run ①, the old librarian re-shaped) ────────

const caseWriterSchema = z.object({
  cases: z
    .array(
      z.object({
        action: z
          .enum(["skip", "open", "updateIndex", "appendTail", "addPiece", "close"])
          .describe(
            "skip: nothing worth writing (a legal, often correct answer). " +
            "open: create a NEW case (must not exist yet). " +
            "updateIndex: rewrite the 正文 of an EXISTING, still-being-written case (body = the new full understanding). " +
            "appendTail: one dated supplement line on a SEALED case. " +
            "addPiece: a dated piece inside the case. " +
            "close: seal the case (note = 去向说明).",
          ),
        category: z.enum(CASE_CATEGORIES),
        caseName: z.string().describe("The case name — legal: no 4-digit lead, no separators/traversal/edge whitespace."),
        /** open/updateIndex/addPiece: the 正文 (updateIndex = the WHOLE new body). */
        body: z.string().optional(),
        /** appendTail only. */
        line: z.string().optional(),
        /** addPiece only — the piece title (date is stamped mechanically). */
        title: z.string().optional(),
        /** close only — 封口/去向说明. */
        note: z.string().optional(),
      }),
    )
    .max(20),
  reasoning: z.string().describe("1-2 sentences for the developer log, incl. why cases were skipped."),
});

const CASE_WRITER_SYSTEM = buildSubAgentSystem(`You are the case writer of a personal memory system (v0.19). Memory is a tree of CASES — one directory per case under a closed category (people/ events/ things/ places/ orgs/ research/ hypotheses/ tasks/ self/), each with an index.md (what it is, where it stands) and dated pieces.

A conversation slice just closed. You are shown its content (excerpt) and the case manifest (the whole memory tree, paths only). Judge for yourself WHICH cases this slice touched — read the current text of the ones you consider via readCase BEFORE naming them in a write. You have no write tools: you return write-intents that engineering validates and applies.

## Task

Per case you judge touched:
- The case does not exist and this slice's content deserves a durable home → open (body = the index.md 正文: what it is, what this slice established).
- The case exists and is still being written → updateIndex: rewrite the 正文 with the case's CURRENT full understanding (this slice's news merged in). Drafts are rewritten whole, not appended.
- The case is sealed (closed date in the header) → appendTail: ONE dated line (说得完时) or addPiece (自成一篇时).
- A research/question case reached its conclusion → close (note = 去向/结论).
- Nothing worth writing → skip. Skipping EVERYTHING is a legal, often correct outcome: restraint is the default, a case is long-term memory, not a chat log.

## Rules

1. Ground every write in the slice excerpt and what you actually read (readCase). No speculation, no boilerplate.
2. Prose, in the user's language. No date bookkeeping — dates and evidence slice ids are stamped mechanically.
3. Names are permanent: a case name is born fixed. Content beyond a case's scope → open a NEW case (and say so in reasoning), never stretch a name.
4. updateIndex replaces the whole 正文 of a living draft; sealed cases only grow via appendTail/addPiece. Never restate history a case already carries — fold it in silently.

## Output

Call \`caseWriterOutput\` with one decision per case + a short reasoning note.`);

export interface CaseWriterManifest {
  truncated: boolean;
  tree: Record<string, string[]>;
}

export interface LibrarianPassInput {
  model: ModelConfig;
  closedSliceId: string;
  excerpt: SliceExcerpt;
  /**
   * The listTree manifest — the writer reads it to judge what this slice
   * touched. Optional at the seam: a caller that has not wired the manifest
   * yet gets an empty tree (the writer then knows only what readCase tells
   * it — degraded but functional).
   */
  manifest?: CaseWriterManifest;
  /** User-local date (YYYY-MM-DD) stamping every write. */
  date: string;
  batch?: WriteBatch;
  /** @deprecated R3a: tags/strands are dead — the writer judges from the manifest. Ignored. */
  strands?: unknown;
  /** @deprecated R3a: strand merges died with the strand layer. Ignored. */
  merges?: unknown;
}

export interface LibrarianPassResult {
  /** @deprecated R3a: always [] (merge fallout died with the strand layer). */
  voided: string[];
  llmRan: boolean;
  written: string[];
  skipped: Array<{ name: string; reason: string }>;
}

/**
 * The case-writer pass (边界 run ①). The writer judges over the manifest +
 * its own readCase reads which cases the closed slice touched; engineering
 * applies the returned intents through the five ops under the per-case lock.
 * Never throws.
 */
export async function runLibrarianPass(
  input: LibrarianPassInput,
): Promise<LibrarianPassResult> {
  const { model, closedSliceId, excerpt, date, batch } = input;
  const manifest = input.manifest ?? { truncated: false, tree: {} };
  const skipped: Array<{ name: string; reason: string }> = [];
  const existing = caseIdentsOfManifest(manifest.tree);

  const prompt = `## 刚关闭的切片 ${closedSliceId}

focus: ${excerpt.focus || "（无）"}
summary: ${excerpt.summary || "（无）"}

${excerpt.turnsExcerpt || "（无对话摘录）"}

## case 清单（listTree 全树；判断"这一片碰到哪些 case"是你的工作——用 readCase 读你要写的 case 现状）

${renderManifest(manifest.tree)}
${manifest.truncated ? "\n（清单可能被截断——缺失的 case 以 readCase 的死链为准）\n" : ""}
按指示给出每个 case 的决定。`;

  const result = await runSubAgent({
    model,
    system: CASE_WRITER_SYSTEM,
    prompt,
    temperature: 0,
    maxSteps: 50,
    timeoutMs: 30_000,
    tools: {
      readCase: makeCaseReadTool(batch),
      caseWriterOutput: tool({
        description: "Report the per-case write decisions.",
        inputSchema: caseWriterSchema,
      }),
    },
    toolChoice: "required",
    reportToolName: "caseWriterOutput",
    reportSchema: caseWriterSchema,
    progress: { toolName: "librarian" },
  });
  if (!result.ok || !result.report) {
    return {
      voided: [],
      llmRan: true,
      written: [],
      skipped: [...skipped, { name: "*", reason: result.error ?? "no case-writer report" }],
    };
  }

  const written: string[] = [];
  for (const op of result.report.cases) {
    if (op.action === "skip") continue;
    const identity = `${op.category}/${op.caseName}`;
    // Read-before-write, structural: updating a case that is not in the
    // manifest means the writer never saw its current state.
    if (op.action !== "open" && !existing.has(identity)) {
      skipped.push({ name: identity, reason: "case not in the manifest — readCase it first (dead link?)" });
      continue;
    }
    if (op.action === "open" && existing.has(identity)) {
      skipped.push({ name: identity, reason: "case already exists — use updateIndex / appendTail / addPiece" });
      continue;
    }
    try {
      let intent: CaseWriteIntent;
      switch (op.action) {
        case "open":
          if (!op.body?.trim()) throw new Error("open requires a body (the index.md 正文)");
          intent = { action: "open", category: op.category, caseName: op.caseName, body: stampEvidence(op.body, closedSliceId) };
          break;
        case "updateIndex":
          if (!op.body?.trim()) throw new Error("updateIndex requires a body (the WHOLE new 正文)");
          intent = { action: "rewriteIndex", category: op.category, caseName: op.caseName, body: stampEvidence(op.body, closedSliceId) };
          break;
        case "appendTail":
          if (!op.line?.trim()) throw new Error("appendTail requires a line");
          intent = { action: "appendTail", category: op.category, caseName: op.caseName, line: `${op.line.trim()}（证据切片：${closedSliceId}）` };
          break;
        case "addPiece":
          if (!op.title?.trim() || !op.body?.trim()) {
            throw new Error("addPiece requires a title and a body");
          }
          intent = { action: "addPiece", category: op.category, caseName: op.caseName, title: op.title.trim(), body: stampEvidence(op.body, closedSliceId) };
          break;
        case "close":
          if (!op.note?.trim()) throw new Error("close requires a note (去向说明)");
          intent = { action: "close", category: op.category, caseName: op.caseName, note: op.note.trim() };
          break;
      }
      const applied = await applyCaseWriteIntent(intent, date, batch);
      written.push(applied.path.replace(/^memory\//, ""));
    } catch (e) {
      skipped.push({ name: identity, reason: e instanceof Error ? e.message : String(e) });
    }
  }

  return { voided: [], llmRan: true, written, skipped };
}

// ─── The scribe pass (书记段序 7) ──────────────────────────────────────────

const scribeSchema = z.object({
  entries: z
    .array(
      z.object({
        id: z.string().describe("The marker id this entry answers."),
        /** The case's new full 正文 (open/updateIndex) or ONE tail line (sealed case). */
        body: z.string().describe("The prose, grounded in the slice excerpt and the marker note."),
      }),
    )
    .max(20),
  reasoning: z.string().describe("1-2 sentences for the developer log."),
});

const SCRIBE_SYSTEM = buildSubAgentSystem(`You are the scribe of a personal memory system. A conversation slice left MARKERS — one-line notes the reply segment dropped when it judged something worth sedimenting (something to keep, a task the user stated). Your job: write each marker into its CASE.

You are shown: the slice excerpt, and per marker the marker itself plus the CURRENT index.md of its target case when one exists. You have already read everything you may write about.

## Task

One entry per marker — the body is:
- a NEW case's opening 正文 (what it is, what this slice established — tasks state WHAT, the date anchor, background);
- or, for an EXISTING case still being written, its new full 正文 — the current understanding with this slice's news folded in (rewrite whole, do not append);
- or, for a SEALED case (closed date in the header), ONE dated supplement line.

## Rules

1. Ground every entry in the slice excerpt and the marker note. No invention.
2. Prose, in the user's language. No date bookkeeping — dates and evidence slice ids are stamped mechanically.
3. Never contradict shown existing text — fold the new fact in with its sense preserved.

## Output

Call \`scribeOutput\` with one entry per marker you wrote + a short reasoning note. Writing nothing for a marker leaves it for a later pass.`);

/** The v0.15 singular entityKind → the v0.19 category (§B.6). */
const ENTITY_CATEGORY: Record<string, CaseCategory> = {
  event: "events",
  person: "people",
  object: "things",
  place: "places",
  org: "orgs",
};

interface ScribeTarget {
  marker: DocMarker;
  category: CaseCategory;
  caseName: string;
  existed: boolean;
  currentText: string | null;
}

/**
 * Resolve a marker to its target case. Returns null (+reason) when the
 * marker cannot name a legal case — a scribe never writes an illegal name
 * (the slice-id namespace red line included).
 */
function resolveScribeTarget(
  marker: DocMarker,
): { category: CaseCategory; caseName: string } | { error: string } {
  const validate = (
    category: CaseCategory,
    rawName: string,
  ): { category: CaseCategory; caseName: string } | { error: string } => {
    const caseName = rawName.trim();
    if (!isValidCaseName(caseName)) {
      return { error: `illegal case name: ${JSON.stringify(rawName)}` };
    }
    return { category, caseName };
  };

  if (marker.kind === "task") return validate("tasks", marker.title);
  if (marker.kind !== "sediment") {
    return { error: `marker kind ${marker.kind} is not the scribe's` };
  }
  if (marker.docType === "entity") {
    if (!marker.entityKind) return { error: "entity sediment requires entityKind" };
    return validate(ENTITY_CATEGORY[marker.entityKind] ?? "things", marker.title);
  }
  if (marker.target) {
    const ref = parseCaseRef(marker.target);
    if (ref && ref.kind !== "legacy") {
      return validate(ref.category, ref.caseName);
    }
    return { error: `illegal target case: ${JSON.stringify(marker.target)}` };
  }
  return validate("research", marker.title);
}

export interface ScribePassInput {
  model: ModelConfig;
  /** The slice whose agent.md is the mailbox (closed slice at a boundary, else the active one). */
  sliceId: string;
  excerpt: SliceExcerpt;
  /** User-local date (YYYY-MM-DD) stamping every write. */
  date: string;
  batch?: WriteBatch;
  /** @deprecated R3a: strands are dead — 名录 died with the topic homes. Ignored. */
  strands?: unknown;
}

export interface ScribePassResult {
  ran: boolean;
  written: string[];
  skipped: Array<{ id: string; reason: string }>;
}

/**
 * The scribe pass: read the slice's agent.md, pick up unprocessed
 * sediment/task markers, write their cases (read-before-write under the
 * per-case lock, via the five ops), and record each processed marker back
 * into the same agent.md. Never throws.
 */
export async function runScribePass(input: ScribePassInput): Promise<ScribePassResult> {
  const { model, sliceId, excerpt, date, batch } = input;
  const skipped: Array<{ id: string; reason: string }> = [];

  let agentMd: string;
  try {
    // Dual-root read (v0.19 R2): the mailbox of a slice created before the
    // root move lives under the legacy slices root.
    agentMd = await readSlicePart(sliceId, "agent", batch);
  } catch {
    return { ran: false, written: [], skipped }; // no agent.md yet — nothing to pick up
  }

  const processed = extractProcessedMarkerIds(agentMd, SCRIBE_RECORD_PREFIX);
  const todo = extractDocMarkers(agentMd).filter(
    (m) => (m.kind === "sediment" || m.kind === "task") && !processed.has(m.id),
  );
  if (todo.length === 0) return { ran: false, written: [], skipped };

  // Resolve targets + pre-read the current cases (writer-is-reader).
  const targets: ScribeTarget[] = [];
  for (const marker of todo) {
    const resolved = resolveScribeTarget(marker);
    if ("error" in resolved) {
      skipped.push({ id: marker.id, reason: resolved.error });
      continue;
    }
    let currentText: string | null = null;
    try {
      currentText = await fsReadFile(
        caseIndexPath(resolved.category, resolved.caseName),
        batch,
        { fresh: true },
      );
    } catch {
      currentText = null; // does not exist yet — will be opened
    }
    targets.push({
      marker,
      category: resolved.category,
      caseName: resolved.caseName,
      existed: currentText !== null,
      currentText,
    });
  }
  if (targets.length === 0) return { ran: false, written: [], skipped };

  const markerBlocks = targets
    .map(({ marker, category, caseName, existed, currentText }) => {
      const head =
        `### marker ${marker.id}（kind=${marker.kind}${marker.docType ? `/${marker.docType}` : ""}` +
        `${marker.entityKind ? `/${marker.entityKind}` : ""}）\n` +
        `title: ${marker.title}\nnote: ${marker.note || "（无）"}` +
        `${marker.dateAnchor ? `\n日期锚: ${marker.dateAnchor}` : ""}\n` +
        `目标 case: ${category}/${caseName}（${existed ? "已存在，index.md 全文如下" : "将开设"}）`;
      return currentText ? `${head}\n\n${currentText.trim()}` : head;
    })
    .join("\n\n");

  const prompt = `## 切片 ${sliceId}

focus: ${excerpt.focus || "（无）"}
summary: ${excerpt.summary || "（无）"}

${excerpt.turnsExcerpt || "（无对话摘录）"}

## 待落笔的标记（写前已读目标 case）

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
        description: "Report the per-marker case entries.",
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
    const { marker, category, caseName } = target;
    // The task's date anchor is a mechanical fact — it rides the entry
    // whether the prose remembers it or not.
    const anchorLine =
      marker.kind === "task" && marker.dateAnchor
        ? `日期锚：${marker.dateAnchor}\n\n`
        : "";
    const stamped = stampEvidence(anchorLine + body, sliceId);
    try {
      let intent: CaseWriteIntent;
      if (!target.existed) {
        intent = { action: "open", category, caseName, body: stamped };
      } else {
        const current = parseCaseDoc(target.currentText ?? "", {
          category,
          caseName,
          fileName: "index.md",
        });
        intent = current.closed
          ? { action: "appendTail", category, caseName, line: stamped }
          : { action: "rewriteIndex", category, caseName, body: stamped };
      }
      const applied = await applyCaseWriteIntent(intent, date, batch);
      written.push(applied.path.replace(/^memory\//, ""));
      recordLines.push(
        `${SCRIBE_RECORD_PREFIX} {"id":${JSON.stringify(entry.id)},"doc":${JSON.stringify(`${category}/${caseName}`)}}`,
      );
    } catch (e) {
      skipped.push({ id: entry.id, reason: e instanceof Error ? e.message : String(e) });
    }
  }

  // The mailbox bookkeeping: processed markers get a record line in the SAME
  // agent.md, so the next pass (any stream) never double-writes them.
  if (recordLines.length > 0) {
    try {
      // Dual-root read (the slice may predate the root move), and the record
      // append goes back to the root the mailbox was actually read from —
      // splitting markers (legacy) from records (new) would re-process every
      // marker on the next pass.
      const resolved = await readSlicePartResolved(sliceId, "agent", batch).catch(() => null);
      const fresh = resolved?.content ?? "";
      const next = fresh.trimEnd()
        ? `${fresh.trimEnd()}\n\n${recordLines.join("\n")}\n`
        : `${recordLines.join("\n")}\n`;
      await fsWriteFile(resolved?.path ?? sliceIdToAgentPath(sliceId), next, batch);
    } catch {
      // record loss means a marker may be re-processed — the case tail is
      // append-only, so that is a duplicate dated line: visible, non-fatal.
    }
  }

  return { ran: true, written, skipped };
}
