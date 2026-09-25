import { Suspense } from "react";
import { setRequestLocale } from "next-intl/server";
import { setDemoPersona } from "@/lib/demo/demo-fs";
import { resolveDataSource } from "@/lib/data-source/resolve";
import { AppShell } from "@/components/shell/app-shell";
import { ClientErrorCapture } from "@/components/chat/client-error-capture";
import { DebugErrorBoundary } from "@/components/ui/error-boundary";
import { ChatStreamSkeleton } from "@/components/chat/chat-skeleton";

type SearchParams = Promise<{ persona?: string }>;

/**
 * The APP route (v0.13 §3.1) — what `/` used to be: the timeline field, the
 * hotel world and the one shared canvas, behind the conversation layer.
 *
 * Two things moved OUT with the split:
 *
 *   - the conversation layer (pill / fullscreen + the chat surface) now mounts
 *     at the LAYOUT (`conversation-overlay.tsx`), a sibling of this route that
 *     survives navigation and world rebuilds — AppShell talks to it through
 *     the layout-level `ShellProvider`, and no longer renders it;
 *   - the config read moved to the layout's own async boundary (the overlay's
 *     model-selector seed), so THIS page no longer waits on `config.json` —
 *     the shell streams in immediately and the overlay follows.
 *
 * The URL stays dev-only inside the session: `?view=game` is read ONCE by the
 * shell as the cold-boot world, `?at=`/`?atStart=` once by the chat as a
 * conversation deep link. Neither is ever written back.
 */
export default async function AppPage({
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

  return (
    <>
      {/* Window-level error listeners — catch anything the SDK transport or
          React swallows and log it with full detail. */}
      <ClientErrorCapture />
      {/* Render-loop / render-phase errors (e.g. minified React #185) surface
          here with the full stack + component stack instead of an opaque
          frame. */}
      <DebugErrorBoundary label="chat-page">
        {/* The Suspense boundary is for AppShell's `useSearchParams` (the
            `?view=game` cold-boot read), not for data — nothing here awaits
            any more. */}
        <Suspense fallback={<ChatStreamSkeleton />}>
          <AppShell />
        </Suspense>
      </DebugErrorBoundary>
    </>
  );
}
