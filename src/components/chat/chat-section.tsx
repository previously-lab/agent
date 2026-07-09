"use client";

import type { UIMessage } from "ai";
import { Loader2 } from "lucide-react";
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

      {showThinking && (
        <MessageScrollerItem messageId="thinking-indicator">
          <div className="flex items-center gap-2 px-4 py-2 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            <span>Thinking...</span>
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
