"use client";

import type { UIMessage } from "ai";
import { ChatMessage } from "./chat-message";
import { MessageScrollerItem } from "@/components/ui/message-scroller";

interface ChatSectionProps {
  messages: UIMessage[];
  isStreaming: boolean;
  showThinking: boolean;
  error: Error | undefined;
  lastUserMessageAt: string | null;
}

export function ChatSection({
  messages,
  isStreaming,
  showThinking,
  error,
  lastUserMessageAt,
}: ChatSectionProps) {
  const lastMessage = messages[messages.length - 1];

  return (
    <>
      {messages.map((message) => (
        <MessageScrollerItem
          key={message.id}
          messageId={message.id}
          scrollAnchor={message.role === "user"}
        >
          <ChatMessage
            message={message}
            isStreaming={message.id === lastMessage?.id && isStreaming}
            startedAt={
              message.id === lastMessage?.id
                ? (lastUserMessageAt ?? undefined)
                : undefined
            }
          />
        </MessageScrollerItem>
      ))}

      {/* Pre-stream wait: "正在回忆…" — Flash is the first phase. */}
      {showThinking && (
        <MessageScrollerItem messageId="recalling-indicator">
          <div className="flex items-center gap-2 px-1 py-3 text-sm text-muted-foreground">
            <span className="inline-block size-2 rounded-full bg-primary/50 animate-pulse" />
            正在回忆…
          </div>
        </MessageScrollerItem>
      )}

      {error && (
        <MessageScrollerItem messageId="error-banner">
          <div className="mx-4 my-2 rounded-md border border-destructive/20 bg-destructive/10 px-4 py-2 text-sm text-destructive">
            {error.message}
          </div>
        </MessageScrollerItem>
      )}
    </>
  );
}
