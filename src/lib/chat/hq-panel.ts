/**
 * The companion pod's pure panel logic (v0.40 §2.3/§6) — the 一键停 tiers
 * and the per-layer degradation notes. Kept out of the component so the
 * rules stay unit-testable: the tiers' call targets and confirm policy, and
 * 「看不到 ≠ 没有」 — every degraded layer names ITS failure, never the
 * empty fact.
 */
import type {
  HQStatusResponse,
  PanelRunRow,
} from "@/app/api/evolution/hq-status/route";

// ─── 一键停分档 (§2.3) ─────────────────────────────────────────────────────

export interface StopTier {
  /** Stable id — the test pins these three. */
  tier: "turn" | "burst" | "reflection";
  /** i18n key for the menu line. */
  labelKey: string;
  /** i18n key for the consequence sentence (confirm text / tooltip). */
  consequenceKey: string;
  /** 后果的有无决定确认的厚薄: only interrupting an ANSWER confirms. */
  confirm: boolean;
}

/**
 * The tiers ONE row's 停 button offers (§2.3 — 一次点击先给分档):
 * a turn row offers 停本轮 (confirm) plus 停这一批 when it carries a burst
 * id; a writer row offers only its own 停归档 (no confirm — the answer is
 * already delivered, there is no consequence to weigh); the reflection
 * row's tier comes from `reflectionStopTier`.
 */
export function stopTiersFor(row: PanelRunRow): StopTier[] {
  if (row.role === "turn") {
    const tiers: StopTier[] = [
      {
        tier: "turn",
        labelKey: "hqStopTierTurn",
        consequenceKey: "hqStopTierTurnConsequence",
        confirm: true,
      },
    ];
    if (row.burst) {
      tiers.push({
        tier: "burst",
        labelKey: "hqStopTierBurst",
        consequenceKey: "hqStopTierBurstConsequence",
        confirm: true,
      });
    }
    return tiers;
  }
  if (row.role === "summary") {
    return [
      {
        tier: "turn",
        labelKey: "hqStopTierSummary",
        consequenceKey: "hqStopSummaryTip",
        confirm: false,
      },
    ];
  }
  return [];
}

/** The reflection row's tier — no confirm, the tooltip carries the cost. */
export function reflectionStopTier(): StopTier {
  return {
    tier: "reflection",
    labelKey: "hqStopTierReflection",
    consequenceKey: "hqStopReflectionTip",
    confirm: false,
  };
}

/**
 * Resolve a tier's cancel TARGETS against the live table (§2.3 — 走既有
 * 取消路径, one cancel per runId, no new machinery): 停本轮 = the row
 * itself; 停这一批 = every live row sharing the burst id (turns + writers
 * of that batch); 停后台反思 = the reflection row's own runId.
 */
export function resolveStopTargets(
  tier: StopTier["tier"],
  row: PanelRunRow,
  rows: PanelRunRow[],
  reflectionRunId: string | null,
): string[] {
  if (tier === "reflection") return reflectionRunId ? [reflectionRunId] : [];
  if (tier === "burst") {
    if (!row.burst) return [];
    return rows
      .filter((r) => r.burst === row.burst)
      .map((r) => r.runId);
  }
  return [row.runId];
}

// ─── 批次标签 (burst 的人话显示) ────────────────────────────────────────────

/**
 * The burst id's READABLE suffix for the panel — the user-facing label shows
 * 同批 <suffix>, never the raw id: a `burst-` prefix is stripped, and a long
 * id (a UUID in production) collapses to its last 4 chars. The internal
 * field stays `burst`; only the display goes through here.
 */
export function burstDisplaySuffix(burst: string): string {
  const body = burst.replace(/^burst-/, "");
  return body.length <= 4 ? body : body.slice(-4);
}

/**
 * The 人话旁注 for a layer that could NOT be read — null for a layer that
 * answered (including 事实空: the reflection row's "none" is a TRUE verdict
 * — 后台整理没在跑 is real information, not a missing read, so it earns no
 * apology note). The keys returned are i18n keys; the pod renders them under
 * the layer's own degradation line. v0.11 streams: `log` is OPTIONAL — the
 * status and log layers fetch separately, so a missing log here means
 * "not loaded yet" (no note), not a failed read.
 */
export function layerDegradationNote(
  layer: "reflection" | "runs" | "log",
  response: Pick<HQStatusResponse, "reflection" | "runs" | "log"> | null,
): string | null {
  if (!response) return "hqNoteOffline"; // 全灭 — the fetch itself failed
  if (layer === "reflection" && response.reflection.state === "unreachable") {
    return "hqNoteReflectionUnreachable";
  }
  if (layer === "runs" && response.runs.state === "unavailable") {
    return "hqNoteRunsUnavailable";
  }
  if (layer === "log" && response.log !== undefined && response.log !== null) {
    return response.log.state === "unavailable" ? "hqNoteLogUnavailable" : null;
  }
  return null;
}

// ─── 终结去抖 (v0.11 streams — event-driven log refresh) ───────────────────

/**
 * Debounce a log refresh across run terminals: several watched runs
 * finishing within the window (a burst's last turn + its summary land
 * together) must trigger ONE refresh, not N. Every call inside the window
 * resets the clock — the newest terminal is the one worth reflecting.
 */
export function createTerminalDebounce(
  trigger: () => void,
  waitMs: number,
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return () => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      trigger();
    }, waitMs);
  };
}
