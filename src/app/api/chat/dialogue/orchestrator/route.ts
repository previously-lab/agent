import { getWorld } from "workflow/runtime";
import { guardDialogueRead, resolveDialogueScope } from "@/lib/dialogue/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Discover the current or most recent dialogue run without any control store. */
export async function GET(request: Request): Promise<Response> {
  const blocked = guardDialogueRead(request);
  if (blocked) return blocked;
  const url = new URL(request.url);
  const scope = resolveDialogueScope(url.searchParams.get("persona"));
  const world = await getWorld();
  const rows: unknown[] = [];
  let cursor: string | undefined;
  do {
    const page = await world.runs.list({ pagination: { limit: 100, ...(cursor ? { cursor } : {}) }, resolveData: "none" });
    rows.push(...page.data);
    if (!page.hasMore) break;
    if (!page.cursor || page.cursor === cursor) throw new Error("Dialogue registry pagination did not advance");
    cursor = page.cursor;
  } while (true);
  const matches = rows.flatMap(row => {
    const entry = row as {
      runId: string;
      status: string;
      createdAt?: Date | string;
      attributes?: Record<string, string> | null;
    };
    if (entry.attributes?.role !== "dialogueOrchestrator" || entry.attributes.scope !== scope) return [];
    return [{
      runId: entry.runId,
      status: entry.status,
      createdAt: entry.createdAt ? new Date(entry.createdAt).toISOString() : undefined,
      triggeredAt: entry.attributes.triggeredAt,
    }];
  }).filter(entry => entry.createdAt && (entry.status === "pending" || entry.status === "running"))
    .sort((a, b) => b.createdAt!.localeCompare(a.createdAt!));
  const latest = matches[0];
  if (!latest) return Response.json({ runId: null, status: "absent", runs: [] });
  return Response.json({ ...latest, runs: matches.toReversed() });
}
