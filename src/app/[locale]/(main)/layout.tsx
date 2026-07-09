import { ChatLayout } from "@/components/chat/chat-layout";

export default function MainLayout({ children }: { children: React.ReactNode }) {
  return <ChatLayout>{children}</ChatLayout>;
}
