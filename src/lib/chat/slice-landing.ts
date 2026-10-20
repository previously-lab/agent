/**
 * The summary stream's landing judgment (v0.42 §1/§2 — the user's words:
 * 「总结流是去看这几个已经完成的对话流，然后决定开新片还是续写」).
 *
 * THE SAME thresholds the turn's entry beat used until v0.42 (idle gap /
 * time cap / capacity — steps.ts carried them inline), re-applied when the
 * WHOLE burst has answered, with the BATCH'S FIRST TURN as the reference
 * moment: the conversation effectively resumed then. Pure — the step owns
 * every read (the edge slice, the members); this module owns the judgment.
 */
import type { SlicingSignal } from "@/lib/episodic/types";

/** The three slicing knobs — the same shape TurnInput.config.slicing carries. */
export interface SliceLandingConfig {
  idleGapMinutes: number;
  maxSliceMinutes: number;
  maxTurnsPerSlice: number;
}

/** The edge slice as the judgment consumes it (the step reads the rest). */
export interface EdgeSliceStats {
  sliceId: string;
  /** The slice's start (ISO 8601). */
  start: string;
  /** The newest turn's timestamp (ISO 8601; null when the slice is empty). */
  lastTurnAt: string | null;
  /** Total turns on the edge slice. */
  turnCount: number;
}

export type SliceLanding =
  /** Answer into the edge slice — no seal, no new page. */
  | { kind: "continue-edge" }
  /** No edge on disk at all — mint the first page (nothing to seal). */
  | { kind: "fresh" }
  /**
   * Seal the edge and open a new page. `checkpoint` (time_cap / capacity) =
   * the SAME conversation autosaved — the successor carries `continuesFrom`;
   * `idle_gap` = a genuine conversation boundary — no link.
   */
  | { kind: "open-new"; signal: SlicingSignal; checkpoint: boolean };

export function judgeSliceLanding(
  edge: EdgeSliceStats | null,
  /** The batch's first turn, ms since epoch — the reference moment. */
  batchFirstAtMs: number,
  cfg: SliceLandingConfig,
): SliceLanding {
  if (!edge) return { kind: "fresh" };
  const idleMs = cfg.idleGapMinutes * 60_000;
  const capMs = cfg.maxSliceMinutes * 60_000;
  // Idle gap FIRST (the entry beat's own order): a long silence since the
  // edge's last turn means the user left and came back — a genuinely new
  // conversation, never a checkpoint.
  const lastMs = edge.lastTurnAt ? Date.parse(edge.lastTurnAt) : NaN;
  if (!Number.isNaN(lastMs) && batchFirstAtMs - lastMs >= idleMs) {
    return { kind: "open-new", signal: "idle_gap", checkpoint: false };
  }
  // The age cap is a periodic autosave CHECKPOINT, not a conversation end.
  const startMs = Date.parse(edge.start);
  if (!Number.isNaN(startMs) && batchFirstAtMs - startMs >= capMs) {
    return { kind: "open-new", signal: "time_cap", checkpoint: true };
  }
  if (edge.turnCount >= cfg.maxTurnsPerSlice) {
    return { kind: "open-new", signal: "capacity", checkpoint: true };
  }
  return { kind: "continue-edge" };
}
