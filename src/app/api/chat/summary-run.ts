/**
 * The summary run (v0.42 §1/§2) — the burst's 被动存盘 in ONE commit.
 *
 * The last conversation flow of a burst starts this run DURABLY, CARRYING its
 * own turn record in the payload (the turn answers exist only in the runs'
 * memory/streams — the payload IS the persistence intent; a pointer would be
 * a collector machine). The run's whole job is the single persistTurnSummary
 * step: collect the burst's member records (completed siblings' returnValues;
 * failed members recorded honestly), apply the page seals the beats decided,
 * append user turns + replies + cognitions + the merge line, and flush ONE
 * `Summary — {sliceId}` commit — then ring the reflection bell carrying the
 * persisted range. It exits when the commit settles — no clocks, no waiting,
 * no mouth.
 *
 * Double-fire (two last-turns racing) is absorbed by the step's opening
 * dedupe (isLiveParallelSummary), the v0.33 discipline unchanged.
 */
import type {
  SummaryRunPayload,
  SummaryRunOutcome,
} from "@/lib/chat/turn-types";
import { persistTurnSummary } from "./steps";

export async function summaryRun(
  payload: SummaryRunPayload,
): Promise<SummaryRunOutcome> {
  "use workflow";

  // The burst's persistence: one step, one batch, one commit. The durable
  // payload rides the run; the step re-reads the slice fresh and converges
  // under redelivery (turnId-keyed dedupe).
  return await persistTurnSummary(payload);
}
