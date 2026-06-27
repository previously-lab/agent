import type { UIMessage } from "ai";

interface ChatMessageProps {
  message: UIMessage;
}

export function ChatMessage({ message }: ChatMessageProps) {
  const isUser = message.role === "user";

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"} mb-4`}>
      <div
        className={`max-w-[80%] rounded-lg px-4 py-2 text-sm ${
          isUser
            ? "bg-primary text-primary-foreground"
            : "bg-muted text-foreground"
        }`}
      >
        {message.parts?.map((part, i) => {
          if (part.type?.startsWith("tool-")) {
            const p = part as { type: string; toolCallId: string; toolName?: string; state: string; input?: unknown; output?: unknown };
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
          if (part.type === "text") {
            return <span key={i}>{(part as { text: string }).text}</span>;
          }
          return null;
        })}
      </div>
    </div>
  );
}
