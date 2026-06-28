"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { ChatInput } from "./chat-input";
import { ChatMessage } from "./chat-message";
import { useEffect, useRef, useState } from "react";
import { Sparkles } from "lucide-react";

function getSelectedModel(): string {
  if (typeof window === "undefined") return "deepseek-chat";
  return localStorage.getItem("AFTRBREZ_MODEL") ?? "deepseek-chat";
}

export function Chat() {
  const [model] = useState(getSelectedModel);

  const { messages, sendMessage, status, stop, error, regenerate } = useChat({
    transport: new DefaultChatTransport({
      api: "/api/chat",
      body: { model },
    }),
  });

  const bottomRef = useRef<HTMLDivElement>(null);
  const [shouldAutoScroll, setShouldAutoScroll] = useState(true);

  useEffect(() => {
    if (shouldAutoScroll) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages, shouldAutoScroll]);

  const isLoading = status === "submitted" || status === "streaming";
  const isStreaming = status === "streaming";

  const handleSubmit = (message: string) => {
    setShouldAutoScroll(true);
    sendMessage({ role: "user", parts: [{ type: "text", text: message }] });
  };

  const handleRegenerate = () => {
    setShouldAutoScroll(true);
    regenerate?.();
  };

  const lastMessage = messages[messages.length - 1];
  const isLastStreaming = isStreaming && lastMessage?.role === "assistant";

  return (
    <div className="flex flex-col h-full bg-background">
      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 sm:px-6">
        <div className="max-w-3xl mx-auto">
          {messages.length === 0 ? (
            /* Empty state */
            <div className="flex flex-col items-center justify-center min-h-[60vh] text-center">
              <div className="rounded-full bg-muted p-4 mb-4">
                <Sparkles className="h-6 w-6 text-muted-foreground" />
              </div>
              <h2 className="text-lg font-semibold mb-1">How can I help?</h2>
              <p className="text-sm text-muted-foreground max-w-sm">
                Ask me anything — I can read and write files, search your memory, and help with coding tasks.
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
            </div>
          )}

          {/* Error state */}
          {error && (
            <div className="rounded-lg border border-destructive/50 bg-destructive/5 px-4 py-3 mb-4">
              <p className="text-sm text-destructive font-medium">Error</p>
              <p className="text-xs text-destructive/80 mt-1">{error.message}</p>
              <button
                onClick={() => window.location.reload()}
                className="text-xs text-destructive underline mt-2"
              >
                Reload page to retry
              </button>
            </div>
          )}

          <div ref={bottomRef} className="h-2" />
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
