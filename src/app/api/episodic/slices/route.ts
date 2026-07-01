import { readSliceIndex } from "@/lib/episodic";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const before = searchParams.get("before"); // ISO date string
    const limit = Math.min(parseInt(searchParams.get("limit") ?? "10", 10), 50);

    if (!before) {
      return Response.json(
        { error: "before parameter is required (ISO date)" },
        { status: 400 }
      );
    }

    const beforeDate = new Date(before);
    if (isNaN(beforeDate.getTime())) {
      return Response.json(
        { error: "before must be a valid ISO date" },
        { status: 400 }
      );
    }

    const year = beforeDate.getUTCFullYear();
    const month = beforeDate.getUTCMonth() + 1;

    const index = await readSliceIndex(year, month);

    const beforeDay = beforeDate.getUTCDate();
    const filtered = index
      .filter((s) => {
        const day = parseInt(s.id, 10);
        return !isNaN(day) && day < beforeDay;
      })
      .sort((a, b) => b.start.localeCompare(a.start))
      .slice(0, limit);

    return Response.json({
      slices: filtered.map((s) => ({
        slice_id: `${before.slice(0, 7)}/${s.id}`,
        focus: s.focus,
        summary: s.summary,
        start: s.start,
        status: s.status,
        open_loops: s.open_loops,
        decisions: s.decisions,
      })),
      hasMore: filtered.length === limit,
    });
  } catch (error) {
    return Response.json(
      { error: "Failed to load time slices" },
      { status: 500 }
    );
  }
}
