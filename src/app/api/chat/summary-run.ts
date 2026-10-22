/**
 * Incremental summary persistence (v0.42, updated by 711419c).
 * Each burst turn durably starts a run carrying its own record. Completed
 * siblings enhance the batch; the own payload survives registry failure.
 * One bounded step locates saved identities before selecting a landing,
 * appends only missing material, commits, and rings the reflection bell.
 * Duplicate deliveries converge through record identity and Git ref CAS.
 */
import type {
  SummaryRunPayload,
  SummaryRunOutcome,
} from "@/lib/chat/turn-types";
import { persistTurnSummary, closeChildStream } from "./steps";

export async function summaryRun(
  payload: SummaryRunPayload,
): Promise<SummaryRunOutcome> {
  "use workflow";

  // The burst's persistence: one step, one batch, one commit. The durable
  // payload rides the run; the step re-reads the slice fresh and converges
  // under redelivery (turnId-keyed dedupe).
  try {
    return await persistTurnSummary(payload);
  } finally {
    await closeChildStream();
  }
}
