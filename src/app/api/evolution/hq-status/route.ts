/**
 * GET /api/evolution/hq-status — the companion pod's aggregate read
 * (v0.39 §4.1), two layers assembled in one answer (v0.11 streams: the log
 * layer moved to GET /api/evolution/hq-log and only rides here with ?log=1):
 *
 *   公开层  reflection — the hook channel: getHookByToken(REFLECTION_TOKEN)
 *           → runId → getRun: status/createdAt + the run's own attributes
 *           (rounds / lastError / tookOver). This layer is PUBLIC API and
 *           always renders — "无人在家" is a verdict, never an absence.
 *   运行时层 runs — getWorld().runs.list (resolveData "none"): every live
 *           run's role/slice/turn/burst + age. 增强层 ONLY — when the
 *           runtime interface is unavailable the layer degrades to an
 *           explicit "运行表不可用" row, never to fabricated rows or a
 *           silent blank (§4.1 降级矩阵).
 *
 * The route is STATELESS ASSEMBLY and writes NOTHING. 面板无正确性依赖
 * (§6): this route 500-ing changes nothing about turns, writers, or
 * reflection. The heavy GitHub reads live behind /api/evolution/hq-log,
 * fetched on panel open / a run's stream terminal / manual refresh only —
 * polling THIS route costs zero GitHub calls (v0.11 streams).
 */
import { getHookByToken, getRun } from "workflow/api";
import { HookNotFoundError } from "workflow/errors";
import { getWorld } from "workflow/runtime";
import { REFLECTION_TOKEN } from "@/app/api/evolution/reflection-run";
import { isLiveRunStatus, type ParallelRunEntry } from "@/lib/chat/parallel-runs";
import { readHQLogBundle, type RecentSummaryEntry } from "@/lib/chat/hq-log";
import { enumerateSliceIds } from "@/lib/episodic/timeline/enumerate";

export const dynamic = "force-dynamic";

/** One live run row (the 在跑表) — attributes read straight off the registry. */
export interface PanelRunRow {
  runId: string;
  status: string;
  /** "turn" | "writer" | "reflection" | null (unattributed). */
  role: string | null;
  slice: string | null;
  turn: string | null;
  burst: string | null;
  ageMs: number | null;
}

/** 日志层 — the cursor/water level + recent rounds (降级显式). */
export type HQLogLayer =
  | {
      state: "live";
      cursor: { sliceId: string; sha: string | null; at: string | null } | null;
      behind: number | null;
      recentRounds: Array<{
        date: string;
        note: string | null;
        at: string | null;
        seen: string | null;
        evolved: string | null;
        superseded: boolean;
      }>;
      /** v0.43 §5 — the newest few `Summary —` bodies, parsed for the panel. */
      recentSummaries: RecentSummaryEntry[];
      /** False when the summary log's own read degraded (panel shows a note). */
      summariesAvailable: boolean;
      summariesReason?: string;
    }
  | { state: "unavailable"; reason: string };

export interface HQStatusResponse {
  asOf: string;
  /** 公开层 — the reflection unit through the hook channel. */
  reflection:
    | {
        state: "live";
        runId: string;
        status: string;
        startedAt: string | null;
        ageMs: number | null;
        attributes: { rounds?: string; lastError?: string; tookOver?: string };
      }
    | { state: "none" }
    | { state: "unreachable"; reason: string };
  /** 运行时层 — the live-runs table (增强层, explicit degradation). */
  runs:
    | { state: "live"; live: PanelRunRow[] }
    | { state: "unavailable"; reason: string };
  /**
   * 日志层 — OPTIONAL (v0.11 streams): absent by default, present only with
   * ?log=1 (legacy/debug). The panel reads it from /api/evolution/hq-log on
   * open / run-terminal / manual refresh — never on the 3s status poll.
   */
  log?: HQLogLayer;
}

function toEpochMs(v: Date | string | null | undefined): number | null {
  if (v == null) return null;
  const ms = v instanceof Date ? v.getTime() : Date.parse(v);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * 日志层 assembly (v0.11 streams): ONE bounded commit-log scan feeds the
 * cursor, the recent rounds AND the recent summaries; the behind count adds
 * one slice enumeration. Shared by /api/evolution/hq-log (the panel's
 * event-driven read) and hq-status's ?log=1 legacy face.
 */
export async function readLogLayer(): Promise<HQLogLayer> {
  const bundle = await readHQLogBundle();
  if (!bundle.available) {
    return { state: "unavailable", reason: bundle.reason ?? "log unavailable" };
  }
  const d = bundle.derivation;
  let behind: number | null = null;
  try {
    const rels = await enumerateSliceIds();
    const ids = rels.map((rel) => rel.replaceAll("/", "-")).sort();
    behind = d.cursor.sliceId
      ? ids.filter((id) => id > d.cursor.sliceId!).length
      : ids.length;
  } catch {
    behind = null; // the count is a glance — an enumeration hiccup degrades it
  }
  return {
    state: "live",
    cursor: d.cursor.sliceId
      ? { sliceId: d.cursor.sliceId, sha: d.cursor.sha, at: d.cursor.at }
      : null,
    behind,
    recentRounds: d.rounds.slice(0, 5).map((e) => ({
      date: e.parsed.date,
      note: e.parsed.note,
      at: e.committedAt,
      // v0.42 — turn-level marks (scope order): the furthest slice id is
      // the slice-level display water level.
      seen: e.parsed.trailer?.seen?.at(-1)?.sliceId ?? null,
      evolved: e.parsed.trailer?.evolved?.date ?? null,
      superseded: e.parsed.trailer?.superseded === true,
    })),
    // Summaries derive from the SAME scan — when the scan answered, they did.
    recentSummaries: d.summaries,
    summariesAvailable: true,
  };
}

export async function GET(request: Request): Promise<Response> {
  const asOf = new Date().toISOString();
  const nowMs = Date.now();

  // ── 公开层: the reflection unit via the hook channel ──
  let reflection: HQStatusResponse["reflection"];
  try {
    const hook = (await getHookByToken(REFLECTION_TOKEN)) as {
      runId?: string;
    } | null;
    const runId = hook?.runId;
    if (!runId) {
      reflection = { state: "none" };
    } else {      const run = getRun(runId);
      const [status, createdAt, rawAttributes] = await Promise.all([
        run.status,
        run.createdAt,
        // The run's own attributes (rounds/lastError/tookOver) — read through
        // the registry list when the handle lacks the accessor (the runtime
        // interface is the enhancement layer anyway).
        (run as { attributes?: Promise<Record<string, string> | null> }).attributes ??
          Promise.resolve(null),
      ]);
      const attributes = (rawAttributes ?? {}) as Record<string, string>;
      reflection = {
        state: "live",
        runId,
        status,
        startedAt: createdAt ? new Date(createdAt).toISOString() : null,
        ageMs: toEpochMs(createdAt) !== null ? Math.max(0, nowMs - (toEpochMs(createdAt) as number)) : null,
        attributes: {
          ...(attributes.rounds ? { rounds: attributes.rounds } : {}),
          ...(attributes.lastError ? { lastError: attributes.lastError } : {}),
          ...(attributes.tookOver ? { tookOver: attributes.tookOver } : {}),
        },
      };
    }
  } catch (e) {
    // v0.39 §4.1 — a MISSING hook is the verdict "无人在家" (the token is
    // released at run terminal state); only a genuine channel failure is
    // "unreachable". 「看不到」绝不渲染成「没有」applies to DATA, not to
    // the unit's liveness.
    if (HookNotFoundError.is(e)) {
      reflection = { state: "none" };
    } else {
      reflection = {
        state: "unreachable",
        reason: `hook channel failed: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }

  // ── 运行时层: the live-runs table (增强层 — degrade loudly) ──
  let runs: HQStatusResponse["runs"];
  try {
    const world = await getWorld();
    const page = await world.runs.list({
      pagination: { limit: 100 },
      resolveData: "none",
    } as Parameters<typeof world.runs.list>[0]);
    const live: PanelRunRow[] = page.data
      .filter((r) => isLiveRunStatus((r as ParallelRunEntry).status))
      .map((r) => {
        const entry = r as ParallelRunEntry;
        const attrs = entry.attributes ?? {};
        const created = toEpochMs(entry.createdAt);
        return {
          runId: entry.runId,
          status: entry.status,
          role: attrs.role ?? null,
          slice: attrs.slice ?? null,
          turn: attrs.turn ?? null,
          burst: attrs.burst ?? null,
          ageMs: created !== null ? Math.max(0, nowMs - created) : null,
        };
      });
    runs = { state: "live", live };
  } catch (e) {
    runs = {
      state: "unavailable",
      reason: `run registry unavailable (runtime interface): ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  // ── 日志层: OPTIONAL — only with ?log=1 (the panel reads /api/evolution/hq-log
  // on open / run-terminal / manual refresh — never on the 3s status poll) ──
  const includeLog = new URL(request.url).searchParams.get("log") === "1";
  const log = includeLog ? await readLogLayer() : undefined;

  const body: HQStatusResponse = { asOf, reflection, runs, ...(log ? { log } : {}) };
  return Response.json(body);
}
