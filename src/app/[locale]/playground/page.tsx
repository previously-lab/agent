import { Suspense } from "react";
import { setRequestLocale } from "next-intl/server";
import { PlaygroundRoom } from "@/components/playground/playground-room";

/**
 * /{locale}/playground — the single-room acceptance surface: ?m=<moduleId>
 * &skin=<skinId>&seed=<tag> renders exactly that standard room, full-bleed,
 * with a data readout beside the picture. The room is a pure function of
 * the query (lib/game/playground.ts), so the URL is the reproduce button.
 * Nothing here touches the hotel route: no corridor, no conversation layer,
 * no shared canvas — the scene owns a private R3F canvas.
 */
export default async function PlaygroundPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  return (
    <Suspense>
      <PlaygroundRoom />
    </Suspense>
  );
}
