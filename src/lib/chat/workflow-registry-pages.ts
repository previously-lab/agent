import type { getWorld } from "workflow/runtime";

type World = Awaited<ReturnType<typeof getWorld>>;
type ListOptions = NonNullable<Parameters<World["runs"]["list"]>[0]>;

/** Fetch metadata a page at a time. A caller looking for one historical run can
 * stop at its first exact match without materializing the rest of the registry. */
export async function* workflowRegistryPages(world: World, filter: Pick<ListOptions, "status" | "workflowName"> = {}) {
  let cursor: string | undefined;
  const seen = new Set<string>();
  do {
    const page = await world.runs.list({ ...filter, pagination: { limit: 100, sortOrder: "desc", cursor }, resolveData: "none" });
    yield page.data;
    if (!page.hasMore) return;
    if (!page.cursor || seen.has(page.cursor)) throw new Error("Workflow registry pagination did not advance");
    cursor = page.cursor;
    seen.add(cursor);
  } while (true);
}
