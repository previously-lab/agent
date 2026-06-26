import { setRequestLocale } from "next-intl/server";
import { Chat } from "@/components/chat";

export default async function HomePage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;

  setRequestLocale(locale);

  return (
    <main className="h-screen flex flex-col">
      <Chat />
    </main>
  );
}
