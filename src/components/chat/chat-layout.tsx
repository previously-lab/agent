"use client";

import { Chat } from "./index";

/**
 * Persistent layout wrapper. Chat is always mounted so useChat state
 * survives all route changes. When children has content (e.g. /settings),
 * it renders on top of Chat as a full-screen overlay.
 */
export function ChatLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-screen overflow-hidden relative">
      <Chat />
      {children && (
        <div className="absolute inset-0 z-50 bg-background overflow-auto">
          {children}
        </div>
      )}
    </div>
  );
}
