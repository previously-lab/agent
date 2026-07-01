"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { ChatInput } from "./chat-input";
import { ChatMessage } from "./chat-message";
import { useState, useCallback, useRef } from "react";
import { Sparkles, Loader2 } from "lucide-react";
import { shouldShowThinkingIndicator } from "@/lib/chat/streaming-state";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import { TimelinePanel } from "./timeline-panel";

function getClientSetting(key: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  return localStorage.getItem(key) ?? fallback;
}

export function Chat() {
  const [settings] = useState(() => ({
    model: getClientSetting("AFTRBREZ_MODEL", "deepseek-chat"),
    thinking: getClientSetting("AFTRBREZ_THINKING", "true") !== "false",
  }));

  const [lastUserMessageAt, setLastUserMessageAt] = useState<string | null>(null);
  const loadedSliceIdsRef = useRef<string[]>([]);

  const handleLoadedIdsChange = useCallback((ids: string[]) => {
    loadedSliceIdsRef.current = ids;
  }, []);

  const { messages, sendMessage, status, stop, error } = useChat({
    transport: new DefaultChatTransport({
      api: "/api/chat",
      body: () => ({
        ...settings,
        timezone:
          typeof Intl !== "undefined"
            ? Intl.DateTimeFormat().resolvedOptions().timeZone
            : "UTC",
        loadedSliceIds: loadedSliceIdsRef.current,
      }),
    }),
  });

  const isStreaming = status === "streaming";
  const isLoading = status === "submitted" || isStreaming;
  const showThinking = shouldShowThinkingIndicator(status, messages);

  const handleSubmit = (message: string) => {
    setLastUserMessageAt(new Date().toISOString());
    sendMessage({ role: "user", parts: [{ type: "text", text: message }] });
  };

  const lastMessage = messages[messages.length - 1];
  const isLastStreaming = isStreaming && lastMessage?.role === "assistant";

  return (
    <div className="flex flex-col h-full bg-background">
      <MessageScrollerProvider autoScroll defaultScrollPosition="last-anchor">
        <MessageScroller className="flex-1">
          <MessageScrollerViewport>
            <MessageScrollerContent
              aria-busy={isStreaming}
              className="mx-auto max-w-3xl px-4 sm:px-6 lg:px-8"
            >
              {/* Timeline panel — past memories at top */}
              <MessageScrollerItem messageId="timeline-panel">
                <TimelinePanel onLoadedIdsChange={handleLoadedIdsChange} />
              </MessageScrollerItem>

              {messages.length === 0 ? (
                /* Subtle prompt when no messages yet — memory is already visible above */
                <MessageScrollerItem messageId="empty-state">
                  <div className="flex flex-col items-center justify-center py-12 text-center px-4">
                    <p className="text-sm text-muted-foreground/50">
                      💬 输入你想做的事...
                    </p>
                  </div>
                </MessageScrollerItem>
              ) : (
                messages.map((message) => (
                  <MessageScrollerItem
                    key={message.id}
                    messageId={message.id}
                    scrollAnchor={message.role === "user"}
                  >
                    <ChatMessage
                      message={message}
                      isStreaming={
                        message.id === lastMessage?.id && isStreaming
                      }
                      startedAt={
                        message.id === lastMessage?.id
                          ? (lastUserMessageAt ?? undefined)
                          : undefined
                      }
                    />
                  </MessageScrollerItem>
                ))
              )}

              {/* Thinking indicator */}
              {showThinking && (
                <MessageScrollerItem messageId="thinking-indicator">
                  <div className="flex items-center gap-2 px-4 py-2 text-xs text-muted-foreground">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    <span>Thinking...</span>
                  </div>
                </MessageScrollerItem>
              )}

              {/* Error banner */}
              {error && (
                <MessageScrollerItem messageId="error-banner">
                  <div className="mx-4 my-2 rounded-md border border-destructive/20 bg-destructive/10 px-4 py-2 text-sm text-destructive">
                    {error.message}
                  </div>
                </MessageScrollerItem>
              )}
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton />
        </MessageScroller>
      </MessageScrollerProvider>

      {/* Input — sticky at bottom */}
      <div className="sticky bottom-0 bg-gradient-to-t from-background via-background to-transparent pt-4 pb-4">
        <div className="mx-auto max-w-3xl px-4 sm:px-6 lg:px-8">
          <ChatInput onSubmit={handleSubmit} isLoading={isLoading} onStop={stop} />
        </div>
      </div>
    </div>
  );
}
