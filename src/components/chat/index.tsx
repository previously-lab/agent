"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { ChatInput } from "./chat-input";
import { ChatMessage } from "./chat-message";
import { useState } from "react";
import { Sparkles, Loader2 } from "lucide-react";
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

  return (
    <div className="flex flex-col h-full bg-background">
      {/* Messages */}
      <div ref={containerRef} className="flex-1 overflow-y-auto px-4 sm:px-6">
        <div className="max-w-3xl mx-auto">
          {messages.length === 0 ? (
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
            <div className="py-4 space-y-1">
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
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="rounded-lg border border-destructive/20 bg-destructive/5 px-4 py-3 mb-4">
              <p className="text-sm font-medium text-destructive">Error</p>
              <p className="text-xs text-destructive/80 mt-1">{error.message}</p>
              <button
                onClick={() => window.location.reload()}
                className="text-xs text-destructive underline mt-2"
              >
                Reload to retry
              </button>
            </div>
          )}

          <div className="h-2" />
        </div>
      </div>

      {/* Input */}
      <div className="sticky bottom-0 bg-gradient-to-t from-background via-background to-transparent pt-4">
        <div className="max-w-3xl mx-auto">
          <ChatInput onSubmit={handleSubmit} isLoading={isLoading} onStop={stop} />
        </div>
      </div>
    </div>
  );
}
