import type { UIMessage } from "ai";
import { MarkdownRenderer } from "./markdown";
import { ThinkingSteps } from "./thinking";
import { MessageActions } from "./message-actions";
import { ToolCall } from "./tool-call";

interface ChatMessageProps {
  message: UIMessage;
  onRegenerate?: () => void;
  isStreaming?: boolean;
}

export function ChatMessage({ message, onRegenerate, isStreaming }: ChatMessageProps) {
  const isUser = message.role === "user";
  const isAssistant = message.role === "assistant";

  const textContent = message.parts
    ?.filter((p) => p.type === "text")
    .map((p) => (p as { text: string }).text)
    .join("\n") ?? "";

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"} mb-5 group`}>
      <div className="max-w-[92%] sm:max-w-[80%] min-w-0">
        {/* Message bubble */}
        <div
          className={`rounded-2xl px-4 py-3 text-sm leading-relaxed ${
            isUser
              ? "bg-primary text-primary-foreground rounded-br-md"
              : "bg-card border border-border rounded-bl-md shadow-sm"
          }`}
        >
          {message.parts?.map((part, i) => {
            if (part.type === "reasoning") {
              return (
                <ThinkingSteps
                  key={i}
                  content={(part as { text: string }).text}
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
                <ToolCall
                  key={p.toolCallId ?? i}
                  toolName={p.toolName ?? "tool"}
                  state={p.state}
                  output={p.output}
                  input={p.input}
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
        </div>

        {/* Message actions (copy + regenerate) — only on non-empty completed assistant messages */}
        {isAssistant && textContent && !isStreaming && (
          <MessageActions content={textContent} onRegenerate={onRegenerate} />
        )}
      </div>
    </div>
  );
}
