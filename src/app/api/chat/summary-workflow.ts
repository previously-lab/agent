/**
 * Parallel batch summary (v0.33 §4) — the burst's closing beat.
 *
 * When the user fires several messages in a burst, each gets its own standard
 * turn run; the LAST surviving turn's tail check (startSummaryIfLastTurn in
 * steps.ts) starts THIS run. It reads the slice the burst landed on, writes a
 * 1–3 sentence closing for the batch as a whole (corrections resolve to the
 * latest statement — "not buns, dumplings" ends on dumplings), streams it
 * onto its own durable stream (the client's summary lane attaches there, the
 * NestedBubble child-stream precedent), and persists it as one agent turn.
 *
 * Discipline:
 *  - ONE model call, small and cheap (maxOutputTokens capped in the step);
 *    no tools, no identity prompt — a closing voice, not the agent.
 *  - The opening dedupe absorbs the double-fire race (two sibling tails
 *    checking in the same registry window): the YOUNGER of two live
 *    summaries for the same slice seals its stream (an attached lane
 *    settles as an empty beat) and exits — a createdAt tiebreak (runId
 *    order on a tie) keeps the absorption one-sided, so exactly one run
 *    survives to close the batch.
 *  - Every failure degrades silently: the batch's answers are already on
 *    disk; the closing is an enhancer, never a blocker.
 *
 * The run is started with seeded attributes `{role: "summary", slice}` so the
 * registry predicates (src/lib/chat/parallel-runs.ts) can tell it apart from
 * turn runs at creation time. It never participates in sibling counting.
 */
import { buildSummaryWindow } from "@/lib/chat/parallel-runs";
import type { SummaryRunInput } from "@/lib/chat/turn-types";
import {
  summaryDedupeCheck,
  readSliceTurnsForSummary,
  runBatchSummary,
  persistBatchSummary,
  closeSummaryStream,
} from "./steps";

export async function summaryWorkflow(input: SummaryRunInput): Promise<void> {
  "use workflow";

  // Opening dedupe: an OLDER live summary for this slice → exit. Not fully
  // silently: the client may already have attached a lane to THIS run's
  // stream (both spawn frames rode the tails), so seal the stream first —
  // the extra lane settles as an empty beat and folds away instead of
  // hanging on a live tail that would never end.
  if (await summaryDedupeCheck(input.sliceId)) {
    await closeSummaryStream();
    return;
  }

  const turns = await readSliceTurnsForSummary(input);
  const windowText = buildSummaryWindow(turns, input.locale);
  // Defensive: a burst always leaves turns — an empty/unreadable slice closes
  // the stream cleanly rather than failing the run.
  const text = windowText ? await runBatchSummary(input, windowText) : "";
  if (text) await persistBatchSummary(input, text);
  else if (windowText)
    // Loud, not silent: an empty closing skips the persist (the record simply
    // has no closing beat), and the next debugger must not have to decode
    // step payloads to tell "no call" from "empty reply" (phase 3 did).
    console.warn(
      `[Parallel] summary produced empty text (slice ${input.sliceId}) — nothing persisted`,
    );
  await closeSummaryStream();
}
