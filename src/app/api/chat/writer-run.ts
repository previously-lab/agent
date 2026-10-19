/**
 * The writer run (v0.38 §3.2/§4) — ONE turn's reply, ONE commit.
 *
 * The turn tail starts this run DURABLY, CARRYING the reply in its payload
 * (the reply exists only in the turn's memory/stream — the payload IS the
 * persistence intent; a pointer would be a collector machine, vetoed by
 * §4-2). The run's whole job is the single commitWriterTurn step: reply turn
 * (+ optional merge turn, both with the burst header segment) + cognition +
 * slice snapshot in ONE batch (`Turn {turnId} — reply`), then the reflection
 * bell when this turn sealed the slice. It exits when the commit settles —
 * no clocks, no waiting, no mouth.
 *
 * Single-flight is DEDUPE by turnId (§4): a live writer for the same turnId
 * exits; different turnIds write concurrently and their ref conflicts are
 * absorbed by the flush's key-controlled merge + bounded self-heal.
 */
import type {
  WriterRunPayload,
  WriterRunOutcome,
} from "@/lib/chat/turn-types";
import { commitWriterTurn } from "./steps";

export async function writerRun(
  payload: WriterRunPayload,
): Promise<WriterRunOutcome> {
  "use workflow";

  // The reply's persistence: one step, one batch, one commit. The durable
  // payload rides the run; the step re-reads the slice fresh and converges
  // under redelivery (turnId-keyed dedupe).
  return await commitWriterTurn(payload);
}
