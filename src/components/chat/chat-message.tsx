"use client";

import { memo, useMemo } from "react";
import type { UIMessage } from "ai";
import { MarkdownRenderer } from "./markdown";
import { ThinkingSteps } from "./thinking";
import { RecallPhase } from "./recall-phase";
import { MessageActions } from "./message-actions";
import { ToolRenderer } from "./tool-renderer";
import { RecallGroup, type RecallCategory, type RecallToolPart } from "./recall-group";
import { Message, MessageContent, MessageFooter } from "@/components/ui/message";
import { Bubble, BubbleContent } from "@/components/ui/bubble";

interface ChatMessageProps {
  message: UIMessage;
  onRegenerate?: () => void;
  isStreaming?: boolean;
  startedAt?: string;
}

// ── Inline-part grouping ────────────────────────────────────────────────
// Consecutive memory-read tool calls are collapsed into a single "act of
// recall" so a dozen readMemory calls don't render as a mechanical log.

type AnyPart = {
  type?: string;
  toolCallId?: string;
  toolName?: string;
  state?: string;
  input?: unknown;
  output?: unknown;
  text?: string;
};

const RECALL_CATEGORY: Record<string, RecallCategory> = {
  readMemory: "timeline",
  readIndex: "timeline",
  listMemory: "browse",
};

function resolveToolName(p: AnyPart): string {
  return p.toolName ?? p.type?.replace("tool-", "") ?? "tool";
}

type RenderItem =
  | { kind: "text"; key: string; content: string }
  | { kind: "tool"; key: string; toolName: string; state: string; input?: unknown; output?: unknown }
  | { kind: "recallGroup"; key: string; category: RecallCategory; parts: RecallToolPart[] };

function groupInlineParts(parts: readonly AnyPart[]): RenderItem[] {
  const items: RenderItem[] = [];
  let buffer: { category: RecallCategory; parts: RecallToolPart[]; startIndex: number } | null = null;

  const flush = () => {
    if (!buffer) return;
    if (buffer.parts.length >= 2) {
      items.push({
        kind: "recallGroup",
        key: `recall-${buffer.category}-${buffer.startIndex}`,
        category: buffer.category,
        parts: buffer.parts,
      });
    } else {
      // A lone memory read renders as a normal tool card, not a group.
      const p = buffer.parts[0];
      items.push({
        kind: "tool",
        key: p.toolCallId ?? `tool-${buffer.startIndex}`,
        toolName: p.toolName,
        state: p.state,
        input: p.input,
        output: p.output,
      });
    }
    buffer = null;
  };

  parts.forEach((part, i) => {
    if (part.type?.startsWith("tool-")) {
      const toolName = resolveToolName(part);
      const toolPart: RecallToolPart = {
        toolCallId: part.toolCallId,
        toolName,
        state: part.state ?? "",
        input: part.input,
        output: part.output,
      };
      const category = RECALL_CATEGORY[toolName];
      if (category) {
        if (buffer && buffer.category === category) {
          buffer.parts.push(toolPart);
        } else {
          flush();
          buffer = { category, parts: [toolPart], startIndex: i };
        }
        return;
      }
      flush();
      items.push({
        kind: "tool",
        key: part.toolCallId ?? `tool-${i}`,
        toolName,
        state: toolPart.state,
        input: part.input,
        output: part.output,
      });
      return;
    }
    flush();
    if (part.type === "text") {
      items.push({ kind: "text", key: `text-${i}`, content: part.text ?? "" });
    }
  });

  flush();
  return items;
}

export const ChatMessage = memo(function ChatMessage({ message, onRegenerate, isStreaming, startedAt }: ChatMessageProps) {
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

  const renderItems = useMemo(
    () => groupInlineParts(inlineParts as AnyPart[]),
    [inlineParts],
  );

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
                {renderItems.map((item) => {
                  if (item.kind === "text") {
                    return <MarkdownRenderer key={item.key} content={item.content} />;
                  }
                  if (item.kind === "recallGroup") {
                    return (
                      <RecallGroup
                        key={item.key}
                        category={item.category}
                        parts={item.parts}
                        isStreaming={isStreaming ?? false}
                      />
                    );
                  }
                  return (
                    <ToolRenderer
                      key={item.key}
                      toolName={item.toolName}
                      state={item.state}
                      input={item.input}
                      output={item.output}
                      isStreaming={isStreaming ?? false}
                    />
                  );
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
});
