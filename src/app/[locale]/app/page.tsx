import { Suspense } from "react";
import { setRequestLocale } from "next-intl/server";
import { setDemoPersona } from "@/lib/demo/demo-fs";
import { resolveDataSource } from "@/lib/data-source/resolve";
import { redirect } from "@/i18n/navigation";
import { AppShell } from "@/components/shell/app-shell";
import { ClientErrorCapture } from "@/components/chat/client-error-capture";
import { DebugErrorBoundary } from "@/components/ui/error-boundary";
import { ChatStreamSkeleton } from "@/components/chat/chat-skeleton";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function AppPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: SearchParams;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const query = await searchParams;
  if (query.view === "game") {
    const next = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (key === "view") continue;
      if (Array.isArray(value)) value.forEach((item) => next.append(key, item));
      else if (value !== undefined) next.set(key, value);
    }
    const search = next.toString();
    redirect({ href: `/game${search ? `?${search}` : ""}`, locale });
  }

  const persona = typeof query.persona === "string" ? query.persona : undefined;
  if (resolveDataSource() === "demo") setDemoPersona(persona || "user");

  return (
    <>
      <ClientErrorCapture />
      <DebugErrorBoundary label="chat-page">
        <Suspense fallback={<ChatStreamSkeleton />}>
          <AppShell />
        </Suspense>
      </DebugErrorBoundary>
    </>
  );
}
