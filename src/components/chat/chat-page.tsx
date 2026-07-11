"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { useState } from "react";
import { ChatInput } from "./chat-input";
import { ChatSection } from "./chat-section";
import { shouldShowThinkingIndicator } from "@/lib/chat/streaming-state";
import { LoadedIdsProvider, useLoadedIds } from "./loaded-ids-context";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";

function getClientSetting(key: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  return localStorage.getItem(key) ?? fallback;
}

interface ChatPageProps {
  children: React.ReactNode;
}

/**
 * Thin client shell: nothing but the LoadedIdsProvider. The real work
 * happens in `Inner` which lives inside the provider so it can access
 * the loaded-ids context.
 */
export function ChatPage({ children }: ChatPageProps) {
  return (
    <LoadedIdsProvider>
      <Inner>{children}</Inner>
    </LoadedIdsProvider>
  );
}

function Inner({ children }: { children: React.ReactNode }) {
  const [settings] = useState(() => ({
    model: getClientSetting("PREVIOUSLY_MODEL", "deepseek-chat"),
    thinking: getClientSetting("PREVIOUSLY_THINKING", "true") !== "false",
  }));

  const [lastUserMessageAt, setLastUserMessageAt] = useState<string | null>(null);
  const { snapshot } = useLoadedIds();

  const { messages, sendMessage, status, stop, error } = useChat({
    transport: new DefaultChatTransport({
      api: "/api/chat",
      body: () => ({
        ...settings,
        timezone:
          typeof Intl !== "undefined"
            ? Intl.DateTimeFormat().resolvedOptions().timeZone
            : "UTC",
        loadedSliceIds: snapshot(),
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
    <div className="relative h-screen w-full bg-background">
      <MessageScrollerProvider defaultScrollPosition="start">
        <MessageScroller className="size-full">
          <MessageScrollerViewport>
            <MessageScrollerContent
              aria-busy={isStreaming}
              className="mx-auto max-w-5xl xl:max-w-7xl px-4 sm:px-6 lg:px-8 pb-28"
            >
              {/* RSC slots: hero + timeline, rendered server-side */}
              {children}

              {/* Client: AI SDK chat messages */}
              <ChatSection
                messages={messages}
                isStreaming={isStreaming}
                showThinking={showThinking}
                error={error}
                lastUserMessageAt={lastUserMessageAt}
              />
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton className="!bottom-28" />
        </MessageScroller>
      </MessageScrollerProvider>

      <div className="fixed bottom-0 inset-x-0 z-10 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom,0.5rem))]">
        <div className="mx-auto w-full md:max-w-2xl px-4 sm:px-6 lg:px-8">
          <ChatInput onSubmit={handleSubmit} isLoading={isLoading} onStop={stop} />
        </div>
      </div>
    </div>
  );
}
