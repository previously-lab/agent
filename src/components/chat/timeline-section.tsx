import { getEpisodicState } from "@/lib/episodic/actions";
import { TimelinePanel } from "./timeline-panel";

export async function TimelineSection({ personaId }: { personaId?: string }) {
  const episodicData = await getEpisodicState();

  return (
    <TimelinePanel
      initialData={{
        active: episodicData.hasActiveSlice ? episodicData.active : null,
        slices: episodicData.recent ?? [],
        hasMore: episodicData.hasMore ?? false,
      }}
    />
  );
}
