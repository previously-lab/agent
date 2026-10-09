import { setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { LabPage } from "@/components/lab/lab-page";

/**
 * THE VISUAL LAB — a dev-only route of full-page visual RECIPES (pile, grid,
 * paper, cover, room, transition) rendered with the app's real paper tokens.
 * It is a DISCUSSION MEDIUM for the owner and the designer: pictures to look
 * at and argue about before anything ships. This is NOT product UI — it is
 * never linked from anywhere, every production request 404s on the guard
 * below, and the lab components must not be imported outside this route.
 *
 * Screenshots (element-level, one recipe at a time), e.g.:
 *   MSYS_NO_PATHCONV=1 SCREENSHOT_BASE=http://localhost:3191 \
 *     node scripts/screenshot.mjs --route "/en/lab" --theme dark --scale 2 \
 *     --selector "[data-recipe='pile']" --out shots/visual-lab/pile-dom-dark.png
 */
export const dynamic = "force-dynamic";

export default async function LabRoute({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  if (process.env.NODE_ENV === "production") notFound();
  const { locale } = await params;
  setRequestLocale(locale);
  return <LabPage />;
}
