/**
 * Background-stream step functions (v0.19 §A.2.3, v0.21 §5) — full Node.js,
 * retried automatically on failure. Kept in a SEPARATE module from the
 * workflow entries (`boundary-run.ts` / `question-run.ts`) so their
 * Node-dependent imports never enter the deterministic workflow sandbox —
 * the same split as chat's turn-workflow.ts / steps.ts.
 *
 * v0.21: the boundary run's fixed ①→②→③ sequence is RETIRED as the HQ form
 * (HQ is an agent + tools now — see hq-agent.ts); this module keeps the
 * interim entries compilable until P4 retires the trigger chain, and hosts
 * the shared helpers the HQ agent's tools reuse (buildRunManifest /
 * buildRunCardReaders / backgroundModel).
 *
 * HQ stores RESULTS ONLY (v0.21 §5): an idle round writes nothing — there is
 * no run ledger anymore (the old self/evolution reflection line, written on
 * every pass and doubled as the mechanical re-run dedup, is gone). Dedup is
 * entirely writer-is-reader: a re-run reads the current case state and goes
 * idle when it already reflects the slice. A substantive veto leaves its
 * REASON as prose in self/ or the relevant case body.
 *
 *   boundaryRun — interim shell (P4 retires): ① the case writer, ② the
 *     user model (people/user/index.md — AFTER ① so it can cite the cases
 *     ① just wrote; SOP writes ride ②'s run). Empty is legal.
 *
 *   questionRun — the conversation's sub-stream for user-requested long
 *     work (v0.21 §2): the doc-research pass investigates and writes
 *     research/ hypotheses/ cases; when anything landed, a tasks/
 *     completion notice is what the NEXT turn's reply segment reads and
 *     states. The runs have no mouth — products land in cases.
 */
import {
  loadSlice,
  readSlicePart,
  slicePartPathCandidates,
  type SlicePart,
} from "@/lib/episodic";
import { parseSliceId, parseTurns } from "@/lib/episodic/turn-parser";
import { fsListFiles, fsReadFile } from "@/lib/episodic/io-helpers";
import {
  buildSliceExcerpt,
  runLibrarianPass,
  applyCaseWriteIntent,
  extractDocMarkers,
  extractProcessedMarkerIds,
  RESEARCH_RECORD_PREFIX,
  type CaseWriterManifest,
} from "@/lib/episodic/flash/librarian";
import { runDocResearchPass } from "@/lib/episodic/flash/doc-research";
import type { TurnAnalysis } from "@/lib/episodic/flash/turn-analyzer";
import { getModel, getDefaultModelId } from "@/lib/models/registry";
import { readUserModel } from "@/lib/evolution/store";
import { detectDirectionMode } from "@/lib/evolution/direction-agent";
import {
  runCardEvolution,
  type CardEvolutionReaders,
} from "@/app/api/evolution/run-card-evolution";

// ─── Shared input shapes (serializable — they cross the run boundary) ──────

export interface BoundaryRunInput {
  /** The slice that just closed (the boundary event's subject). */
  sliceId: string;
  /** User-local date (YYYY-MM-DD) — every write stamps the user's clock. */
  date: string;
}

export interface QuestionRunInput {
  /** The slice whose agent.md mailbox carries the question markers. */
  sliceId: string;
  /** User-local date (YYYY-MM-DD). */
  date: string;
}

// ─── Shared helpers ────────────────────────────────────────────────────────

/** The deployment's default model — a background run has no turn input.
 *  Exported for the HQ agent (hq-agent.ts). */
export function backgroundModel() {
  return getModel(getDefaultModelId());
}

/**
 * The listTree manifest for a writer pass — the same mechanical walk the
 * reply segment's listTree tool does (memory/, config/ filtered out,
 * records/ collapsed to slice dirs), rebuilt here on the env-driven io layer
 * so a background run needs no ToolContext. Exported for the HQ agent's
 * listTree tool (hq-agent.ts).
 */
export async function buildRunManifest(): Promise<CaseWriterManifest> {
  const paths: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries: Awaited<ReturnType<typeof fsListFiles>>;
    try {
      entries = await fsListFiles(dir);
    } catch {
      return; // missing dir — a fresh memory root, fine
    }
    for (const e of entries) {
      const p = `${dir}/${e.name}`;
      if (e.type === "dir") {
        await walk(p);
      } else if (p.startsWith("memory/") && !p.startsWith("memory/config/")) {
        paths.push(p.slice("memory/".length));
      }
    }
  };
  await walk("memory");

  const tree: Record<string, string[]> = {};
  for (const rel of paths) {
    const top = rel.split("/")[0] ?? rel;
    // records/YYYY/MM/DD/HHMM/<file> → the slice dir is the record's identity.
    const key =
      top === "records" ? rel.split("/").slice(0, 5).join("/") : rel;
    const list = (tree[top] ??= []);
    if (!list.includes(key)) list.push(key);
  }
  for (const list of Object.values(tree)) list.sort();
  return { truncated: false, tree };
}

/**
 * Card-evolution readers for a background run — the same dual-root probes
 * the turn path's buildCardReaders does, but on the env-driven io layer
 * (a background run carries no TurnInput backend flags). Exported for the HQ
 * agent's tools (hq-agent.ts).
 */
export function buildRunCardReaders(): CardEvolutionReaders {
  const readDual = async (sliceId: string, part: SlicePart): Promise<string> => {
    const [primary, fallback] = slicePartPathCandidates(sliceId, part);
    try {
      return await fsReadFile(primary);
    } catch {
      return fsReadFile(fallback);
    }
  };
  return {
    readSlice: async (sid, range) => {
      if (!parseSliceId(sid)) return `ERROR: Invalid slice ID.`;
      const raw = await readDual(sid, "core");
      if (range && range.type === "last") {
        const { turns } = parseTurns(raw);
        const n = range.count ?? 3;
        return turns
          .slice(-n)
          .map((t) => `${t.header}\n${t.content}`)
          .join("\n");
      }
      return raw;
    },
    readAgentTimeline: async (sid) => {
      if (!parseSliceId(sid)) return `(invalid slice: ${sid})`;
      return readDual(sid, "agent").catch(() => `(agent.md not found: ${sid})`);
    },
    readPreviously: async (sid) => {
      if (!parseSliceId(sid)) return `(invalid slice: ${sid})`;
      return readDual(sid, "previously").catch(
        () => `(previously not found: ${sid})`,
      );
    },
  };
}

// ─── The boundary run (§A.2.3-a — interim shell, retired by P4) ──────────

export interface BoundaryRunOutcome {
  /** False when the run never executed (already processed / no slice / no model). */
  ran: boolean;
  /** What ① the case writer landed (memory-relative paths). */
  written: string[];
  /** Whether ② moved the user model. */
  cardChanged: boolean;
}

export async function executeBoundaryRun(
  input: BoundaryRunInput,
): Promise<BoundaryRunOutcome> {
  "use step";
  const { sliceId, date } = input;
  const idle: BoundaryRunOutcome = { ran: false, written: [], cardChanged: false };

  // No run ledger (v0.21 §5 — results only): dedup is writer-is-reader inside
  // the passes themselves; this shell just runs them.
  const slice = await loadSlice(sliceId).catch(() => null);
  if (!slice) {
    console.warn(`[BoundaryRun] ${sliceId} unreadable — nothing to process`);
    return idle;
  }
  const model = backgroundModel();
  if (!model) {
    console.warn("[BoundaryRun] no default model configured — idle");
    return idle;
  }

  const excerpt = buildSliceExcerpt(slice);
  const manifest = await buildRunManifest();

  // ① Case writer — which cases did this slice touch? (the old librarian,
  // lifted out of the scribe segment in A1). Never throws.
  const librarian = await runLibrarianPass({
    model,
    closedSliceId: sliceId,
    excerpt,
    manifest,
    date,
  });
  console.log(
    `[BoundaryRun] ① case writer: ${librarian.written.length} written, ${librarian.skipped.length} skipped`,
  );

  // ② User model — AFTER ① so it cites the cases ① just wrote. The ①→②
  // seam is explicit: ①'s written list rides the focus line into ②'s note.
  const userModel = await readUserModel().catch(() => null);
  const directionCurrent = userModel?.direction ?? null;
  // A boundary run owns no turn analysis — the direction half gets the
  // minimal one (the freshest evidence is the closed slice itself, which the
  // agent reads through the readers).
  const minimalAnalysis: TurnAnalysis = {
    memoryWorthy: true,
    emotionalSignal: { intensity: "none", register: "neutral", note: "" },
  };
  const card = await runCardEvolution({
    model,
    sliceId,
    closedSliceId: sliceId,
    recentTurns: slice.turns.map((t) => ({ role: t.role, content: t.content })),
    focus:
      `① 档案员刚更新的 case：${librarian.written.join("、") || "（无——①空转）"}。` +
      `用户模型的更新应引用这些 case（若有），而不是泛泛而谈。`,
    signal: "slice_closed",
    readers: buildRunCardReaders(),
    todayDate: date,
    directionEval: {
      current: directionCurrent,
      mode: detectDirectionMode(directionCurrent),
      cardSelfModel: null,
      analysis: minimalAnalysis,
    },
    // ③'s craft half — SOP rewrites ride this one merged run (§C.2). Only
    // colleagues with a LIVE spawn-time SOP load are allowlisted (search,
    // thinkdeep) — recall is retired (v0.19 R6, review M7).
    allowedSopWrites: ["search", "thinkdeep"],
  });
  console.log(
    `[BoundaryRun] ② user model: changed=${card.changed}${card.error ? ` error=${card.error}` : ""}`,
  );

  return { ran: true, written: librarian.written, cardChanged: card.changed };
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
