import { setRequestLocale } from "next-intl/server";
import { redirect } from "@/i18n/navigation";

// §14 merge made the hotel a WORLD of the app surface, not a route of its
// own; §3.1 moved that surface off `/` onto `/app`. The old URL stays as a
// redirect so existing links keep landing in the game.

export default async function GamePage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  redirect({ href: "/app?view=game", locale });
}
