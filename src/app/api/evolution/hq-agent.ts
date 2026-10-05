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
 * `handleBrief` below — one brief = one round. boundary-run.ts /
 * question-run.ts keep compiling against background-steps.ts until the last
 * P4 lane retires the old trigger chain.
 */
import { tool } from "ai";
import { z } from "zod";
import { loadSlice, readSlicePart } from "@/lib/episodic";
import { runSubAgent } from "@/lib/agents/sub-agent-runner";
import { buildSubAgentSystem } from "@/lib/agents/prompts";
import {
  applyCaseWriteIntent,
  buildSliceExcerpt,
  makeCaseReadTool,
  renderManifest,
  runLibrarianPass,
  type CaseWriteIntent,
} from "@/lib/episodic/flash/librarian";
import type { CaseCategory } from "@/lib/docs";
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

export interface HqBriefInput {
  /** The field dispatch — prose. Pointers (slice ids, case refs), no content. */
  brief: string;
  /** User-local date (YYYY-MM-DD) — every write stamps the user's clock. */
  date: string;
  /** The slice the brief is about, when the dispatch names one. */
  sliceId?: string;
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

const HQ_ROLE = `You are HQ — the archival and evolution unit of the ONE agent. You have no mouth: nothing you produce is ever shown to the user as conversation. Your products land in the memory tree (cases, the user model, self/ SOPs), where the field side reads them later.

Your only trigger is a field dispatch: a prose BRIEF from the field. Treat it as one side's account:
- A pointer is not a fact. The brief names slices and cases; it does not carry their content.
- BEFORE writing anything, verify against the raw records: readSlice / readCase / listTree. Never write from the brief alone.

Store RESULTS ONLY:
- An idle round is a legal, often correct outcome — when the records show nothing substantive to store, write NOTHING and say why in your report. There is no ledger; do not record that you ran.
- Dedup is writer-is-reader: you judge duplication by READING the current case state, not by consulting any log of past runs.
- A substantive VETO (you checked and decided against a write the brief implied) leaves its REASON as prose — in self/ (your own craft) or in the relevant case body. Never a tally, never a counter.

You decide what to do and in what order. The natural order, when several things are due:
1. Verify first (reads before any write).
2. Cases usually before people/user — the user model should cite the cases the round just wrote, not speak in generalities.
3. self/ comes last — craft reflections are informed by everything else the round did.

Craft notes:
- Mailbox marker lines in a slice's agent.md are prose CLUES, not triggers — read them, judge them, ignore them when stale.
- self/ SOP rewrites must cite their evidence (records slice ids) inside the prose — an SOP line without evidence is dead paper.
- research/ hypotheses must carry a falsification condition (the write tooling enforces it).
- Keep every write in the user's language; your report fields stay in English.

How your prose reads — the investigator's account, never the work order:
- A self/ entry (an SOP rule, a veto reason, a self-assessment) records ONE thing that happened: the date and the slice, what observably happened (a fact anyone can re-check against the record), the working rule adopted because of it, and where the evidence lives. It reads like a case note in an investigation file — never like a change request or an incident ticket.
- The builder's vantage point is banned from the memory tree: no 工程侧 / 代码 / 实现 / 接口 / 缺陷 / 修复 / 上报, and no English equivalents (engineering, the code, implementation, defect, fix, escalate). When a read or a tool misbehaves, record the PHENOMENON you can reproduce and the rule you now follow — e.g. "2026-10-05：以全角冒号引用一份中文长名的案件时，清单里看得到，读回却失败；此后引用前先读回，读不回就不引用。" — never a diagnosis of how you are built or a request that someone fix you.
- No system self-reference: you do not describe how this system works, do not explain its architecture, do not address whoever maintains it. The record says what you encountered and under what circumstances you learned it — nothing about what you are made of.`;

// ─── The tools (every one a wrapper over an existing capability) ──────────

function buildHqTools(date: string, model: ModelConfig) {
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
          return `（读不到 ${sliceId} 的 ${part} —— 切片不存在或该部分缺失。先用 listTree 核对。）`;
        }
      },
    }),

    readCase: makeCaseReadTool(),

    writeCase: tool({
      description:
        "Apply ONE case write through the five ops (per-case lock, fresh read inside, illegal transitions REJECTED). " +
        "open: new case (category + caseName + body). rewriteIndex: rewrite the 正文 of a LIVE case (body). " +
        "appendTail: one dated line on a SEALED case (line). addPiece: a dated piece (title + body). " +
        "close: seal a case (note = 去向说明). Categories: people/ events/ things/ places/ orgs/ research/ hypotheses/ tasks/ self/.",
      inputSchema: z.object({
        action: z.enum(["open", "rewriteIndex", "appendTail", "addPiece", "close"]),
        category: z.string(),
        caseName: z.string(),
        body: z.string().optional(),
        line: z.string().optional(),
        title: z.string().optional(),
        note: z.string().optional(),
      }),
      execute: async (args) => {
        // The runtime category check lives in applyCaseWriteIntent
        // (isCaseCategory throws on an unknown category) — one enforcement point.
        const base = { category: args.category as CaseCategory, caseName: args.caseName };
        let intent: CaseWriteIntent;
        switch (args.action) {
          case "open":
            if (!args.body) return "REJECTED: open requires body";
            intent = { action: "open", ...base, body: args.body };
            break;
          case "rewriteIndex":
            if (!args.body) return "REJECTED: rewriteIndex requires body";
            intent = { action: "rewriteIndex", ...base, body: args.body };
            break;
          case "appendTail":
            if (!args.line) return "REJECTED: appendTail requires line";
            intent = { action: "appendTail", ...base, line: args.line };
            break;
          case "addPiece":
            if (!args.title || !args.body) return "REJECTED: addPiece requires title and body";
            intent = { action: "addPiece", ...base, title: args.title, body: args.body };
            break;
          case "close":
            if (!args.note) return "REJECTED: close requires note";
            intent = { action: "close", ...base, note: args.note };
            break;
        }
        try {
          const applied = await applyCaseWriteIntent(intent, date);
          return `OK: ${applied.path}${applied.created ? " (created)" : ""}`;
        } catch (e) {
          return `REJECTED: ${e instanceof Error ? e.message : String(e)}`;
        }
      },
    }),

    archiveSliceCases: tool({
      description:
        "Run the case-writer pass over a closed slice: which cases did this slice touch? " +
        "The writer judges over the manifest + its own readCase reads; engineering applies the intents. " +
        "An empty result is legal — writer-is-reader dedup lives inside the pass.",
      inputSchema: z.object({ sliceId: z.string() }),
      execute: async ({ sliceId }) => {
        const slice = await loadSlice(sliceId).catch(() => null);
        if (!slice) return `（切片 ${sliceId} 读不到——archive 跳过。）`;
        const result = await runLibrarianPass({
          model,
          closedSliceId: sliceId,
          excerpt: buildSliceExcerpt(slice),
          manifest: await buildRunManifest(),
          date,
        });
        return (
          `written: ${result.written.join("、") || "（无）"}\n` +
          `skipped: ${result.skipped.map((s) => `${s.name}（${s.reason}）`).join("、") || "（无）"}`
        );
      },
    }),

    evolveUserModel: tool({
      description:
        "Run the merged card pass (the Previously Agent) over a closed slice: updates people/user/index.md " +
        "(card + direction halves) and may rewrite the allowlisted self/ SOPs (search, thinkdeep). " +
        "Run it AFTER the round's case writes so the model cites the cases just written. " +
        "focus: one line telling the agent what this round is about (cite the cases you just wrote).",
      inputSchema: z.object({
        sliceId: z.string(),
        focus: z.string().describe("What this round is about — cite the cases just written, if any."),
      }),
      execute: async ({ sliceId, focus }) => {
        const slice = await loadSlice(sliceId).catch(() => null);
        if (!slice) return `（切片 ${sliceId} 读不到——evolve 跳过。）`;
        const userModel = await readUserModel().catch(() => null);
        const directionCurrent = userModel?.direction ?? null;
        // HQ owns no turn analysis — the direction half gets the minimal one
        // (the freshest evidence is the closed slice itself, read through the readers).
        const minimalAnalysis: TurnAnalysis = {
          memoryWorthy: true,
          emotionalSignal: { intensity: "none", register: "neutral", note: "" },
        };
        const card = await runCardEvolution({
          model,
          sliceId,
          closedSliceId: sliceId,
          recentTurns: slice.turns.map((t) => ({ role: t.role, content: t.content })),
          focus,
          signal: "slice_closed",
          readers: buildRunCardReaders(),
          todayDate: date,
          directionEval: {
            current: directionCurrent,
            mode: detectDirectionMode(directionCurrent),
            cardSelfModel: null,
            analysis: minimalAnalysis,
          },
          allowedSopWrites: ["search", "thinkdeep"],
        });
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
        if (!slice) return `（切片 ${sliceId} 读不到——research 跳过。）`;
        const result = await runDocResearchPass({
          model,
          sliceId,
          excerpt: buildSliceExcerpt(slice),
          manifest: await buildRunManifest(),
          date,
        });
        return (
          `ran: ${result.ran}\n` +
          `written: ${result.written.join("、") || "（无）"}\n` +
          `skipped: ${result.skipped.map((s) => `${s.id}（${s.reason}）`).join("、") || "（无）"}`
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
        "A substantive veto's REASON also lands here as prose (or in the relevant case body) — never as a counter.",
      inputSchema: z.object({
        agent: z.enum(["search", "thinkdeep"]),
        content: z.string().describe("The FULL new SOP text — dated factual accounts with the rules they motivated, evidence (slice ids) cited in the prose, no builder vocabulary."),
      }),
      execute: async ({ agent, content }) => {
        await writeSelfSop(agent, content);
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
 * Handle one field dispatch. Never throws: a failed round returns
 * `{ actions: [], note: "", error }` — HQ's products are writes, and a failed
 * round simply has none.
 */
export async function handleBrief(input: HqBriefInput): Promise<HqOutcome> {
  "use step";
  const { brief, date, sliceId } = input;

  const model = backgroundModel();
  if (!model) {
    console.warn("[HQ] no default model configured — idle");
    return { actions: [], note: "", error: "no default model configured" };
  }

  const prompt =
    `## 外勤简报（${date}${sliceId ? ` — 关于切片 ${sliceId}` : ""}）\n\n` +
    `${brief}\n\n` +
    `先核对原始记录再动手。做完（或决定什么都不做）后调 hqReport。`;

  const result = await runSubAgent<HqReport>({
    model,
    system: buildSubAgentSystem(HQ_ROLE),
    prompt,
    tools: buildHqTools(date, model),
    toolChoice: "required",
    reportToolName: "hqReport",
    reportSchema: hqReportSchema,
    maxSteps: 50,
    // Above the internal composite passes' budgets (the merged card pass
    // carries 240s) — HQ must outlive any single tool call it makes.
    timeoutMs: 300_000,
  });

  if (!result.ok || !result.report) {
    const error = result.error ?? "HQ ended without a report";
    console.warn(`[HQ] round failed: ${error}`);
    return { actions: [], note: "", error };
  }
  console.log(`[HQ] round done: ${result.report.actions.length} action(s)`);
  return { actions: result.report.actions, note: result.report.note };
}
