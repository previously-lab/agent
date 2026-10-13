/**
 * The HQ agent (v0.21 §2/§4/§5) — ONE agent + a tool set, no mouth.
 *
 * HQ is the memory system's archival/evolution unit. Its ONLY trigger is a
 * field dispatch: a prose brief whose pointers name slices and cases but
 * carry no content. HQ reads the raw records itself before touching anything
 * (the brief is one side's account — a pointer is not a fact), decides what
 * to do and in what order (the discipline lives in this prompt, not in a
 * fixed pipeline), and stores RESULTS ONLY:
 *
 *   - an idle round writes NOTHING — there is no run ledger;
 *   - dedup is writer-is-reader (a re-run reads current case state and goes
 *     idle when it already reflects the slice);
 *   - a substantive veto leaves its REASON as prose in self/ or the relevant
 *     case body — never a counter.
 *
 * Every tool here WRAPS an existing capability (the case-writer pass, the
 * doc-research pass, the merged card run, the case write machinery, the SOP
 * store) — this module invents no new write path.
 *
 * P4b wiring: the hq-run.ts shell's `handleHQBrief` (hq-steps.ts) calls
 * `handleBrief` below — one brief = one round. question-run.ts keeps
 * compiling against background-steps.ts until the last P4 lane retires the
 * old trigger chain.
 */
import { tool } from "ai";
import { z } from "zod";
import { closeSlice, loadSlice, readSlicePart } from "@/lib/episodic";
import {
  createBatch,
  flushBatch,
  type WriteBatch,
} from "@/lib/episodic/io-helpers";
import { isRefConflictError } from "@/lib/tools/batch-write";
import { withSliceLock } from "@/lib/episodic/slice-mutex";
import { runSubAgent } from "@/lib/agents/sub-agent-runner";
import { buildSubAgentSystem } from "@/lib/agents/prompts";
import { DOC_HOUSE_STYLE, DOC_LANGUAGE_RULE } from "@/lib/agents/doc-style";
import {
  applyCaseWriteIntent,
  buildSliceExcerpt,
  makeCaseReadTool,
  renderManifest,
  runLibrarianPass,
  runScribePass,
  type CaseWriteIntent,
} from "@/lib/episodic/flash/librarian";
import type { CaseCategory } from "@/lib/docs";
import { sanitizeCaseSegment } from "@/lib/docs/case-naming";
// Direct module path, not the "@/lib/docs" barrel: this file is reachable
// from the "use workflow" bundle, and the barrel re-exports case-doc.ts
// (gray-matter → node:*), which the workflow bundler rejects.
import { DOC_WRITE_WINDOW_RULE } from "@/lib/docs/write-window";
import { runDocResearchPass } from "@/lib/episodic/flash/doc-research";
import type { TurnAnalysis } from "@/lib/episodic/flash/turn-analyzer";
import { readUserModel, writeSelfSop } from "@/lib/evolution/store";
import { detectDirectionMode } from "@/lib/evolution/direction-agent";
import { runCardEvolution } from "@/app/api/evolution/run-card-evolution";
import type { ModelConfig } from "@/lib/models/registry";
import {
  backgroundModel,
  buildRunCardReaders,
  buildRunManifest,
} from "./hq-context";

// ─── The run contract ─────────────────────────────────────────────────────

export interface ReflectionWakeInput {
  /** The slice the finished turn landed in, when the wake names one. */
  sliceId?: string;
  /** The finished turn's id, when the wake names one. */
  turnId?: string;
  /** User-local date (YYYY-MM-DD) — every write stamps the user's clock. */
  date: string;
}

export interface HqOutcome {
  /** What HQ landed (memory-relative paths / case refs, one per line). */
  actions: string[];
  /** HQ's one-paragraph account of the round (idle rounds say why). */
  note: string;
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
});
type HqReport = z.infer<typeof hqReportSchema>;

// ─── The role prompt (static — per-call data rides the user prompt) ───────

const HQ_ROLE = `You are the reflection unit — the archival and evolution unit of the ONE agent. You have no mouth: nothing you produce is ever shown to the user as conversation. Your products land in the memory tree (cases, the user model, self/ SOPs), where the field side reads them later. You and the field unit are one agent — the same "I" at two posts. Every line you write is that one person's hand: inside the documents there is no "the agent" and no "reflection unit" as a third party, and nothing reads as a report from another being.

The record is the channel. Nobody briefs you: you are woken mechanically with nothing but pointers — a slice id, a turn id, a date — and everything you need, you read yourself: the user's own words (core.md), the field's thinking and work (agent.md), the tree's products.
- A pointer is not a fact. The wake names slices and turns; it does not carry their content.
- BEFORE writing anything, verify against the raw records: readSlice / readCase / listTree. Never write from the pointer alone.
- Your range is everything since your last look. A rolling pointer says where you got to; when several turns landed while you were away, they are one round's material, not several.

Store RESULTS ONLY:
- An idle round is a legal, often correct outcome — when the records show nothing substantive to store, write NOTHING and say why in your report. There is no ledger; do not record that you ran.
- Dedup is writer-is-reader: you judge duplication by READING the current case state, not by consulting any log of past runs.
- A substantive VETO (you checked and decided against a write the brief implied) leaves its REASON as prose — in self/ (your own craft) or in the relevant case body. Never a tally, never a counter.

You decide what to do and in what order. The natural order, when several things are due:
1. Verify first (reads before any write).
2. Cases usually before people/user — the user model should cite the cases the round just wrote, not speak in generalities.
3. self/ comes last — craft reflections are informed by everything else the round did.

Housekeeping you own: an ACTIVE slice past the date window is an orphan — the conversation long ended but the close never fired, and the field's stale-scan only looks back two days. When a read shows you one, seal it with markSlice (closed_by: context_lost); a capability, not a per-round obligation.

Craft notes:
- Mailbox marker lines in a slice's agent.md are prose CLUES, not triggers — read them, judge them, ignore them when stale.
- self/ SOP rewrites must cite their evidence (records slice ids) inside the prose — an SOP line without evidence is dead paper.
- research/ hypotheses must carry a falsification condition (the write tooling enforces it).
- ${DOC_LANGUAGE_RULE}

How your prose reads — the investigator's account, never the work order:
- A self/ entry (an SOP rule, a veto reason, a self-assessment) records ONE thing that happened: the date and the slice, what observably happened (a fact anyone can re-check against the record), the working rule adopted because of it, and where the evidence lives. It reads like a case note in an investigation file — never like a change request or an incident ticket.
- The builder's vantage point is banned from the memory tree: no 工程侧 / 代码 / 实现 / 接口 / 缺陷 / 修复 / 上报, and no English equivalents (engineering, the code, implementation, defect, fix, escalate). When a read or a tool misbehaves, record the PHENOMENON you can reproduce and the rule you now follow — e.g. "2026-10-05：以全角冒号引用一份中文长名的案件时，清单里看得到，读回却失败；此后引用前先读回，读不回就不引用。" — never a diagnosis of how you are built or a request that someone fix you.
- No system self-reference: you do not describe how this system works, do not explain its architecture, do not address whoever maintains it. The record says what you encountered and under what circumstances you learned it — nothing about what you are made of.

${DOC_HOUSE_STYLE}`;

// ─── The tools (every one a wrapper over an existing capability) ──────────

function buildHqTools(date: string, model: ModelConfig, batch: WriteBatch) {
  return {
    listTree: tool({
      description:
        "The whole memory tree as a manifest (memory/ minus config/, records/ collapsed to slice dirs). " +
        "Your discovery surface — call it first when the brief does not name exact cases.",
      inputSchema: z.object({}),
      execute: async () => renderManifest((await buildRunManifest()).tree),
    }),

    readSlice: tool({
      description:
        "Read one slice's raw record: part 'core' (the conversation, default), 'agent' (the mailbox / agent timeline), " +
        "or 'previously' (the card snapshot at that slice). Dual-root — older slices are found under the legacy root.",
      inputSchema: z.object({
        sliceId: z.string().describe("e.g. 2026-10-04-0131"),
        part: z.enum(["core", "agent", "previously"]).default("core"),
      }),
      execute: async ({ sliceId, part }) => {
        try {
          return await readSlicePart(sliceId, part);
        } catch {
          return `(cannot read ${sliceId} part ${part} — the slice or the part is missing; check listTree first.)`;
        }
      },
    }),

    readCase: makeCaseReadTool(),

    markSlice: tool({
      description:
        "Seal one slice that is still ACTIVE past the date window — an orphan: the conversation long ended " +
        "but the close never fired (the field's stale-scan only looks back two days, so older orphans have no " +
        "other closer). Verify with readSlice first that it is genuinely orphaned. The close stamps " +
        "closed_by: context_lost — the scene was lost, not checkpointed. An already-closed slice is a no-op.",
      inputSchema: z.object({
        sliceId: z.string().describe("e.g. 2026-10-04-0131"),
      }),
      execute: async ({ sliceId }) => {
        const slice = await loadSlice(sliceId).catch(() => null);
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
        "addPiece: a dated piece (title + body, always allowed). " +
        "Categories: people/ events/ things/ places/ orgs/ research/ hypotheses/ tasks/ self/. " +
        "Exception: people/user is NOT a case — it is the user model, pure prose owned by evolveUserModel; writes there are rejected. " +
        DOC_WRITE_WINDOW_RULE,
      inputSchema: z.object({
        action: z.enum(["open", "rewriteIndex", "appendTail", "addPiece"]),
        category: z.string(),
        caseName: z.string(),
        body: z.string().optional(),
        line: z.string().optional(),
        title: z.string().optional(),
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
        // the merged card pass (evolveUserModel), every byte of it injected
        // into each turn. Routing it through the case machinery would stamp
        // case frontmatter into that prose; refuse mechanically instead.
        if (args.category === "people" && args.caseName === "user") {
          return "REJECTED: people/user is the user model, not a case — use evolveUserModel (other people/* cases stay legal).";
        }
        // The runtime category check lives in applyCaseWriteIntent
        // (isCaseCategory throws on an unknown category) — one enforcement point.
        // Names come from the model — normalize before anything else touches
        // them (2026-10-12 discipline; see sanitizeCaseSegment).
        const base = { category: args.category as CaseCategory, caseName: sanitizeCaseSegment(args.caseName) };
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
        }
        try {
          const applied = await applyCaseWriteIntent(intent, date, batch);
          return `OK: ${applied.path}${applied.created ? " (created)" : ""}`;
        } catch (e) {
          return `REJECTED: ${e instanceof Error ? e.message : String(e)}`;
        }
      },
    }),

    archiveSliceCases: tool({
      description:
        "Run the case-writer pass AND the scribe pass over a slice: which cases did this slice touch, " +
        "and which sediment/task markers in its mailbox are still unwritten? " +
        "The writer judges over the manifest + its own readCase reads; the scribe over the mailbox markers + " +
        "their target cases; engineering applies the intents. " +
        "An empty result is legal — writer-is-reader dedup lives inside the passes.",
      inputSchema: z.object({ sliceId: z.string() }),
      execute: async ({ sliceId }) => {
        const slice = await loadSlice(sliceId).catch(() => null);
        if (!slice) return `(slice ${sliceId} unreadable — archive skipped.)`;
        const excerpt = buildSliceExcerpt(slice);
        const result = await runLibrarianPass({
          model,
          closedSliceId: sliceId,
          excerpt,
          manifest: await buildRunManifest(),
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
          `written: ${result.written.join(", ") || "(none)"}\n` +
          `skipped: ${result.skipped.map((s) => `${s.name} (${s.reason})`).join(", ") || "(none)"}\n` +
          `scribe written: ${scribe.written.join(", ") || "(none)"}` +
          (scribe.skipped.length > 0
            ? `\nscribe skipped: ${scribe.skipped.map((s) => `${s.id} (${s.reason})`).join(", ")}`
            : "")
        );
      },
    }),

    evolveUserModel: tool({
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
        const slice = await loadSlice(sliceId).catch(() => null);
        if (!slice) return `(slice ${sliceId} unreadable — evolve skipped.)`;
        const userModel = await readUserModel().catch(() => null);
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
            readers: buildRunCardReaders(),
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

    researchSliceQuestions: tool({
      description:
        "Run the doc-research pass over a slice's mailbox: investigates the unanswered question markers " +
        "and writes research/ hypotheses/ cases (hypotheses must carry a falsification condition). " +
        "Marker scanning, dedup and recording happen INSIDE the pass.",
      inputSchema: z.object({ sliceId: z.string() }),
      execute: async ({ sliceId }) => {
        const slice = await loadSlice(sliceId).catch(() => null);
        if (!slice) return `(slice ${sliceId} unreadable — research skipped.)`;
        const result = await runDocResearchPass({
          model,
          sliceId,
          excerpt: buildSliceExcerpt(slice),
          manifest: await buildRunManifest(),
          date,
          batch,
        });
        return (
          `ran: ${result.ran}\n` +
          `written: ${result.written.join(", ") || "(none)"}\n` +
          `skipped: ${result.skipped.map((s) => `${s.id} (${s.reason})`).join(", ") || "(none)"}`
        );
      },
    }),

    writeSelfSop: tool({
      description:
        "Rewrite one self/ SOP (search or thinkdeep) — your own craft, the LAST thing a round touches. " +
        "Evidence discipline: the prose must cite the records slice ids that motivate the rewrite. " +
        "Style discipline: each rule is a dated, re-checkable account of what happened and the working " +
        "rule it motivated — an investigator's case note, never the builder's vantage point " +
        "(no 工程侧 / 代码 / 实现 / 缺陷 / 修复 / 上报) and never notes addressed to your makers. " +
        "House style: one sentence one meaning, active voice, no filler — the full rules sit in your role prompt. " +
        "A substantive veto's REASON also lands here as prose (or in the relevant case body) — never as a counter. " +
        "An SOP is short guidance, not an archive — rewrite it in place; it is loaded verbatim " +
        "into the colleague's prompt at spawn, so keep it tight.",
      inputSchema: z.object({
        agent: z.enum(["search", "thinkdeep"]),
        content: z.string().describe("The FULL new SOP text — dated factual accounts with the rules they motivated, evidence (slice ids) cited in the prose, no builder vocabulary."),
      }),
      execute: async ({ agent, content }) => {
        // Same evolution lock as evolveUserModel above — an SOP rewrite is a
        // whole-file write that must not interleave with a live turn's run.
        await withSliceLock("evolution", () =>
          writeSelfSop(agent, content, batch),
        );
        return `OK: memory/self/${agent}/index.md`;
      },
    }),

    hqReport: tool({
      description:
        "Report the round's outcome. actions: what you landed (empty when idle — an idle round is legal). " +
        "note: one short paragraph — what you checked, what you did or deliberately did NOT do, and why.",
      inputSchema: hqReportSchema,
      execute: async (args) => args,
    }),
  };
}

// ─── The entry (P4 wiring point — the hq-run.ts shell calls this) ─────────

/**
 * Handle one mechanical wake (v0.30 §2). Never throws: a failed round
 * returns `{ actions: [], note: "", error }` — the unit's products are
 * writes, and a failed round simply has none.
 */
export async function handleBrief(input: ReflectionWakeInput): Promise<HqOutcome> {
  "use step";
  const { sliceId, turnId, date } = input;

  const model = backgroundModel();
  if (!model) {
    console.warn("[HQ] no default model configured — idle");
    return { actions: [], note: "", error: "no default model configured" };
  }

  const prompt =
    `## A field turn completed (${date}${sliceId ? ` — slice ${sliceId}` : ""}${turnId ? `, turn ${turnId}` : ""})\n\n` +
    `The record is the channel: read the slice (core.md for the user's words, agent.md for the field's thinking and work) ` +
    `and anything else since your last look, then decide what deserves doing. ` +
    `When the round is done (or you decide nothing needs doing), call hqReport.`;

  // ONE batch for the whole round: every write the tools queue lands as a
  // single commit (`HQ round — {date}`); an idle round's empty batch no-ops
  // the flush. The batch rides this step only — never module-global — and
  // the same threading works unchanged on the local backend (flushBatch
  // applies the entries and records one local commit).
  const batch = createBatch();

  const result = await runSubAgent<HqReport>({
    model,
    system: buildSubAgentSystem(HQ_ROLE),
    prompt,
    tools: buildHqTools(date, model, batch),
    toolChoice: "required",
    reportToolName: "hqReport",
    reportSchema: hqReportSchema,
    maxSteps: 50,
    // Above the internal composite passes' budgets (the merged card pass
    // carries 240s) — HQ must outlive any single tool call it makes.
    timeoutMs: 300_000,
  });

  // Flush whatever the round queued — even a failed round keeps whatever
  // its tools landed before the failure (HQ's products are writes). A
  // bounded PLAIN retry covers a ref that moved under us:
  // commitBatchToGitHub re-reads HEAD at the start of every attempt, so the
  // retry rebases our tree onto the moved ref. Why a plain retry is enough
  // (R6): HQ never writes the LIVE slice's core.md — markSlice seals only
  // non-live orphans, which by definition no live turn is appending to —
  // case intents hold the same per-case `doc:` locks as the field's
  // writeCase, and card/SOP writes hold the same in-process "evolution"
  // lock as the field's evolution segment. A same-file clobber is therefore
  // unreachable in-process and, cross-process, no worse than the
  // pre-existing per-file sha race (last writer wins either way). What the
  // retry cannot heal is a TRUE same-file cross-process race on a merged
  // file (people/user/index.md) — accepted: it existed with per-file writes
  // too. Never throws: a lost flush costs the round's writes, not the run.
  let flushAttempts = 0;
  for (;;) {
    try {
      await flushBatch(batch, `HQ round — ${date}`);
      break;
    } catch (err) {
      if (!isRefConflictError(err) || flushAttempts >= 2) {
        console.warn(
          "[HQ] round flush failed (queued writes lost):",
          err instanceof Error ? err.message : err,
        );
        break;
      }
      flushAttempts += 1;
      console.warn(
        `[HQ] flush conflict — rebasing onto the moved ref (retry ${flushAttempts}/2):`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  if (!result.ok || !result.report) {
    const error = result.error ?? "HQ ended without a report";
    console.warn(`[HQ] round failed: ${error}`);
    return { actions: [], note: "", error };
  }
  console.log(`[HQ] round done: ${result.report.actions.length} action(s)`);
  return { actions: result.report.actions, note: result.report.note };
}
