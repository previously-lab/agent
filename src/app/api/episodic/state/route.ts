import { getActiveSlice, readSliceIndex } from "@/lib/episodic";

export async function GET() {
  try {
    const active = getActiveSlice();

    const now = new Date();
    const year = now.getUTCFullYear();
    const month = now.getUTCMonth() + 1;
    const prevMonth = month === 1 ? 12 : month - 1;
    const prevYear = month === 1 ? year - 1 : year;

    const [currentIndex, prevIndex] = await Promise.all([
      readSliceIndex(year, month),
      readSliceIndex(prevYear, prevMonth),
    ]);

    const allSlices = [...prevIndex, ...currentIndex]
      .filter((s) => s.status === "closed" || s.id !== active?.slice_id.split("-")[2])
      .sort((a, b) => b.start.localeCompare(a.start))
      .slice(0, 10);

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
