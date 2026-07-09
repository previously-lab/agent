"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { ChatInput } from "./chat-input";
import { ChatMessage } from "./chat-message";
import { useState, useCallback, useRef } from "react";
import { Loader2 } from "lucide-react";
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
import { DashedSeparator } from "./dashed-separator";
import { usePathname } from "@/i18n/navigation";

function getClientSetting(key: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  return localStorage.getItem(key) ?? fallback;
}

export function Chat() {
  const pathname = usePathname();
  const isTimeline = pathname?.endsWith("/timeline");

  const [settings] = useState(() => ({
    model: getClientSetting("PREVIOUSLY_MODEL", "deepseek-chat"),
    thinking: getClientSetting("PREVIOUSLY_THINKING", "true") !== "false",
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

  return (
    <div className="flex flex-col h-full w-full bg-background">
      <MessageScrollerProvider autoScroll defaultScrollPosition="last-anchor">
        <MessageScroller className="flex-1">
          <MessageScrollerViewport>
            <MessageScrollerContent
              aria-busy={isStreaming}
              className="mx-auto max-w-3xl px-4 sm:px-6 lg:px-8 pb-24"
            >
              {/* ── Timeline panel — chat mode ── */}
              {!isTimeline && (
                <MessageScrollerItem messageId="timeline-panel">
                  <TimelinePanel onLoadedIdsChange={handleLoadedIdsChange} />
                </MessageScrollerItem>
              )}

              {/* ── Timeline reading mode ── */}
              {isTimeline && (
                <MessageScrollerItem messageId="timeline-page">
                  <TimelinePanel mode="page" onLoadedIdsChange={handleLoadedIdsChange} />
                </MessageScrollerItem>
              )}

              {/* ── Previously on... divider ── */}
              {!isTimeline && (
                <MessageScrollerItem messageId="previously-divider">
                  <div className="flex items-center gap-3 py-3">
                    <DashedSeparator className="flex-1" />
                    <span className="text-[0.7rem] text-muted-foreground/30 tracking-wider italic shrink-0">
                      Previously on...
                    </span>
                    <DashedSeparator className="flex-1" />
                  </div>
                </MessageScrollerItem>
              )}

              {/* ── Messages — chat mode only ── */}
              {!isTimeline && messages.map((message) => (
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
      <div className="sticky bottom-0 bg-gradient-to-t from-background via-background to-transparent pt-2 pb-2">
        <div className="mx-auto max-w-3xl px-4 sm:px-6 lg:px-8">
          <ChatInput
            onSubmit={handleSubmit}
            isLoading={isLoading}
            onStop={stop}
          />
        </div>
      </div>
    </div>
  );
}
