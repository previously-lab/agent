import { setRequestLocale } from "next-intl/server";
import { getEpisodicState } from "@/lib/episodic/actions";
import { ChatPage } from "@/components/chat/chat-page";
import { HeroSection } from "@/components/chat/hero-section";
import { TimelinePanel } from "@/components/chat/timeline-panel";

export default async function HomePage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  const episodicData = await getEpisodicState();

  return (
    <ChatPage>
      <HeroSection />
      <TimelinePanel
        initialData={{
          active: episodicData.hasActiveSlice ? episodicData.active : null,
          slices: episodicData.recent ?? [],
          hasMore: episodicData.hasMore ?? false,
        }}
      />
    </ChatPage>
  );
}
