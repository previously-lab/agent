import { getActiveSlice, readSliceIndex } from "@/lib/episodic";

const DEMO_MODE = process.env.DEMO_MODE === "true";
/** In demo mode, scan this many months back to surface historical slices. */
const DEMO_SCAN_MONTHS = 48;

export async function GET() {
  try {
    const active = getActiveSlice();

    const now = new Date();
    const year = now.getUTCFullYear();
    const month = now.getUTCMonth() + 1;

    // Collect slices from recent months (demo mode scans much further back)
    const monthsToScan = DEMO_MODE ? DEMO_SCAN_MONTHS : 2;
    const allSlices: Awaited<ReturnType<typeof readSliceIndex>> = [];

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
          allSlices.push(entry);
        }
      } catch {
        // Month index may not exist — skip
      }
      // Stop early if we have enough
      if (allSlices.length >= 30) break;
    }

    const recent = allSlices
      .filter((s) => s.status === "closed" || s.id !== active?.slice_id.split("-")[2])
      .sort((a, b) => b.start.localeCompare(a.start))
      .slice(0, DEMO_MODE ? 30 : 10);

    return Response.json({
      hasActiveSlice: active !== null,
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
      recent: allSlices.map((s) => ({
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
