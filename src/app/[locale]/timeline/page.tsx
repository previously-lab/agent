import { setRequestLocale } from "next-intl/server";
import { getEpisodicState } from "@/lib/episodic/actions";
import { ChatPage } from "@/components/chat/chat-page";
import { HeroSection } from "@/components/chat/hero-section";

export default async function TimelinePage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  const episodicData = await getEpisodicState();

  return (
    <ChatPage
      initialData={{
        active: episodicData.hasActiveSlice ? episodicData.active : null,
        slices: episodicData.recent ?? [],
        hasMore: episodicData.hasMore ?? false,
      }}
    >
      <HeroSection />
    </ChatPage>
  );
}
