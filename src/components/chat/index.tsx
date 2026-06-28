"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { ChatInput } from "./chat-input";
import { ChatMessage } from "./chat-message";
import { useState, useCallback } from "react";
import { Sparkles, Loader2, ChevronDown, RefreshCw } from "lucide-react";
import { useScrollToBottom } from "@/hooks/use-scroll-to-bottom";
import { shouldShowThinkingIndicator } from "@/lib/chat/streaming-state";

function getClientSetting(key: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  return localStorage.getItem(key) ?? fallback;
}

export function Chat() {
  const [settings] = useState(() => ({
    model: getClientSetting("AFTRBREZ_MODEL", "deepseek-chat"),
    thinking: getClientSetting("AFTRBREZ_THINKING", "true") !== "false",
  }));

  const { messages, sendMessage, status, stop, error, regenerate } = useChat({
    transport: new DefaultChatTransport({
      api: "/api/chat",
      body: settings,
    }),
  });

  const isStreaming = status === "streaming";
  const isLoading = status === "submitted" || isStreaming;
  const showThinking = shouldShowThinkingIndicator(status, messages);

  const { containerRef, onNewUserMessage } = useScrollToBottom([messages]);

  const handleSubmit = (message: string) => {
    onNewUserMessage();
    sendMessage({ role: "user", parts: [{ type: "text", text: message }] });
  };

  const handleRegenerate = () => {
    onNewUserMessage();
    regenerate?.();
  };

  const lastMessage = messages[messages.length - 1];
  const isLastStreaming = isStreaming && lastMessage?.role === "assistant";

  const scrollToBottom = useCallback(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [containerRef]);

  const showScrollBtn = messages.length > 0;

  return (
    <div className="flex flex-col h-full bg-background relative">
      {/* Messages */}
      <div ref={containerRef} className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-4xl px-4 py-8">
          {messages.length === 0 ? (
            /* Empty state — OA style */
            <div className="flex flex-col items-center justify-center min-h-[60vh] text-center">
              <div className="rounded-full bg-muted p-4 mb-4">
                <Sparkles className="h-6 w-6 text-muted-foreground" />
              </div>
              <h2 className="text-lg font-semibold mb-1">How can I help?</h2>
              <p className="text-sm text-muted-foreground max-w-sm">
                I can read and write files, search your memory, and help with coding tasks.
              </p>
            </div>
          ) : (
            <>
              {messages.map((message, i) => {
                const isLast = i === messages.length - 1;
                return (
                  <ChatMessage
                    key={message.id}
                    message={message}
                    isStreaming={isLast && isStreaming}
                    onRegenerate={isLast && !isStreaming ? handleRegenerate : undefined}
                  />
                );
              })}

              {/* Thinking indicator */}
              {showThinking && (
                <div className="flex items-center gap-2 px-4 py-2 text-xs text-muted-foreground">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  <span>Thinking...</span>
                </div>
              )}

              {/* Scroll to bottom */}
              {showScrollBtn && (
                <button
                  onClick={scrollToBottom}
                  className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-secondary text-secondary-foreground hover:bg-accent p-2 shadow-sm transition-colors z-10"
                  title="Scroll to bottom"
                >
                  <ChevronDown className="h-4 w-4" />
                </button>
              )}
            </>
          )}

          {/* Error banner — OA style */}
          {error && (
            <div className="flex items-center justify-between gap-3 border-b border-destructive/20 bg-destructive/10 px-4 py-2 text-sm text-destructive">
              <span>{error.message}</span>
              <button
                onClick={() => window.location.reload()}
                className="flex items-center gap-1 text-xs underline hover:no-underline"
              >
                <RefreshCw className="h-3 w-3" />
                Retry
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Input — sticky at bottom */}
      <div className="sticky bottom-0 bg-gradient-to-t from-background via-background to-transparent pt-4 px-4 pb-4">
        <div className="max-w-4xl mx-auto">
          <ChatInput onSubmit={handleSubmit} isLoading={isLoading} onStop={stop} />
        </div>
      </div>
    </div>
  );
}
