import { setRequestLocale } from "next-intl/server";
import { Chat } from "@/components/chat";

export default async function ChatPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  return (
    <div className="h-full flex flex-col">
      <div className="px-6 py-3 border-b border-border">
        <h1 className="text-lg font-semibold">Chat</h1>
      </div>
      <Chat />
    </div>
  );
}
