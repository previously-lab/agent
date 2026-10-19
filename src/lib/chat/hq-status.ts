/**
 * The companion pod's status client (v0.39 §4) — the fetch helper + types
 * for the three-layer aggregate (`GET /api/evolution/hq-status`) and the
 * panel's one write (`POST …/cancel`). The old rolling-pointer `HQStatus`
 * type retired with hq.json: nothing on the client normalizes a pointer
 * anymore — the route assembles the three planes and the pod renders them
 * with EXPLICIT degradation (「看不到」绝不渲染成「没有」).
 *
 * Pure — no fs, no next; the pod imports it client-side.
 */
import type {
  HQStatusResponse,
  PanelRunRow,
} from "@/app/api/evolution/hq-status/route";

export type { HQStatusResponse, PanelRunRow };

/** The panel's read. Throws on a non-2xx — a failure is the server's, and
 *  the pod renders its offline state instead of fabricating "no data". */
export async function fetchHQStatus(signal?: AbortSignal): Promise<HQStatusResponse> {
  const res = await fetch("/api/evolution/hq-status", {
    cache: "no-store",
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) throw new Error(`hq-status answered ${res.status}`);
  return (await res.json()) as HQStatusResponse;
}

/**
 * 一键停 (§4.3) — cancel ONE live run. The panel's only write; the target
 * is a run, never memory. Returns the engine's verdict; the caller re-reads
 * the aggregate after a success.
 */
export async function cancelPanelRun(runId: string): Promise<{ ok: boolean; reason?: string }> {
  try {
    const res = await fetch("/api/evolution/hq-status/cancel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runId }),
    });
    const body = (await res.json()) as { ok?: boolean; reason?: string };
    return { ok: res.ok && body.ok === true, reason: body.reason };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}
