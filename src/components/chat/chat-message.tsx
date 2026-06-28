import type { UIMessage } from "ai";
import { MarkdownRenderer } from "./markdown";
import { ThinkingSteps } from "./thinking";

interface ChatMessageProps {
  message: UIMessage;
}

export function ChatMessage({ message }: ChatMessageProps) {
  const isUser = message.role === "user";

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"} mb-4`}>
      <div
        className={`max-w-[85%] sm:max-w-[75%] rounded-lg px-4 py-2.5 text-sm ${
          isUser
            ? "bg-primary text-primary-foreground"
            : "bg-muted text-foreground"
        }`}
      >
        {message.parts?.map((part, i) => {
          // Reasoning/thinking parts
          if (part.type === "reasoning") {
            return (
              <ThinkingSteps
                key={i}
                content={(part as { text: string }).text}
              />
            );
          }

          // Tool call parts
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
              <div
                key={i}
                className="mb-2 rounded bg-background/50 px-2 py-1 text-xs font-mono"
              >
                <span className="text-muted-foreground">
                  {p.state === "output-available"
                    ? `✓ ${p.toolName ?? "tool"}`
                    : `⚙ ${p.toolName ?? "tool"}...`}
                </span>
                {p.state === "output-available" && p.output != null && (
                  <pre className="mt-1 text-xs opacity-75 max-h-20 overflow-hidden">
                    {typeof p.output === "string"
                      ? p.output.slice(0, 200)
                      : JSON.stringify(p.output, null, 2).slice(0, 200)}
                  </pre>
                )}
              </div>
            );
          }

          // Text parts — use Markdown for assistant, plain for user
          if (part.type === "text") {
            const text = (part as { text: string }).text;
            return isUser ? (
              <span key={i}>{text}</span>
            ) : (
              <MarkdownRenderer key={i} content={text} />
            );
          }

          return null;
        })}
      </div>
    </div>
  );
}
