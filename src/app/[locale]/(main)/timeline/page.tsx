import { setRequestLocale } from "next-intl/server";

export default async function TimelinePage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  return null; // Chat renders in layout, timeline is a view mode
}
