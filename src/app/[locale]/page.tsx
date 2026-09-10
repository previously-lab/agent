import { Suspense } from "react";
import { setRequestLocale } from "next-intl/server";
import { setDemoPersona } from "@/lib/demo/demo-fs";
import { resolveDataSource } from "@/lib/data-source/resolve";
import { AppShell } from "@/components/shell/app-shell";
import { ClientErrorCapture } from "@/components/chat/client-error-capture";
import { DebugErrorBoundary } from "@/components/ui/error-boundary";
import { loadUserConfig } from "@/lib/config/loader";

type SearchParams = Promise<{ persona?: string; view?: string; at?: string }>;

export default async function HomePage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: SearchParams;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  const { persona } = await searchParams;
  const isDemo = resolveDataSource() === "demo";
  if (isDemo) {
    setDemoPersona(persona || "user");
  }
  // Preload the user config server-side so ChatPage seeds its model state from
  // real values instead of flashing the defaults and then reconciling via a
  // mount-time server action. The config loader has a 60s TTL
  // and the underlying GitHub read rides the readFile cache, so this is cheap.
  const config = await loadUserConfig();

  // v0.11 single-shell page: chat and timeline are views of `/` selected by
  // the `?view=timeline` search param. AppShell owns the left time axis and
  // the switchable right pane.
  return (
    <>
      {/* Window-level error listeners — catch anything the SDK transport or
          React swallows and log it with full detail. */}
      <ClientErrorCapture />
      {/* Render-loop / render-phase errors (e.g. minified React #185) surface
          here with the full stack + component stack instead of an opaque
          frame. */}
      <DebugErrorBoundary label="chat-page">
        <Suspense fallback={<div className="h-dvh" />}>
          <AppShell initialConfig={config} />
        </Suspense>
      </DebugErrorBoundary>
    </>
  );
}
