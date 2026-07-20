import { setRequestLocale } from "next-intl/server";
import { getEpisodicState } from "@/lib/episodic/actions";
import { setDemoPersona } from "@/lib/demo/demo-fs";
import { resolveDataSource } from "@/lib/data-source/resolve";
import { ChatPage } from "@/components/chat/chat-page";
import { HeroSection } from "@/components/chat/hero-section";
import { TimelinePanel } from "@/components/chat/timeline-panel";

type SearchParams = Promise<{ persona?: string }>;

export default async function HomePage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: SearchParams;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  // Demo mode: persona can be selected via URL query param
  const { persona } = await searchParams;
  if (resolveDataSource() === "demo") {
    setDemoPersona(persona || "personal_14");
  }

  const episodicData = await getEpisodicState();

  return (
    <ChatPage>
      <HeroSection personaId={persona} />
      <TimelinePanel
        key={persona || "default"}
        initialData={{
          active: episodicData.hasActiveSlice ? episodicData.active : null,
          slices: episodicData.recent ?? [],
          hasMore: episodicData.hasMore ?? false,
        }}
      />
    </ChatPage>
  );
}
