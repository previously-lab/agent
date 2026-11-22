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
  const live = new Map<string, { runId: string; status: string; createdAt: string; triggeredAt?: string }>();
  // Read pending before running so a run transitioning between the two
  // queries remains discoverable. The later observation wins on overlap.
  for (const status of ["pending", "running"] as const) {
    let cursor: string | undefined;
    do {
      const page = await world.runs.list({ status, pagination: { limit: 100, ...(cursor ? { cursor } : {}) }, resolveData: "none" });
      for (const entry of page.data) {
        if (entry.status !== status || entry.attributes?.role !== "dialogueOrchestrator" ||
            entry.attributes.scope !== scope || !entry.createdAt) continue;
        live.set(entry.runId, { runId: entry.runId, status, createdAt: new Date(entry.createdAt).toISOString(),
          triggeredAt: entry.attributes.triggeredAt });
      }
      if (!page.hasMore) break;
      if (!page.cursor || page.cursor === cursor) throw new Error("Dialogue registry pagination did not advance");
      cursor = page.cursor;
    } while (true);
  }
  const matches = [...live.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const latest = matches[0];
  if (!latest) return Response.json({ runId: null, status: "absent", runs: [] });
  return Response.json({ ...latest, runs: matches.toReversed() });
}
