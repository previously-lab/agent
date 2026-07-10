"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { useState, useCallback, useRef } from "react";
import { ChatInput } from "./chat-input";
import { ChatSection } from "./chat-section";
import { MemorySection } from "./memory-section";
import { shouldShowThinkingIndicator } from "@/lib/chat/streaming-state";
import type { SliceSummary } from "@/lib/episodic/actions";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";

function getClientSetting(key: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  return localStorage.getItem(key) ?? fallback;
}

interface ChatPageProps {
  children: React.ReactNode;
  initialData: {
    active: SliceSummary | null;
    slices: SliceSummary[];
    hasMore: boolean;
  };
}

export function ChatPage({ children, initialData }: ChatPageProps) {
  const [settings] = useState(() => ({
    model: getClientSetting("PREVIOUSLY_MODEL", "deepseek-chat"),
    thinking: getClientSetting("PREVIOUSLY_THINKING", "true") !== "false",
  }));

  const [lastUserMessageAt, setLastUserMessageAt] = useState<string | null>(
    null,
  );
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

  return (
    <div className="flex flex-col h-screen w-full bg-background">
      <MessageScrollerProvider defaultScrollPosition="start">
        <MessageScroller className="flex-1">
          <MessageScrollerViewport>
            <MessageScrollerContent
              aria-busy={isStreaming}
              className="mx-auto max-w-5xl xl:max-w-7xl px-4 sm:px-6 lg:px-8 pb-24"
            >
              {/* Hero section */}
              <MessageScrollerItem messageId="hero-section">
                {children}
              </MessageScrollerItem>

              {/* Memory section */}
              <MessageScrollerItem messageId="memory-section">
                <MemorySection
                  onLoadedIdsChange={handleLoadedIdsChange}
                  chatEmpty={messages.length === 0}
                  initialData={initialData}
                />
              </MessageScrollerItem>

              {/* Chat messages + thinking + errors */}
              <ChatSection
                messages={messages}
                isStreaming={isStreaming}
                showThinking={showThinking}
                error={error}
                lastUserMessageAt={lastUserMessageAt}
              />
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton />
        </MessageScroller>
      </MessageScrollerProvider>

      {/* Input — sticky at bottom.
          Responsive width: full-width on mobile, constrained on desktop
          so the input doesn't stretch awkwardly across the screen. */}
      <div className="sticky bottom-0 pt-2 pb-2">
        <div className="mx-auto w-full md:max-w-2xl px-4 sm:px-6 lg:px-8">
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
