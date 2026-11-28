import type { getWorld } from "workflow/runtime";

type World = Awaited<ReturnType<typeof getWorld>>;
type ListOptions = NonNullable<Parameters<World["runs"]["list"]>[0]>;

/** Fetch metadata a page at a time. Active discovery never looks at terminal
 * history; recovery may stop once a newest-first page is older than its window. */
export async function* workflowRegistryPages(
  world: World,
  filter: Pick<ListOptions, "status" | "workflowName"> = {},
  options: { terminalSince?: number } = {},
) {
  let cursor: string | undefined;
  const seen = new Set<string>();
  do {
    const page = await world.runs.list({ ...filter, pagination: { limit: 100, sortOrder: "desc", cursor }, resolveData: "none" });
    yield page.data;
    if (!page.hasMore) return;
    if (options.terminalSince !== undefined && page.data.length > 0 && page.data.every(row => {
      const createdAt = row.createdAt instanceof Date ? row.createdAt.getTime() : Date.parse(String(row.createdAt));
      return Number.isFinite(createdAt) && createdAt < options.terminalSince!;
    })) return;
    if (!page.cursor || seen.has(page.cursor)) throw new Error("Workflow registry pagination did not advance");
    cursor = page.cursor;
    seen.add(cursor);
  } while (true);
}
