"use client";

import { useMemo } from "react";
import type { UIMessage } from "ai";
import { MarkdownRenderer } from "./markdown";
import { ThinkingSteps } from "./thinking";
import { RecallPhase } from "./recall-phase";
import { MessageActions } from "./message-actions";
import { ToolRenderer } from "./tool-renderer";
import { Message, MessageContent, MessageFooter } from "@/components/ui/message";
import { Bubble, BubbleContent } from "@/components/ui/bubble";

interface ChatMessageProps {
  message: UIMessage;
  onRegenerate?: () => void;
  isStreaming?: boolean;
  startedAt?: string;
}

export function ChatMessage({ message, onRegenerate, isStreaming, startedAt }: ChatMessageProps) {
  const isUser = message.role === "user";
  const isAssistant = message.role === "assistant";
  const parts = message.parts ?? [];

  // ── Separate phase-level from inline parts ────────────────────────────

  const { recallParts, reasoningText, inlineParts } = useMemo(() => {
    const recall: typeof parts = [];
    const reasoning: string[] = [];
    const inline: typeof parts = [];

    for (const p of parts) {
      if (p.type === "data-flash") {
        recall.push(p);
      } else if (p.type === "reasoning") {
        reasoning.push((p as { text: string }).text);
      } else {
        inline.push(p);
      }
    }

    return {
      recallParts: recall,
      reasoningText: reasoning.join("\n"),
      inlineParts: inline,
    };
  }, [parts]);

  const hasRecall = recallParts.length > 0;
  const hasReasoning = reasoningText.trim().length > 0;
  const hasInline = inlineParts.length > 0;

  // Full text for footer display
  const textContent = inlineParts
    .filter((p) => p.type === "text")
    .map((p) => (p as { text: string }).text)
    .join("\n") ?? "";

  return (
    <div className="py-1">
      <Message align={isUser ? "end" : "start"} className="gap-1">
        <MessageContent className="min-w-0">
          {/* Phase 1: Recall — always visible */}
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
                  isStreaming={false}
                />
              );
            })
          }

          {/* Phase 2: Reasoning — always visible */}
          {isAssistant && hasReasoning && (
            <ThinkingSteps
              text={reasoningText}
              isStreaming={isStreaming && !hasInline}
            />
          )}

          {/* Phase 3: Inline parts (tools + text) — rendered in original stream order */}
          {hasInline && (
            <Bubble variant={isUser ? "default" : "secondary"}>
              <BubbleContent>
                {inlineParts.map((part, i) => {
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
                        key={p.toolCallId ?? `tool-${i}`}
                        toolName={p.toolName ?? p.type?.replace("tool-", "") ?? "tool"}
                        state={p.state}
                        input={p.input}
                        output={p.output}
                        isStreaming={isStreaming ?? false}
                      />
                    );
                  }
                  if (part.type === "text") {
                    const text = (part as { text: string }).text;
                    return <MarkdownRenderer key={`text-${i}`} content={text} />;
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

          {/* Footer — actions only, no model pill */}
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
