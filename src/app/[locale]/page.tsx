import { Suspense } from "react";
import { setRequestLocale } from "next-intl/server";
import { setDemoPersona } from "@/lib/demo/demo-fs";
import { resolveDataSource } from "@/lib/data-source/resolve";
import { AppShell } from "@/components/shell/app-shell";
import { ClientErrorCapture } from "@/components/chat/client-error-capture";
import { DebugErrorBoundary } from "@/components/ui/error-boundary";
import { ChatStreamSkeleton } from "@/components/chat/chat-skeleton";
import { loadUserConfig } from "@/lib/config/loader";

type SearchParams = Promise<{ persona?: string; view?: string; at?: string }>;

/**
 * The config read, in its OWN async boundary.
 *
 * It used to sit directly in the page body, above the JSX — which meant the
 * `<Suspense>` below it could never show its fallback, because the page had
 * not finished awaiting by the time the boundary was created. The whole page
 * segment (HTML and all) waited on a `getContent` round trip, and the user
 * watched an empty screen for it. The shell needs nothing from the config but
 * the model-selector seed, so it is awaited HERE and the shell streams in
 * around it.
 */
async function Shell() {
  const config = await loadUserConfig();
  return <AppShell initialConfig={config} />;
}

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

  // v0.11 single-shell page: chat, the timeline field and the game are all
  // views of `/` — the rung (`?z=`) picks the zoom, `?view=game` the hotel
  // world. AppShell owns the left time axis and the one shared canvas.
  return (
    <>
      {/* Window-level error listeners — catch anything the SDK transport or
          React swallows and log it with full detail. */}
      <ClientErrorCapture />
      {/* Render-loop / render-phase errors (e.g. minified React #185) surface
          here with the full stack + component stack instead of an opaque
          frame. */}
      <DebugErrorBoundary label="chat-page">
        <Suspense fallback={<ChatStreamSkeleton />}>
          <Shell />
        </Suspense>
      </DebugErrorBoundary>
    </>
  );
}
