import { NextIntlClientProvider, hasLocale } from "next-intl";
import { getMessages, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import type { Viewport } from "next";
import { routing } from "@/i18n/routing";
import { AppHeader } from "@/components/layout/app-header";
import { resolveDataSource } from "@/lib/data-source/resolve";

// Explicit viewport: pin the layout width to the device (no automatic
// minimum-content zoom-out on phones) and extend the page into the notch /
// home-indicator areas — the input bar already consumes
// `env(safe-area-inset-bottom)`, which only has a non-zero value under
// `viewport-fit=cover`.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

type Props = {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
};

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export default async function LocaleLayout({ children, params }: Props) {
  const { locale } = await params;

  if (!hasLocale(routing.locales, locale)) {
    notFound();
  }

  setRequestLocale(locale);
  const messages = await getMessages();
  const isDemo = resolveDataSource() === "demo";

  return (
    <NextIntlClientProvider messages={messages} locale={locale}>
      <AppHeader isDemo={isDemo} />
      {children}
    </NextIntlClientProvider>
  );
}
