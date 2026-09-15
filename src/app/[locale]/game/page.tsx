import { setRequestLocale } from "next-intl/server";
import { GameShell } from "@/components/game/game-shell";

// Immersive fullscreen route: skip prerendering so the locale request config
// is set fresh per request, same as the settings page.
export const dynamic = "force-dynamic";

export default async function GamePage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  return (
    <div className="fixed inset-0 bg-neutral-950">
      <GameShell />
    </div>
  );
}
