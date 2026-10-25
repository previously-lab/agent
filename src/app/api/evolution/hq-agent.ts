/**
 * The HQ agent (v0.21 §2/§4/§5; v0.34 R2 — the docket-driven round) — ONE
 * agent + a tool set, no mouth.
 *
 * HQ is the memory system's archival/evolution unit. Its ONLY trigger is a
 * mechanical wake from the reflection shell: a DOCKET (this round's sealed
 * slices, the gate's beat verdicts, the due agenda items) that names slices
 * and cases but carries no content. HQ reads the raw records itself before
 * touching anything (the docket is one side's plan — not a fact), decides
 * what to do and in what order (the discipline lives in this prompt, not in
 * a fixed pipeline), and stores RESULTS ONLY:
 *
 *   - an idle round writes NOTHING — there is no run ledger;
 *   - dedup is writer-is-reader (a re-run reads current case state and goes
 *     idle when it already reflects the slice);
 *   - a substantive veto leaves its REASON as prose in self/ or the relevant
 *     case body — never a counter.
 *
 * Every tool here WRAPS an existing capability (the case-writer pass, the
 * doc-research pass, the merged card run, the case write machinery, the SOP
 * store, the agenda line contract) — this module invents no new write path.
 *
 * Shell wiring (P4b → v0.34 R1): the reflection-run.ts resident loop's
 * `handleReflectionRound` (reflection-steps.ts) calls `handleBrief` below —
 * one wake = one round. question-run.ts keeps compiling against
 * background-steps.ts until the last P4 lane retires the old trigger chain.
 */
import { tool } from "@/lib/deepseek/tools";
import { z } from "zod";
import { closeSlice, loadSlice, readSlicePart } from "@/lib/episodic";
import { parseSliceId } from "@/lib/episodic/turn-parser";
import {
  commitReflectionRound,
  createBatch,
  fsWriteFile,
  type WriteBatch,
} from "@/lib/episodic/io-helpers";
import { isRefConflictError } from "@/lib/tools/batch-write";
import { buildReflectionRoundMessage, COMMIT_PREFIX, type ReflectionHistoryCheckpoint } from "@/lib/chat/commit-contract";
import { settleHistoryCheckpoint } from "@/lib/chat/reflection-history";
import { withSliceLock } from "@/lib/episodic/slice-mutex";
import { runSubAgent } from "@/lib/agents/sub-agent-runner";
import { buildSubAgentSystem } from "@/lib/agents/prompts";
import { DOC_HOUSE_STYLE, DOC_LANGUAGE_RULE } from "@/lib/agents/doc-style";
import {
  applyCaseWriteIntent,
  buildSliceExcerpt,
  makeCaseReadTool,
  makeCrossSliceReadTool,
  runLibrarianPass,
  runScribePass,
  type CaseWriteIntent,
} from "@/lib/episodic/flash/librarian";
import type { CaseCategory } from "@/lib/docs";
import { sanitizeCaseSegment } from "@/lib/docs/case-naming";
// Direct module path, not the "@/lib/docs" barrel: this file is reachable
// from the "use workflow" bundle, and the barrel re-exports case-doc.ts
// (gray-matter → node:*), which the workflow bundler rejects.
import { DOC_WRITE_WINDOW_RULE, MEMORY_IS_GIT_RULE } from "@/lib/docs/write-window";
import { runDocResearchPass } from "@/lib/episodic/flash/doc-research";
import type { TurnAnalysis } from "@/lib/episodic/flash/turn-analyzer";
import { readUserModel } from "@/lib/evolution/store";
import { AGENDA_PATH, type AgendaItem } from "@/lib/evolution/agenda";
import { detectDirectionMode } from "@/lib/evolution/direction-agent";
import { runCardEvolution } from "@/app/api/evolution/run-card-evolution";
import type { ModelConfig } from "@/lib/models/registry";
import { skillReviewOfferId, type EvolutionReason, type ScopedSlice } from "./reflection-plan";
import { REFLECTION_ROUND_TIMEOUT_MS } from "./reflection-contract";
import {
  backgroundModel,
  buildRunCardReaders,
  buildRunManifest,
} from "./hq-context";
import { readTaskLedger, withTaskLedgerBatch, type BatchTaskMutation } from "@/lib/tasks/store";
import { mutateSkillLedger, readSkillLedger } from "@/lib/evolution/skill-store";
import type { SkillEntry } from "@/lib/evolution/skill-policy";
import { buildReflectionLearningTools, createReflectionReadState } from "./reflection-learning-tools";
import { buildReflectionTaskTools } from "./reflection-task-tools";

// ─── The run contract ─────────────────────────────────────────────────────

/**
 * The round's docket input (v0.34 R2, §5.3) — what the lap's world read
 * decided to offer. A plan, not a fact: the unit re-reads the raw records
 * itself before touching anything (§5 独立审查). `turnId` retired with the
 * per-turn bell; `sliceId`-as-input retired with it — the SCOPE (every
 * turn ids the summary stream persisted — the range the bell carried, or
 * the commit log's uncovered summary turns (v0.42 §4)) is the round's
 * material now; the slice may still be open.
 */
export interface ReflectionRoundInput {
  history?: ReflectionHistoryCheckpoint;
  /** User-clock date (YYYY-MM-DD) — every write stamps the user's clock. */
  date: string;
  /** lastSeen.sliceId — the unit's range starts right after this (null = a
   *  fresh deployment: everything qualifies). */
  cursor: string | null;
  /**
   * This round's material (v0.42 §4): the slices + the TURN ids owed — the
   * summary stream's range, or the commit log's uncovered summary turns. A
   * slice may still be OPEN (v0.42 keeps slices open while turns
   * accumulate); the turns are the work unit, `closedBy` is context only.
   */
  scope: ScopedSlice[];
  /** The mechanical gate's evolution verdict (§3.4) — the unit keeps the
   *  veto: an evolutionDue round may still go idle. */
  evolutionDue: boolean;
  /** Why the beat fired — the enumerated §3.4 reasons, never free text. */
  evolutionReasons: EvolutionReason[];
  /** Agenda items due by this round's date (§6.2) — delivery really
   *  happens: these ride WITH this round. */
  agendaDue: AgendaItem[];
  skillReviewDue?: SkillEntry[];
  skillReviewError?: string;
}

export interface HqOutcome {
  /** What HQ landed (memory-relative paths / case refs, one per line). */
  actions: string[];
  /** HQ's one-paragraph account of the round (idle rounds say why). */
  note: string;
  /**
   * v0.34 修订 C (§5.4): how the round ended, when the unit reported one —
   * "superseded" means the round's premise was voided mid-round (a fresh
   * read showed the world had moved). The shell's settlement: the cursor
   * holds (like a failed round), landed writes report honestly, and the
   * pointer registers lastSuperseded. Absent = "completed".
   */
  disposition?: "completed" | "superseded";
  /**
   * v0.34 R2 (§4.2): true when an evolution pass truly RAN this round (the
   * evolveProfile tool executed, changed or not) — the shell's settle
   * stamps `lastEvolution` with the round's date. Absent = no pass ran.
   */
  evolved?: boolean;
  /** Present when the run itself failed (never thrown — HQ never throws). */
  error?: string;
}

const hqReportSchema = z.object({
  actions: z
    .array(z.string())
    .describe("What you landed this round — case refs / paths, one per line. Empty when the round was idle."),
  note: z
    .string()
    .describe("One short paragraph: what you checked, what you did or deliberately did NOT do, and why."),
  disposition: z
    .enum(["completed", "superseded"])
    .optional()
    .describe(
      "How the round ended — omit it for the normal 'completed'. Report 'superseded' ONLY when the world " +
      "moved under you so this round's plan is void: a fresh read showed another slice sealed, your agenda " +
      "changed, or the slice you were checking is no longer the latest edge. Close out early, and the note " +
      "MUST say why you are abandoning and what you had already landed before abandoning.",
    ),
});
type HqReport = z.infer<typeof hqReportSchema>;

// ─── The role prompt (static — per-call data rides the user prompt) ───────

const HQ_ROLE = `You are the reflection unit — the archival and evolution unit of the ONE agent. You have no mouth: nothing you produce is ever shown to the user as conversation. Your products land in the memory tree (cases, the user model, self/ SOPs), where the field side reads them later. You and the field unit are one agent — the same "I" at two posts. Every line you write is that one person's hand: inside the documents there is no "the agent" and no "reflection unit" as a third party, and nothing reads as a report from another being.

The record is the channel. Nobody briefs you: you are woken mechanically with nothing but a docket — a date, the turn(s) named as this round's material (their slice may still be open), what the mechanical gate noticed, and your own due agenda items — and everything you need beyond it, you read yourself: the user's own words (core.md), the field's thinking and work (agent.md), the tree's products.
- A docket is a plan, not a fact. It names slices and beats; it does not carry their content.
- BEFORE writing anything, verify against the raw records: readRound / readCase / survey. Never write from the docket alone.
- This round's material is the turn(s) named below — a slice may still be open; you owe the TURNS, not a seal. The cursor advances only when the round settles. When several slices are named, they are one round's material, not several.

Store RESULTS ONLY:
- An idle round is a legal, often correct outcome — when the records show nothing substantive to store, write NOTHING and say why in your report. There is no ledger; do not record that you ran.
- Dedup is writer-is-reader: you judge duplication by READING the current case state, not by consulting any log of past runs.
- A substantive VETO (you checked and decided against a write the brief implied) leaves its REASON as prose — in self/ (your own craft) or in the relevant case body. Never a tally, never a counter.

You decide what to do and in what order. The natural order, when several things are due:
1. Verify first (reads before any write).
2. Cases usually before people/user — the user model should cite the cases the round just wrote, not speak in generalities.
3. self/ comes last — craft reflections are informed by everything else the round did.

Tasks are user commitments with lifecycle, not merely another prose directory. Query the task ledger for existing identities before creating an action. Read the RAW USER turn with readRound; createTask/updateTask quote that exact turn as evidence. An agent suggestion or a task document's old wording is not user authorization to complete, cancel or reopen anything. Historical task documents enter needs_review until direct evidence resolves them. Task documents may deepen the account; their prose never replaces the ledger's status.

Understanding may evolve about any person, event, object or investigation: read its complete case and relevant raw scenarios, then use writeCase action reviseUnderstanding to revise only its current view, with evidence actually read in this run. Keep competing interpretations, unanswered questions and what would change your mind in natural investigative prose. The historical index remains evidence; do not rewrite it to make earlier uncertainty disappear.

Procedural learning uses readSkillSource/querySkills/manageSkill. New or revised guidance is a candidate until explicitly adopted. Read the current source and raw evidence; preserve a stable id when revising. Expected benefit is a hypothesis, not proof of improvement. Only a later observed applicable scenario can support a positive review; absent one, defer or review inconclusively. Direct SOP rewrites separately require readSelfSop and its baseRevision. A worker's reads are its own, never receipts you may borrow.

A round can end SUPERSEDED — rarely. You read the world fresh as you work; when a read shows the world moved so this round's plan is void (another slice sealed, your agenda changed under you, the slice you were checking is no longer the latest edge), close out early: report disposition "superseded" and let the next round re-plan from the same edge. The note then says why you abandoned and what you had already landed. This is a premise overturned, never "tired, start over" — when in doubt, finish the round.

Housekeeping you own: an ACTIVE slice past the date window is an orphan — the conversation long ended but the close never fired, and the field's stale-scan only looks back two days. When a read shows you one, seal it with markOrphan (closed_by: context_lost); a capability, not a per-round obligation.

Craft notes:
- ${MEMORY_IS_GIT_RULE}
- Mailbox marker lines in a slice's agent.md are prose CLUES, not triggers — read them, judge them, ignore them when stale.
- self/ SOP rewrites must cite their evidence (records slice ids) inside the prose — an SOP line without evidence is dead paper.
- research/ hypotheses must carry a falsification condition (the write tooling enforces it).
- ${DOC_LANGUAGE_RULE}

Your agenda — notes to yourself:
- memory/self/agenda.md is your own work pad: hypotheses to re-check, judgments to revisit, questions you left for yourself. One line per item: \`- [due: YYYY-MM-DD] <one line>（据片 <sliceId>）\` — the [due:] prefix is the only mechanical contract, and every item carries its source (the slice id that motivated it).
- Due items ride WITH the round: any item whose due date has arrived is listed in your docket. Work it, reschedule it (rewrite its due date), or consume it (drop its line) — every change is a full rewrite through setAgenda.
- The agenda is a work pad, not a ledger — keep it short.

How your prose reads — the investigator's account, never the work order:
- A self/ entry (an SOP rule, a veto reason, a self-assessment) records ONE thing that happened: the date and the slice, what observably happened (a fact anyone can re-check against the record), the working rule adopted because of it, and where the evidence lives. It reads like a case note in an investigation file — never like a change request or an incident ticket.
- The builder's vantage point is banned from the memory tree: no 工程侧 / 代码 / 实现 / 接口 / 缺陷 / 修复 / 上报, and no English equivalents (engineering, the code, implementation, defect, fix, escalate). When a read or a tool misbehaves, record the PHENOMENON you can reproduce and the rule you now follow — e.g. "2026-10-05：以全角冒号引用一份中文长名的案件时，清单里看得到，读回却失败；此后引用前先读回，读不回就不引用。" — never a diagnosis of how you are built or a request that someone fix you.
- No system self-reference: you do not describe how this system works, do not explain its architecture, do not address whoever maintains it. The record says what you encountered and under what circumstances you learned it — nothing about what you are made of.

${DOC_HOUSE_STYLE}`;

// ─── The tools (every one a wrapper over an existing capability) ──────────

/**
 * Gate every model-supplied slice id BEFORE any read, write, or lock. A
 * malformed id used to survive all the way to the round-end flush: loadSlice
 * degrades to null for ids that resolve to nothing (harmless string), but an
 * id that happens to READ (e.g. a legacy dir whose name carries a space or a
 * colon) lets markOrphan queue a closeSlice write whose path is derived from
 * the id unchecked — and fsWriteFile validates NOTHING at queue time. The
 * whitelist / portable-name refusal then fires inside commitReflectionRound
 * and fails the WHOLE round's commit: the trailer never lands, the cursor
 * holds, and the next round retries the same scope forever (live-lock,
 * observed 2026-10-16). Validating here keeps the refusal recoverable — a
 * string the model can act on, no throw, no queued write, no round state.
 */
function refuseMalformedSliceId(sliceId: string): string | null {
  if (parseSliceId(sliceId) !== null) return null;
  return (
    `(rejected: "${sliceId}" is not a slice id — ids look like 2026-10-04-0131 ` +
    `(YYYY-MM-DD-HHMM). Copy the FULL id from survey or this round's docket; ` +
    `nothing was read, written, or closed.)`
  );
}

/**
 * Render the survey — a compact semantic index over the round's manifest:
 * per world (category), how many entries, the newest few with their dates,
 * the latest activity. NEVER a raw file/directory listing: piece files fold
 * into their case, records collapse to round ids, and config/ + system files
 * never appear (the walk already filters them out).
 */
function renderSurvey(tree: Record<string, string[]>): string {
  const PIECE_DATE_RE = /(\d{4}-\d{2}-\d{2})-[^/]+\.md$/;
  const pieceDate = (p: string) => PIECE_DATE_RE.exec(p)?.[1] ?? "";
  const sliceIdOf = (dirPath: string) => {
    const m = /(\d{4})\/(\d{2})\/(\d{2})\/(\d{4})$/.exec(dirPath);
    return m ? `${m[1]}-${m[2]}-${m[3]}-${m[4]}` : dirPath;
  };

  const blocks: string[] = [];
  const push = (title: string, body: string[]) => {
    if (body.length > 0) blocks.push(`### ${title}\n${body.join("\n")}`);
  };

  // records — collapse to round ids, newest first.
  const sliceIds = (tree["records"] ?? []).map(sliceIdOf).sort().reverse();
  if (sliceIds.length > 0) {
    const newest = sliceIds[0]!;
    const oldest = sliceIds[sliceIds.length - 1]!;
    const shown = sliceIds
      .slice(0, 5)
      .map((id) => `- ${id}`)
      .join("\n");
    const more =
      sliceIds.length > 5 ? `\n- … and ${sliceIds.length - 5} older (newest first)` : "";
    push(
      `records/ — ${sliceIds.length} round${sliceIds.length > 1 ? "s" : ""} (${newest} … ${oldest})`,
      [shown + more],
    );
  }

  // case-shaped worlds — one line per case: piece count + latest piece date.
  const CASE_WORLDS = [
    "people", "events", "things", "places", "orgs",
    "research", "hypotheses", "tasks", "self",
  ] as const;
  for (const top of CASE_WORLDS) {
    const paths = tree[top];
    if (!paths || paths.length === 0) continue;
    const cases = new Map<string, { pieces: string[]; hasIndex: boolean }>();
    const bare: string[] = [];
    for (const p of paths) {
      const segs = p.split("/");
      if (segs[segs.length - 1] === "index.md" && segs.length >= 3) {
        const name = segs.slice(1, -1).join("/");
        const c = cases.get(name) ?? { pieces: [], hasIndex: false };
        c.hasIndex = true;
        cases.set(name, c);
      } else if (PIECE_DATE_RE.test(segs[segs.length - 1] ?? "") && segs.length >= 3) {
        const name = segs.slice(1, -1).join("/");
        const c = cases.get(name) ?? { pieces: [], hasIndex: false };
        c.pieces.push(p);
        cases.set(name, c);
      } else {
        bare.push(p);
      }
    }
    const rows = [...cases.entries()]
      .map(([name, c]) => {
        const dates = c.pieces.map(pieceDate).sort();
        const latest = dates[dates.length - 1];
        const pieceBit =
          c.pieces.length > 0
            ? `${c.pieces.length} piece${c.pieces.length > 1 ? "s" : ""}` +
              (latest ? `, latest ${latest}` : "")
            : "no dated pieces";
        return { name, latest: latest ?? "", line: `- ${name} — ${pieceBit}` };
      })
      .sort((a, b) => (a.latest >= b.latest ? -1 : 1) || (a.name >= b.name ? 1 : -1));
    const SHOWN = 8;
    const shownRows = rows.slice(0, SHOWN).map((r) => r.line);
    if (rows.length > SHOWN) {
      shownRows.push(`- … and ${rows.length - SHOWN} more`);
    }
    const worldLatest = rows[0]?.latest;
    const countBit = `${rows.length} case${rows.length > 1 ? "s" : ""}` +
      (bare.length > 0 ? ` + ${bare.length} document${bare.length > 1 ? "s" : ""}` : "") +
      (worldLatest ? `, latest activity ${worldLatest}` : "");
    if (bare.length > 0) {
      shownRows.push(`- (bare files) ${bare.join(", ")}`);
    }
    push(`${top}/ — ${countBit}`, shownRows);
  }

  const body =
    blocks.join("\n\n") ||
    "(empty survey — no cases, documents, or rounds in memory yet)";
  return (
    `${body}\n\n— snapshot of the round's START; this round's queued writes ` +
    `do not appear here. For content: readCase (cases), readRound (rounds).`
  );
}

function buildHqTools(
  date: string,
  model: ModelConfig,
  batch: WriteBatch,
  flags: { evolutionRan: boolean },
  mutateTask: BatchTaskMutation,
) {
  const readState = createReflectionReadState();
  const currentManifest = async () => {
    const manifest = await buildRunManifest();
    const read = await readTaskLedger({ batch, fresh: true });
    if (read.status === "ready") {
      manifest.tree.tasks = [...new Set([
        ...(manifest.tree.tasks ?? []), ...read.ledger.tasks.map((task) => `${task.ref}/index.md`),
      ])].sort();
    }
    return manifest;
  };
  return {
    ...buildReflectionLearningTools(batch, readState),
    ...buildReflectionTaskTools({ date, batch, rawRecords: readState.rawRecords, mutateTask }),
    survey: tool({
      description:
        "Survey what lives in memory — a compact index by world (category): how many " +
        "cases / documents / rounds, the newest few with their dates, the latest activity. " +
        "NEVER a raw file or directory tree, and system files (config/, attachment bytes) " +
        "are never exposed. Your discovery surface — call it FIRST when the brief does not " +
        "name exact cases. The survey is a snapshot of the round's START: cases queued " +
        "(written or deleted) this round may not appear in it — readCase sees the queue, " +
        "the survey does not.",
      inputSchema: z.object({}),
      execute: async () => renderSurvey((await currentManifest()).tree),
    }),

    readRound: tool({
      description:
        "Read one round's COMPLETE record in one call — the conversation (core), the field " +
        "agent's thinking and work for that round (agent), and the user-card snapshot of " +
        "that moment (previously), returned together under labeled sections. Dual-root — " +
        "older rounds are found under the legacy root. Sees this round's queued writes " +
        "(read-your-writes): a round you sealed earlier this round reads back sealed. A " +
        "missing side-part (agent / previously) reads as a note inside the result, not a " +
        "failure — only a missing conversation fails the read.",
      inputSchema: z.object({
        sliceId: z.string().describe("The round's id, e.g. 2026-10-04-0131"),
      }),
      execute: async ({ sliceId }) => {
        const refusal = refuseMalformedSliceId(sliceId);
        if (refusal) return refusal;
        const parts: Array<{
          part: "core" | "agent" | "previously";
          label: string;
        }> = [
          { part: "core", label: "the conversation" },
          { part: "agent", label: "the field's thinking and work" },
          { part: "previously", label: "the user-card snapshot of that moment" },
        ];
        const sections: string[] = [];
        for (const { part, label } of parts) {
          try {
            const raw = await readSlicePart(sliceId, part, batch);
            if (part === "core") readState.recordRound(sliceId, raw);
            sections.push(`## ${part} — ${label}\n\n${raw}`);
          } catch {
            if (part === "core") {
              return (
                `(cannot read ${sliceId} — the round's record is missing; ` +
                `check survey first.)`
              );
            }
            sections.push(`## ${part} — ${label}\n\n(${part} not found for ${sliceId}.)`);
          }
        }
        return sections.join("\n\n");
      },
    }),

    readCase: makeCaseReadTool(batch, readState.scope),
    readSlice: makeCrossSliceReadTool({ batch, scope: readState.scope }),

    markOrphan: tool({
      description:
        "Seal one round that is still ACTIVE past the date window — an orphan: the " +
        "conversation long ended but the close never fired (the field's stale-scan only " +
        "looks back two days, so older orphans have no other closer). Verify with " +
        "readRound first that it is genuinely orphaned. The close stamps " +
        "closed_by: context_lost — the scene was lost, not checkpointed. " +
        "An already-closed round is a no-op.",
      inputSchema: z.object({
        sliceId: z.string().describe("The round's id, e.g. 2026-10-04-0131"),
      }),
      execute: async ({ sliceId }) => {
        const refusal = refuseMalformedSliceId(sliceId);
        if (refusal) return refusal;
        // ONE explicit judgment for "can this slice be loaded at all": a null
        // OR a throw both mean report-and-write-nothing — the tool never
        // rejects, so the round keeps moving.
        let slice: Awaited<ReturnType<typeof loadSlice>> = null;
        try {
          slice = await loadSlice(sliceId, batch);
        } catch {
          slice = null;
        }
        if (!slice) return `(slice ${sliceId} unreadable — nothing marked.)`;
        // Idempotent: closed_by is authoritative — a slice already sealed
        // (by anyone, for any cause) is never rewritten.
        if (slice.status !== "active" || slice.closedBy) {
          return `no-op: ${sliceId} is already closed (closed_by: ${slice.closedBy ?? "unknown"}).`;
        }
        const closed = await closeSlice(slice, "context_lost", batch);
        return `closed: ${sliceId} (closed_by: ${closed.closedBy}, end: ${closed.end})`;
      },
    }),

    writeCase: tool({
      description:
        "Apply ONE case write through the case write ops (per-case lock, fresh read inside, illegal transitions REJECTED with a structured reason). " +
        "open: new case (category + caseName + body). rewriteIndex: rewrite the body of a case still inside its write window (body; " +
        "pass expectedUpdated = the updated stamp you read from the case header — the rewrite is refused when the case moved since your read). " +
        "appendTail: ONE dated line (line) — the only in-place growth once the write window has closed. " +
        "addPiece: a dated piece (title + body). reviseUnderstanding: replace only _current.md with body and evidence refs actually read in this run, preserving the historical index. Read the full target case before any update; survey is not a receipt. " +
        "Categories: people/ events/ things/ places/ orgs/ research/ hypotheses/ tasks/ self/. `category` is optional and defaults to research — the SAME schema as the field side's writeCase; self/ is yours alone here (veto reasons, craft notes) while the field agent is refused it. " +
        "Exception: people/user is NOT a case — it is the user model, pure prose owned by evolveProfile; writes there are rejected. " +
        "Your writes QUEUE in this round's batch and land as ONE commit when the round ends — the OK line means 已记录，随本轮一次落盘, not yet on disk. " +
        DOC_WRITE_WINDOW_RULE +
        `\n\n${MEMORY_IS_GIT_RULE}`,
      inputSchema: z.object({
        action: z.enum(["open", "rewriteIndex", "appendTail", "addPiece", "reviseUnderstanding"]),
        category: z
          .enum([
            "people",
            "events",
            "things",
            "places",
            "orgs",
            "research",
            "hypotheses",
            "tasks",
            "self",
          ])
          .optional()
          .describe(
            "What the case IS decides the category (see the tool description). " +
            "Defaults to research — same schema as the field side's writeCase. " +
            "self/ is the reflection unit's own and is refused to the field agent.",
          ),
        caseName: z.string(),
        body: z.string().optional(),
        line: z.string().optional(),
        title: z.string().optional(),
        evidence: z.array(z.string().min(1)).min(1).max(20).optional(),
        expectedUpdated: z
          .string()
          .optional()
          .describe(
            "rewriteIndex only, RECOMMENDED: the updated stamp you read from the case header just now. " +
            "The write is refused when the case moved since that read.",
          ),
      }),
      execute: async (args) => {
        // people/user/index.md is the USER MODEL — pure prose maintained by
        // the merged card pass (evolveProfile), every byte of it injected
        // into each turn. Routing it through the case machinery would stamp
        // case frontmatter into that prose; refuse mechanically instead.
        if (args.category === "people" && args.caseName === "user") {
          return "REJECTED: people/user is the user model, not a case — use evolveProfile (other people/* cases stay legal).";
        }
        // The runtime category check lives in applyCaseWriteIntent
        // (isCaseCategory throws on an unknown category) — one enforcement point.
        // Names come from the model — normalize before anything else touches
        // them (2026-10-12 discipline; see sanitizeCaseSegment).
        // Category defaults to research — the same default as the field side's
        // writeCase (one schema, two posts).
        const category = (args.category ?? "research") as CaseCategory;
        const base = { category, caseName: sanitizeCaseSegment(args.caseName) };
        if (category === "self" && ["search", "thinkdeep"].includes(base.caseName)) {
          return "REJECTED: capability SOPs use readSelfSop/writeSelfSop; generic case writes cannot bypass their revision and evidence gates";
        }
        if (category === "tasks" && args.action === "open") {
          return "REJECTED: createTask records a genuine raw user commitment and materializes its task document atomically; use an existing ledger ref for later narrative updates";
        }
        if (args.action === "open" && !readState.hasReadEvidence()) return "REJECTED: readRound/readCase evidence before opening a document; a docket or survey is not evidence";
        let intent: CaseWriteIntent;
        switch (args.action) {
          case "open":
            if (!args.body) return "REJECTED: open requires body";
            intent = { action: "open", ...base, body: args.body };
            break;
          case "rewriteIndex":
            if (!args.body) return "REJECTED: rewriteIndex requires body";
            intent = {
              action: "rewriteIndex",
              ...base,
              body: args.body,
              ...(args.expectedUpdated !== undefined
                ? { expectedUpdated: args.expectedUpdated }
                : {}),
            };
            break;
          case "appendTail":
            if (!args.line) return "REJECTED: appendTail requires line";
            intent = { action: "appendTail", ...base, line: args.line };
            break;
          case "addPiece":
            if (!args.title || !args.body) return "REJECTED: addPiece requires title and body";
            intent = { action: "addPiece", ...base, title: sanitizeCaseSegment(args.title), body: args.body };
            break;
          case "reviseUnderstanding":
            if (!args.body || !args.evidence?.length) return "REJECTED: reviseUnderstanding requires body and evidence read in this run";
            intent = { action: "reviseUnderstanding", ...base, body: args.body, evidence: args.evidence };
            break;
        }
        try {
          const applied = await applyCaseWriteIntent(intent, date, batch, readState.scope);
          // Queued, NOT committed — the round's single end-of-round flush is
          // the commit. "written" is claimed only after a commit succeeds
          // (v0.37 §7-1): the honest word here is 「已记录，随本轮一次落盘」.
          return `OK — 已记录，随本轮一次落盘: ${applied.path}${applied.created ? " (created)" : ""}`;
        } catch (e) {
          return `REJECTED: ${e instanceof Error ? e.message : String(e)}`;
        }
      },
    }),

    archiveRound: tool({
      description:
        "Run the case-writer pass AND the scribe pass over a slice: which cases did this slice touch, " +
        "and which sediment/task markers in its mailbox are still unwritten? " +
        "The writer judges over the manifest + its own readCase reads; the scribe over the mailbox markers + " +
        "their target cases; engineering applies the intents. " +
        "An empty result is legal — writer-is-reader dedup lives inside the passes.",
      inputSchema: z.object({ sliceId: z.string() }),
      execute: async ({ sliceId }) => {
        const refusal = refuseMalformedSliceId(sliceId);
        if (refusal) return refusal;
        let slice: Awaited<ReturnType<typeof loadSlice>> = null;
        try {
          slice = await loadSlice(sliceId, batch);
        } catch {
          slice = null;
        }
        if (!slice) return `(slice ${sliceId} unreadable — archive skipped.)`;
        const excerpt = buildSliceExcerpt(slice);
        const result = await runLibrarianPass({
          model,
          closedSliceId: sliceId,
          excerpt,
          manifest: await currentManifest(),
          date,
          batch,
        });
        // The same slice's mailbox: sediment/task markers the field dropped
        // land as cases here — this is the scribe pass's production caller.
        const scribe = await runScribePass({
          model,
          sliceId,
          excerpt,
          date,
          batch,
        });
        return (
          // Queued, not committed — "written" is claimed only after the
          // round's flush lands (v0.37 §7-1).
          `queued (lands when this round commits): ${result.written.join(", ") || "(none)"}\n` +
          `skipped: ${result.skipped.map((s) => `${s.name} (${s.reason})`).join(", ") || "(none)"}\n` +
          `scribe queued (lands when this round commits): ${scribe.written.join(", ") || "(none)"}` +
          (scribe.skipped.length > 0
            ? `\nscribe skipped: ${scribe.skipped.map((s) => `${s.id} (${s.reason})`).join(", ")}`
            : "")
        );
      },
    }),

    evolveProfile: tool({
      description:
        "Run the merged card pass (the Previously Agent) over a slice — closed or still open, the pass is told which: " +
        "updates people/user/index.md (card + direction halves) and may rewrite the allowlisted self/ SOPs (search, thinkdeep). " +
        "Run it AFTER the round's case writes so the model cites the cases just written. " +
        "focus: one line telling the agent what this round is about (cite the cases you just wrote).",
      inputSchema: z.object({
        sliceId: z.string(),
        focus: z.string().describe("What this round is about — cite the cases just written, if any."),
      }),
      execute: async ({ sliceId, focus }) => {
        const refusal = refuseMalformedSliceId(sliceId);
        if (refusal) return refusal;
        let slice: Awaited<ReturnType<typeof loadSlice>> = null;
        try {
          slice = await loadSlice(sliceId, batch);
        } catch {
          slice = null;
        }
        if (!slice) return `(slice ${sliceId} unreadable — evolve skipped.)`;
        // The round's batch rides the read (v0.37 §5): the direction half may
        // have been queued by an earlier evolveProfile THIS round.
        const userModel = await readUserModel(batch).catch(() => null);
        const directionCurrent = userModel?.direction ?? null;
        // HQ owns no turn analysis — the direction half gets the minimal one
        // (the freshest evidence is the closed slice itself, read through the readers).
        const minimalAnalysis: TurnAnalysis = {
          memoryWorthy: true,
          emotionalSignal: { intensity: "none", register: "neutral", note: "" },
        };
        // HQ's read surface includes the LIVING slice — only a closed one
        // earns the slice_closed signal (and the deep whole-slice review it
        // unlocks); an open slice is reported as what it is, a field report.
        const closed = slice.status === "closed";
        // The pass truly RUNS from here — flag it so the round's outcome
        // reports the evolution beat (§4.2: lastEvolution stamps whenever
        // the pass ran, changed or not).
        flags.evolutionRan = true;
        // The same process-wide evolution lock the field's turn pipeline
        // serializes on (steps.ts) — HQ must not interleave its
        // read-modify-write of the user model / SOPs with a live turn's.
        const card = await withSliceLock("evolution", () =>
          runCardEvolution({
            batch,
            model,
            sliceId,
            ...(closed ? { closedSliceId: sliceId } : {}),
            recentTurns: slice.turns.map((t) => ({ role: t.role, content: t.content })),
            focus,
            signal: closed ? "slice_closed" : "field_report",
            readers: buildRunCardReaders(batch),
            todayDate: date,
            directionEval: {
              current: directionCurrent,
              mode: detectDirectionMode(directionCurrent),
              cardSelfModel: null,
              analysis: minimalAnalysis,
            },
            allowedSopWrites: ["search", "thinkdeep"],
          }),
        );
        return (
          `changed: ${card.changed}` +
          (card.summary ? `\nsummary: ${card.summary}` : "") +
          (card.error ? `\nerror: ${card.error}` : "")
        );
      },
    }),

    noteQuestions: tool({
      description:
        "Run the doc-research pass over a slice's mailbox: investigates the unanswered question markers " +
        "and writes research/ hypotheses/ cases (hypotheses must carry a falsification condition). " +
        "Marker scanning, dedup and recording happen INSIDE the pass.",
      inputSchema: z.object({ sliceId: z.string() }),
      execute: async ({ sliceId }) => {
        const refusal = refuseMalformedSliceId(sliceId);
        if (refusal) return refusal;
        let slice: Awaited<ReturnType<typeof loadSlice>> = null;
        try {
          slice = await loadSlice(sliceId, batch);
        } catch {
          slice = null;
        }
        if (!slice) return `(slice ${sliceId} unreadable — research skipped.)`;
        const result = await runDocResearchPass({
          model,
          sliceId,
          excerpt: buildSliceExcerpt(slice),
          manifest: await currentManifest(),
          date,
          batch,
        });
        return (
          `ran: ${result.ran}\n` +
          // Queued, not committed — "written" is claimed only after the
          // round's flush lands (v0.37 §7-1).
          `queued (lands when this round commits): ${result.written.join(", ") || "(none)"}\n` +
          `skipped: ${result.skipped.map((s) => `${s.id} (${s.reason})`).join(", ") || "(none)"}`
        );
      },
    }),

    setAgenda: tool({
      description:
        "Rewrite your agenda — memory/self/agenda.md, your own work pad of what to re-check and when. " +
        "A FULL rewrite every time: consume an item by dropping its line, reschedule it by changing its due date, add one by adding a line. " +
        "Line format (the ONLY mechanical contract — a line that breaks it is never handed back to you): " +
        "`- [due: YYYY-MM-DD] <one line>（据片 <sliceId>）` — every item carries its source (the slice id that motivated it). " +
        "The agenda is a work pad, not a ledger — keep it short. " +
        MEMORY_IS_GIT_RULE,
      inputSchema: z.object({
        content: z
          .string()
          .describe("The FULL new agenda text — one `- [due: YYYY-MM-DD] …（据片 …）` line per item."),
      }),
      execute: async ({ content }) => {
        // Same discipline as writeSelfSop above (the pattern this copies):
        // the process-wide evolution lock + the round's batch — a whole-file
        // write that must not interleave with a live turn's run.
        await withSliceLock("evolution", () =>
          fsWriteFile(AGENDA_PATH, content, batch),
        );
        return `OK — 已记录，随本轮一次落盘: ${AGENDA_PATH}`;
      },
    }),

    hqReport: tool({
      description:
        "Report the round's outcome. actions: what you landed (empty when idle — an idle round is legal). " +
        "note: one short paragraph — what you checked, what you did or deliberately did NOT do, and why. " +
        "disposition: omit for a normal round; 'superseded' only when the world moved under you and voided " +
        "this round's plan (the note then says why you abandoned and what you had landed).",
      inputSchema: hqReportSchema,
      execute: async (args) => args,
    }),
  };
}

// ─── The entry (the reflection-run.ts shell calls this) ───────────────────

/**
 * Handle ONE round off the lap's docket (v0.34 R2, §5.3). Never throws: a
 * failed round returns `{ actions: [], note: "", error }` — the unit's
 * products are writes, and a failed round simply has none (whatever its
 * tools landed before the failure rides as actions — 7f1afc1 honesty).
 */
export async function handleBrief(input: ReflectionRoundInput): Promise<HqOutcome> {
  "use step";
  const { withGitHubReadView, seedGitHubReadHead } = await import("@/lib/github/read-view");
  return withGitHubReadView(async () => {
  if (input.history) {
    const { resolveDataSource } = await import("@/lib/data-source/resolve");
    if (resolveDataSource() === "github") {
      const { getRepoConfig } = await import("@/lib/capabilities");
      const { owner, repo } = getRepoConfig();
      seedGitHubReadHead(repo, owner, { headSha: input.history.basis });
    }
  }
  const { date, cursor, scope, evolutionDue, evolutionReasons, agendaDue } = input;

  const model = backgroundModel();
  if (!model) {
    console.warn("[HQ] no default model configured — idle");
    return { actions: [], note: "", error: "no default model configured" };
  }

  // The round's user prompt is built from the DOCKET (§5.3): the material
  // (this round's owed turns), the gate's verdicts, and the agenda items
  // due by this round's date — delivery really happens now.
  const scopeLines =
    scope.length > 0
      ? scope
          .map(
            (s) =>
              `- ${s.sliceId}: turns ${s.turnIds.join(", ")}` +
              (s.closedBy ? ` (closed by ${s.closedBy})` : " (still open)"),
          )
          .join("\n")
      : "(none — no turn is owed this lap)";
  const agendaLines =
    agendaDue.length > 0
      ? agendaDue.map((a) => `- [due: ${a.due}] ${a.text}`).join("\n")
      : null;

  const prompt =
    `## Round docket (${date}) — your cursor: ${cursor ?? "(none — a fresh start)"}\n\n` +
    `This round's material — the turn(s) named below (a slice may still be open); the cursor advances only when the round settles:\n` +
    `${scopeLines}\n\n` +
    (evolutionDue
      ? `The evolution beat is DUE this round (${evolutionReasons.join(", ")}): run the merged card pass (evolveProfile) over this material.\n\n`
      : "") +
    (agendaLines !== null
      ? `Your agenda — due items ride WITH this round (work each, reschedule it, or consume it via setAgenda):\n${agendaLines}\n\n`
      : "") +
    ((input.skillReviewDue?.length ?? 0) > 0
      ? `Procedural skill reviews due — independent of the user-model evolution beat. Read their original self documents and later raw records before judging; no later scenario means pending/inconclusive, never verified success:\n${input.skillReviewDue!.map((entry) => `- ${entry.id} (revision ${entry.revision}; ${entry.ref}; due ${entry.reviewDue})`).join("\n")}\n\n`
      : "") +
    (input.skillReviewError ? `Skill review state is degraded: ${input.skillReviewError}. Do not treat this as an empty ledger.\n\n` : "") +
    `Read the named slice(s) (core.md for the user's words, agent.md for the field's thinking and work) ` +
    `and anything else the docket implies, then decide what deserves doing. ` +
    `When the round is done (or you decide nothing needs doing), call hqReport.`;

  // ONE batch for the whole round: every write the tools queue lands as a
  // single commit (`Reflection round — {date}`); an idle round's empty batch
  // no-ops
  // the flush. The batch rides this step only — never module-global — and
  // the same threading works unchanged on the local backend (flushBatch
  // applies the entries and records one local commit).
  const batch = createBatch();
  batch.baseHeadSha = input.history?.basis;
  if (!batch.baseHeadSha && (await import("@/lib/data-source/resolve")).resolveDataSource() === "github") {
    try {
      const { owner, repo } = (await import("@/lib/capabilities")).getRepoConfig();
      batch.baseHeadSha = (await (await import("@/lib/github/read-view")).getGitHubReadHead(repo, owner)).headSha;
    } catch (error) {
      return { actions: [], note: "", error: `cannot establish the reflection write basis: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  const flags = { evolutionRan: false };

  return withTaskLedgerBatch(batch, async (mutateTask) => {
  try {
  const result = await runSubAgent<HqReport>({
    role: "reflection",
    model,
    system: buildSubAgentSystem(HQ_ROLE),
    prompt,
    tools: buildHqTools(date, model, batch, flags, mutateTask),
    toolChoice: "required",
    reportToolName: "hqReport",
    reportSchema: hqReportSchema,
    maxSteps: 50,
    // The platform wall (800 s per invocation) is NOT a budget: reaching it
    // kills the delivery and the SDK re-executes the in-flight step bodies
    // on redelivery — a crash, not a bound. So the round carries an explicit
    // ceiling; on expiry the runner returns a failure and the flush below
    // lands whatever the round's tools already queued.
    timeoutMs: REFLECTION_ROUND_TIMEOUT_MS,
  });

  // A due review was offered, not necessarily completed. Persist that host
  // receipt only after a clean run, so an unchanged item cannot burn empty laps.
  if (result.ok && result.report && result.report.disposition !== "superseded") {
    for (const offered of input.skillReviewDue ?? []) {
      const read = await readSkillLedger(batch, { fresh: true });
      if (read.status !== "ok") continue;
      const current = read.ledger.entries.find((entry) => entry.id === offered.id);
      if (current?.state !== "adopted" || current.revision !== offered.revision) continue;
      const receipt = await mutateSkillLedger({
        kind: "offer_review", id: current.id, expectedRevision: current.revision,
        operationId: skillReviewOfferId(current),
      }, batch);
      if (receipt.status === "corrupt" || receipt.status === "unavailable" || receipt.status === "rejected") {
        throw new Error(`skill review offer receipt failed: ${receipt.diagnostic}`);
      }
    }
  }

  // Flush whatever the round queued — even a failed round keeps whatever
  // its tools landed before the failure (HQ's products are writes). The
  // commit message IS the settlement (v0.39 §2.3): a CLEAN round's trailer
  // carries the water level (`seen:`), the evolution beat (`evolved:`) or
  // the superseded verdict — 恰好 1 次提交/轮, and a clean round with an
  // EMPTY queue still lands one commit carrying only the trailer (空轮空
  // 提交 — the vetoed slice must not plug the scope's head, §7-2). A FAILED
  // round's commit (when it has writes) carries NO trailer section: the
  // level not advancing is the absence of a line, not a flag (§2.6). A
  // bounded PLAIN retry covers a ref that moved under us.
  //
  // Snapshot the queue BEFORE the flush: a successful flush empties the
  // batch, and a FAILED round still needs the list — the round's landed
  // writes are its visible product even when the sub-agent never reported
  // (a timeout cuts the hqReport call, not the writes that preceded it).
  const queuedPaths = [...batch.entries.keys()]
    .filter((p) => batch.entries.get(p) !== null)
    .sort();
  const rep = result.ok && result.report ? result.report : null;
  const roundFailed = rep === null;
  const superseded = rep?.disposition === "superseded";
  // The TURN-level water level (v0.42 §4 — the work unit is a turn): one
  // seen mark per SCOPED slice, its owed turn ids. The scope is already
  // coverage-filtered by the world read, so these marks are exactly what
  // this round processed — a later lap (or a rangeless unit) subtracts
  // them from whatever the summary log still owes.
  const seenMarks =
    scope.length > 0
      ? scope.map((s) => ({ sliceId: s.sliceId, turnIds: s.turnIds }))
      : undefined;
  const note = rep && queuedPaths.length > 0 ? rep.note : undefined;
  const observed = input.history?.pending.flatMap(m => {
    const turnIds = m.turnIds.filter(t => scope.some(s => s.sliceId === m.sliceId && s.turnIds.includes(t)));
    return turnIds.length ? [{ ...m, turnIds }] : [];
  });
  const message = buildReflectionRoundMessage({
    date,
    ...(note?.trim() ? { note } : {}),
    // 失败轮不载 trailer（有写也如此）；superseded 与 seen 互斥
    ...(roundFailed
      ? {}
      : {
          trailer: {
            ...(!superseded && seenMarks ? { seen: seenMarks } : {}),
            ...(!superseded && input.history ? {
              observed: observed ?? [],
              history: settleHistoryCheckpoint(input.history, scope, flags.evolutionRan ? date : undefined),
            } : {}),
            ...(flags.evolutionRan ? { evolved: { date } } : {}),
            ...(superseded ? { superseded: true as const } : {}),
          },
        }),
  });
  let flushed = false;
  let flushAttempts = 0;
  let flushFailure: unknown = null;
  for (;;) {
    try {
      await commitReflectionRound(batch, message);
      flushed = true;
      break;
    } catch (err) {
      if (!isRefConflictError(err) || flushAttempts >= 2 || (batch.baseHeadSha && batch.entries.size > 0)) {
        // A queued whole-file write belongs to its read basis. It cannot be
        // rebased by merely replacing the parent; the next lap must reread.
        flushFailure = err;
        break;
      }
      flushAttempts += 1;
      console.warn(
        `[HQ] flush conflict — rebasing onto the moved ref (retry ${flushAttempts}/2):`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  // A flush failure that is NOT a ref conflict (rate limit, circuit breaker,
  // network) must FAIL the round — retrying inside the step is pointless
  // (the breaker stays open ~60 s and GitHub asks for ~340 s). Nothing
  // persisted, so the honest outcome is a failure: the commit never landed,
  // the water level does not move (no `seen:` trailer), and the owed
  // material is redone on a later lap. Reporting the sub-agent's success
  // here would be a lie — its writes died with the flush.
  if (flushFailure !== null) {
    const detail =
      flushFailure instanceof Error ? flushFailure.message : String(flushFailure);
    const lost =
      queuedPaths.length > 0 ? queuedPaths.join(", ") : "(none queued)";
    console.warn(
      `[HQ] round flush failed — round FAILED, the cursor did not move, the work will be redone: ${detail} (queued writes not persisted: ${lost})`,
    );
    const flushError =
      `round flush failed (${detail}) — queued writes did not persist: ${lost}. ` +
      `The round is failed: the cursor does not move and this material is redone on a later lap.`;
    const error = roundFailed
      ? `${result.error ?? "HQ ended without a report"}; ${flushError}`
      : flushError;
    // No `evolved` stamp either: the pass ran, but its product died with
    // the same flush — nothing this round produced survives.
    return { actions: [], note: "", error };
  }

  if (roundFailed || !rep) {
    const error = result.error ?? "HQ ended without a report";
    console.warn(`[HQ] round failed: ${error}`);
    // The writes that DID land ride as actions (memory/-stripped, matching
    // the report's own path style) — a failed round with landed writes is
    // not an empty round. The note stays empty: lastNote is the unit's OWN
    // account (R1), and an interrupted round never wrote one.
    const landed = flushed
      ? queuedPaths.map((p) => p.replace(/^memory\//, ""))
      : [];
    return {
      actions: landed,
      note: "",
      error,
      // an evolution pass that ran before the cut still counts (§4.2)
      ...(flags.evolutionRan ? { evolved: true } : {}),
    };
  }
  console.log(`[HQ] round done: ${rep.actions.length} action(s)`);
  return {
    actions: rep.actions,
    note: rep.note,
    // 修订 C: verbatim passthrough — absent means "completed".
    ...(rep.disposition !== undefined
      ? { disposition: rep.disposition }
      : {}),
    // §4.2: the evolution beat stamps whenever the pass truly ran.
    ...(flags.evolutionRan ? { evolved: true } : {}),
  };
  } catch (err) {
    // v0.42 §5 [11279] — the floor: an UNEXPECTED throw before the settle
    // (a platform step-retry exhaustion, a bug past the unit's own guards)
    // must not silently drop what the tools already queued. Land whatever
    // the batch holds as a DEGRADED commit — the SAME `Reflection round —`
    // prefix with a degradation line in the body and NO trailer section:
    // the water level does not move (失败轮不推游标), and the log's readers
    // already treat a trailer-less round as failed — which is the truth.
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `[HQ] round failed unexpectedly — landing queued writes degraded (cursor holds): ${msg}`,
    );
    const queuedPaths = [...batch.entries.keys()]
      .filter((p) => batch.entries.get(p) !== null)
      .sort();
    let landed: string[] = [];
    if (queuedPaths.length > 0) {
      const degradedMessage =
        COMMIT_PREFIX.reflectionRound(date) +
        `\n\n- degraded commit — the round failed before settlement (${msg}); ` +
        `queued writes landed as-is, the cursor unchanged (v0.42 §5)`;
      try {
        await commitReflectionRound(batch, degradedMessage);
        landed = queuedPaths.map((p) => p.replace(/^memory\//, ""));
      } catch (flushErr) {
        // The degraded commit died too (same non-retryable classes — rate
        // limit, breaker, network): nothing persisted either way, so the
        // round comes back failed with the lost paths named — the cursor
        // holds and the material is redone on a later lap.
        const flushDetail =
          flushErr instanceof Error ? flushErr.message : String(flushErr);
        console.warn(
          `[HQ] degraded flush failed too — round FAILED, the cursor did not move, the work will be redone: ${flushDetail} (queued writes not persisted: ${queuedPaths.join(", ")})`,
        );
        return {
          actions: [],
          note: "",
          error:
            `${msg}; degraded flush also failed (${flushDetail}) — queued writes did not persist: ${queuedPaths.join(", ")}. ` +
            `The round is failed: the cursor does not move and this material is redone on a later lap.`,
        };
      }
    }
    return { actions: landed, note: "", error: msg };
  }
  });
  }, { fresh: true });
}
