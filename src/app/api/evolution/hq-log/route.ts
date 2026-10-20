/**
 * GET /api/evolution/hq-log — the log layer alone (v0.11 streams).
 *
 * The panel's log face (水位 / recent rounds / recent archives) is EVENT-
 * DRIVEN, never polled: it is read on three occasions only — the panel's
 * first open, a watched run's stream reaching its terminal frame, and the
 * reader's manual refresh. Each read costs ONE bounded commit-log scan
 * (three 100-entry pages at most on GitHub; one capped local read) plus one
 * slice enumeration for the behind count — no getCommit fan-out, no triple
 * scan. The shape is exactly hq-status's log layer (readLogLayer is shared);
 * the degradation contract is unchanged (「看不到」绝不渲染成「没有」).
 */
import { readLogLayer, type HQLogLayer } from "@/app/api/evolution/hq-status/route";

export const dynamic = "force-dynamic";

export interface HQLogResponse {
  asOf: string;
  log: HQLogLayer;
}

export async function GET(): Promise<Response> {
  const asOf = new Date().toISOString();
  const log = await readLogLayer();
  const body: HQLogResponse = { asOf, log };
  return Response.json(body);
}
