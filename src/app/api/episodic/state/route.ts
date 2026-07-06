import { getActiveSlice, readSliceIndex } from "@/lib/episodic";

const DEMO_MODE = process.env.DEMO_MODE === "true";
/** In demo mode, scan further back (demo data is sparse: ~1 slice/month). */
const DEMO_SCAN_MONTHS = 48;
/** Max recent slices to return in one response. */
const PAGE_SIZE = 3;

export async function GET() {
  try {
    const active = getActiveSlice();

    const now = new Date();
    const year = now.getUTCFullYear();
    const month = now.getUTCMonth() + 1;

    // Collect slices by scanning months backward
    const monthsToScan = DEMO_MODE ? DEMO_SCAN_MONTHS : 2;
    const collected: Awaited<ReturnType<typeof readSliceIndex>> = [];
    let exhausted = true; // true if we scanned all months without hitting page limit

    for (let i = 0; i < monthsToScan; i++) {
      let m = month - i;
      let y = year;
      while (m <= 0) {
        m += 12;
        y -= 1;
      }
      try {
        const index = await readSliceIndex(y, m);
        for (const entry of index) {
          collected.push(entry);
        }
      } catch {
        // Month index may not exist — skip
      }
      // Stop early once we have a full page + buffer (to detect hasMore reliably)
      if (collected.length >= PAGE_SIZE + 2) {
        exhausted = false;
        break;
      }
    }

    // Filter out the active slice from the closed list, sort, paginate
    const activeDay = active?.slice_id.split("-")[2];
    const closed = collected
      .filter((s) => s.status === "closed" || s.id !== activeDay)
      .sort((a, b) => b.start.localeCompare(a.start));

    const recent = closed.slice(0, PAGE_SIZE);
    const hasMore = closed.length > PAGE_SIZE || !exhausted;

    return Response.json({
      hasActiveSlice: active !== null,
      hasMore,
      active: active
        ? {
            slice_id: active.slice_id,
            focus: active.focus,
            summary: active.summary,
            start: active.start,
            timezone: active.timezone,
            turnCount: active.turns.length,
            open_loops: active.open_loops,
            decisions: active.decisions,
          }
        : null,
      recent: recent.map((s) => ({
        slice_id: `${s.start.slice(0, 7)}/${s.id}`,
        focus: s.focus,
        summary: s.summary,
        start: s.start,
        status: s.status,
        open_loops: s.open_loops,
        decisions: s.decisions,
      })),
    });
  } catch (error) {
    return Response.json(
      { error: "Failed to load memory state" },
      { status: 500 }
    );
  }
}
