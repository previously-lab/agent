"use client";

import { useState } from "react";
import type { UIMessage } from "ai";
import { MarkdownRenderer } from "./markdown";
import { ThinkingSteps } from "./thinking";
import { MessageActions } from "./message-actions";
import { ToolRenderer } from "./tool-renderer";
import { SummaryBar } from "./summary-bar";
import { ModelPill } from "./model-pill";
import { Message, MessageContent, MessageFooter } from "@/components/ui/message";
import { Bubble, BubbleContent } from "@/components/ui/bubble";

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
    <div className="py-1">
      <Message align={isUser ? "end" : "start"} className="gap-1">
        <MessageContent className="min-w-0">
          {/* SummaryBar — collapsible wrapper for tool calls */}
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
            <Bubble variant={isUser ? "default" : "secondary"}>
              <BubbleContent>
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
                  <span className="inline-block w-1.5 h-4 bg-primary/50 animate-pulse rounded-sm ml-0.5 align-text-bottom" />
                )}
              </BubbleContent>
            </Bubble>
          )}

          {/* Footer: model pill + actions */}
          {isAssistant && textContent && !isStreaming && (
            <MessageFooter className="mt-0.5 opacity-0 group-hover/message:opacity-100 transition-opacity">
              <ModelPill model="deepseek" reasoningEffort="medium" />
            </MessageFooter>
          )}
          {isAssistant && textContent && !isStreaming && onRegenerate && (
            <MessageFooter>
              <MessageActions content={textContent} onRegenerate={onRegenerate} />
            </MessageFooter>
          )}
        </MessageContent>
      </Message>
    </div>
  );
}
