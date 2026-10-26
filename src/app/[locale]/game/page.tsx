import { setRequestLocale } from "next-intl/server";
import { setDemoPersona } from "@/lib/demo/demo-fs";
import { resolveDataSource } from "@/lib/data-source/resolve";
import { ClientErrorCapture } from "@/components/chat/client-error-capture";

export default async function GamePage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ persona?: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const { persona } = await searchParams;
  if (resolveDataSource() === "demo") setDemoPersona(persona || "user");
  return <ClientErrorCapture />;
}
