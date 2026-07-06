"use client";

import { useState, useMemo } from "react";
import type { UIMessage } from "ai";
import { MarkdownRenderer } from "./markdown";
import { ThinkingSteps } from "./thinking";
import { RecallPhase } from "./recall-phase";
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

  // ── Grouped parts ──────────────────────────────────────────────────────

  const { recallParts, reasoningText, toolParts, textParts } = useMemo(() => {
    const parts = message.parts ?? [];

    const recallParts = parts.filter((p) => p.type === "data-flash");
    const reasoningParts = parts.filter((p) => p.type === "reasoning");
    const toolParts = parts.filter((p) => p.type?.startsWith("tool-"));
    const textParts = parts.filter((p) => p.type === "text");

    // Concatenate all reasoning chunks into one string
    const reasoningText = reasoningParts
      .map((p) => (p as { text: string }).text)
      .join("\n");

    return { recallParts, reasoningText, toolParts, textParts };
  }, [message.parts]);

  const textContent = textParts
    .map((p) => (p as { text: string }).text)
    .join("\n") ?? "";

  const toolCount = toolParts.length;
  const hasReasoning = reasoningText.trim().length > 0;
  const hasRecall = recallParts.length > 0;

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
                {/* Phase 1: Recall — data-flash from Recall Agent */}
                {isAssistant && hasRecall &&
                  recallParts.map((part, i) => {
                    const p = part as { type: string; data?: { phase?: string; text?: string; tags?: string[]; time_range?: string } };
                    return (
                      <RecallPhase
                        key={i}
                        text={p.data?.text ?? ""}
                        tags={p.data?.tags}
                        timeRange={p.data?.time_range}
                        isStreaming={isStreaming}
                      />
                    );
                  })
                }

                {/* Phase 2: Reasoning — grouped into one block */}
                {isAssistant && hasReasoning && (
                  <ThinkingSteps
                    text={reasoningText}
                    isStreaming={isStreaming}
                  />
                )}

                {/* Phase 3: Tool calls */}
                {toolParts.map((part) => {
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
                      key={p.toolCallId ?? p.type}
                      toolName={p.toolName ?? "tool"}
                      state={p.state}
                      input={p.input}
                      output={p.output}
                      isStreaming={isStreaming ?? false}
                    />
                  );
                })}

                {/* Phase 4: Text content */}
                {textParts.map((part, i) => {
                  const text = (part as { text: string }).text;
                  if (isUser) {
                    return <span key={i} className="whitespace-pre-wrap">{text}</span>;
                  }
                  return <MarkdownRenderer key={i} content={text} />;
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
