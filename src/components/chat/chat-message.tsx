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
  const hasProContent = toolCount > 0 || textContent.length > 0;

  return (
    <div className="py-1">
      <Message align={isUser ? "end" : "start"} className="gap-1">
        <MessageContent className="min-w-0">
          {/* ── Phase 1: Recall (M8: always visible, independent collapse) ── */}
          {isAssistant && hasRecall &&
            recallParts.map((part, i) => {
              const p = part as {
                type: string;
                data?: {
                  phase?: string;
                  text?: string;
                  tags?: string[];
                  reasoning?: string;
                  recall_hits?: Array<{ slice_id: string; relevance: number; reason: string }>;
                };
              };
              return (
                <RecallPhase
                  key={i}
                  text={p.data?.text ?? ""}
                  tags={p.data?.tags}
                  reasoning={p.data?.reasoning}
                  recallHits={p.data?.recall_hits}
                  isStreaming={isStreaming}
                />
              );
            })
          }

          {/* ── Phase 2: Reasoning (always visible) ── */}
          {isAssistant && hasReasoning && (
            <ThinkingSteps
              text={reasoningText}
              isStreaming={isStreaming}
            />
          )}

          {/* ── SummaryBar: only when there are tool calls ── */}
          {isAssistant && toolCount > 0 && (
            <SummaryBar
              messageId={message.id}
              toolCallCount={toolCount}
              isStreaming={isStreaming ?? false}
              isExpanded={isExpanded}
              onToggle={() => setIsExpanded(!isExpanded)}
              startedAt={startedAt ?? null}
            />
          )}

          {/* ── Phase 3+4: Tool calls + Text (collapsible via SummaryBar) ── */}
          {isExpanded && (
            <Bubble variant={isUser ? "default" : "secondary"}>
              <BubbleContent>
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

          {/* ── Footer ── */}
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
