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
  /** Timestamp when this message started generating (for elapsed timer) */
  startedAt?: number;
}

export function ChatMessage({ message, onRegenerate, isStreaming, startedAt }: ChatMessageProps) {
  const isUser = message.role === "user";
  const isAssistant = message.role === "assistant";

  const textContent = message.parts
    ?.filter((p) => p.type === "text")
    .map((p) => (p as { text: string }).text)
    .join("\n") ?? "";

  const toolParts = message.parts?.filter((p) => p.type?.startsWith("tool-")) ?? [];
  const toolCount = toolParts.length;
  const isCollapsed = false; // controlled by SummaryBar

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"} mb-5 group`}>
      <div className="max-w-[92%] sm:max-w-[80%] min-w-0">
        {/* SummaryBar — collapsible wrapper for assistant messages with tools */}
        {isAssistant && toolCount > 0 && (
          <SummaryBar
            messageId={message.id}
            toolCount={toolCount}
            isStreaming={isStreaming ?? false}
            startedAt={startedAt}
          />
        )}

        {/* Message bubble */}
        <div
          className={`rounded-3xl px-4 py-3 text-sm leading-relaxed ${
            isUser
              ? "bg-primary text-primary-foreground rounded-br-md"
              : "bg-card border border-border rounded-bl-md shadow-sm"
          }`}
        >
          {message.parts?.map((part, i) => {
            // Reasoning/thinking
            if (part.type === "reasoning") {
              return (
                <ThinkingSteps
                  key={i}
                  content={(part as { text: string }).text}
                  isStreaming={isStreaming}
                />
              );
            }

            // Tool calls — use per-tool renderer
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

            // Text — Markdown for assistant, plain for user
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

          {/* Model pill on hover */}
          {isAssistant && !isStreaming && (
            <div className="mt-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
              <ModelPill model="deepseek" reasoningEffort="medium" />
            </div>
          )}
        </div>

        {/* Message actions — only on non-empty completed assistant messages */}
        {isAssistant && textContent && !isStreaming && (
          <MessageActions content={textContent} onRegenerate={onRegenerate} />
        )}
      </div>
    </div>
  );
}
