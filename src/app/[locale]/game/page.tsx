import { setRequestLocale } from "next-intl/server";
import { redirect } from "@/i18n/navigation";

// §14 merge: the hotel is a WORLD of the single route now (`/?view=game`),
// not a route of its own. The old URL stays as a redirect so existing links
// keep landing in the game.

export default async function GamePage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  redirect({ href: "/?view=game", locale });
}
