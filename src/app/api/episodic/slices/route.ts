import { readSliceIndex } from "@/lib/episodic";

const DEMO_MODE = process.env.DEMO_MODE === "true";
/** In demo mode, scan this many months back when browsing slices. */
const DEMO_SCAN_MONTHS = 48;

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

    const beforeDay = beforeDate.getUTCDate();
    const beforeYear = beforeDate.getUTCFullYear();
    const beforeMonth = beforeDate.getUTCMonth() + 1;

    // In demo mode, scan back through multiple months to find slices
    // (demo data is sparse: ~1 slice per month across 4 years)
    const monthsToScan = DEMO_MODE ? DEMO_SCAN_MONTHS : 1;
    const allEntries: Awaited<ReturnType<typeof readSliceIndex>> = [];

    for (let i = 0; i < monthsToScan; i++) {
      let m = beforeMonth - i;
      let y = beforeYear;
      while (m <= 0) {
        m += 12;
        y -= 1;
      }
      try {
        const index = await readSliceIndex(y, m);
        for (const entry of index) {
          // For the target month, filter by beforeDay; include all from earlier months
          if (i === 0) {
            const day = parseInt(entry.id, 10);
            if (!isNaN(day) && day < beforeDay) {
              allEntries.push(entry);
            }
          } else {
            allEntries.push(entry);
          }
        }
      } catch {
        // Month index may not exist — skip
      }
      if (allEntries.length >= limit) break;
    }

    const filtered = allEntries
      .sort((a, b) => b.start.localeCompare(a.start))
      .slice(0, limit);

    return Response.json({
      slices: filtered.map((s) => ({
        slice_id: `${s.start.slice(0, 7)}/${s.id}`,
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
