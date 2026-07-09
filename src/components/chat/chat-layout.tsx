"use client";

import { Chat } from "./index";

export function ChatLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-screen overflow-hidden">
      <Chat />
      {children}
    </div>
  );
}
