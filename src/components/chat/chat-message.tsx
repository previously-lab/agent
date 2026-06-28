"use client";

import { useState } from "react";
import type { UIMessage } from "ai";
import { MarkdownRenderer } from "./markdown";
import { ThinkingSteps } from "./thinking";
import { MessageActions } from "./message-actions";
import { ToolRenderer } from "./tool-renderer";
import { SummaryBar } from "./summary-bar";
import { ModelPill } from "./model-pill";

interface ChatMessageProps {
  message: UIMessage;
  onRegenerate?: () => void;
  isStreaming?: boolean;
  startedAt?: string;
}

export function ChatMessage({ message, onRegenerate, isStreaming, startedAt }: ChatMessageProps) {
  const [isExpanded, setIsExpanded] = useState(true);
  const isUser = message.role === "user";
  const isAssistant = message.role === "assistant";

  const textContent = message.parts
    ?.filter((p) => p.type === "text")
    .map((p) => (p as { text: string }).text)
    .join("\n") ?? "";

  const toolParts = message.parts?.filter((p) => p.type?.startsWith("tool-")) ?? [];
  const toolCount = toolParts.length;

  return (
    <div className="flex min-w-0 py-2 group">
      <div className="max-w-[85%] sm:max-w-[75%] min-w-0">
        {/* SummaryBar — OA-style collapsible wrapper */}
        {isAssistant && (toolCount > 0 || isStreaming) && (
          <SummaryBar
            messageId={message.id}
            toolCallCount={toolCount}
            isStreaming={isStreaming ?? false}
            isExpanded={isExpanded}
            onToggle={() => setIsExpanded(!isExpanded)}
            startedAt={startedAt ?? null}
          />
        )}

        {/* Collapsible message body */}
        {isExpanded && (
          <div
            className={`rounded-3xl px-4 py-2 text-sm leading-relaxed ${
              isUser
                ? "bg-secondary text-foreground rounded-br-md"
                : "bg-card border rounded-bl-md"
            }`}
          >
            {message.parts?.map((part, i) => {
              if (part.type === "reasoning") {
                return (
                  <ThinkingSteps
                    key={i}
                    text={(part as { text: string }).text}
                    isStreaming={isStreaming}
                  />
                );
              }

              if (part.type?.startsWith("tool-")) {
                const p = part as {
                  type: string;
                  toolCallId: string;
                  toolName?: string;
                  state: string;
                  input?: unknown;
                  output?: unknown;
                };
                return (
                  <ToolRenderer
                    key={p.toolCallId ?? i}
                    toolName={p.toolName ?? "tool"}
                    state={p.state}
                    input={p.input}
                    output={p.output}
                    isStreaming={isStreaming ?? false}
                  />
                );
              }

              if (part.type === "text") {
                const text = (part as { text: string }).text;
                if (isUser) {
                  return <span key={i} className="whitespace-pre-wrap">{text}</span>;
                }
                return <MarkdownRenderer key={i} content={text} />;
              }

              return null;
            })}

            {/* Streaming cursor */}
            {isStreaming && isAssistant && (
              <span className="inline-block w-1.5 h-4 bg-primary animate-pulse rounded-sm ml-0.5 align-text-bottom" />
            )}

            {/* Model pill */}
            {isAssistant && !isStreaming && (
              <div className="mt-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
                <ModelPill model="deepseek" reasoningEffort="medium" />
              </div>
            )}
          </div>
        )}

        {/* Message actions */}
        {isAssistant && textContent && !isStreaming && (
          <MessageActions content={textContent} onRegenerate={onRegenerate} />
        )}
      </div>
    </div>
  );
}
