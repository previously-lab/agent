import { Suspense } from "react";
import { NextIntlClientProvider, hasLocale } from "next-intl";
import { getMessages, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import type { Viewport } from "next";
import { routing } from "@/i18n/routing";
import { AppHeader } from "@/components/layout/app-header";
import { ShellProvider } from "@/components/shell/shell-provider";
import { ConversationOverlayMount } from "@/components/chat/conversation-overlay-mount";
import { NativeSourceScopeProvider } from "@/components/chat/native-source-scope";
import { DocumentContextProvider } from "@/components/chat/document-context-provider";
import { DocumentNavigationAdapter } from "@/components/workspace/document-navigation-adapter";
import { GameWorkspaceMount } from "@/components/workspace/game-workspace-mount";
import { WorkspaceFeatures } from "@/components/workspace/workspace-features";
import { loadUserConfig } from "@/lib/config/loader";
import { resolveDataSource } from "@/lib/data-source/resolve";
import { nativeSourceScopeForDeployment } from "@/lib/chat/native-source-scope.server";

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

/**
 * The overlay's config seed, in its OWN async boundary (the same trick the
 * pre-split route page used): the conversation layer wants `config.json` only
 * to seed the model selector, so it is awaited HERE and every route —
 * including the home, which gates the overlay away — streams in around it
 * instead of waiting on a config round trip for its first paint.
 */
async function OverlayLoader() {
  const config = await loadUserConfig();
  return <ConversationOverlayMount initialConfig={config} />;
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
      <NativeSourceScopeProvider value={nativeSourceScopeForDeployment()}>
        <ShellProvider>
          <DocumentNavigationAdapter>
            <DocumentContextProvider>
              {children}
              <Suspense fallback={null}>
                <GameWorkspaceMount />
                <WorkspaceFeatures />
              </Suspense>
              <Suspense fallback={null}>
                <OverlayLoader />
              </Suspense>
            </DocumentContextProvider>
          </DocumentNavigationAdapter>
        </ShellProvider>
      </NativeSourceScopeProvider>
    </NextIntlClientProvider>
  );
}
