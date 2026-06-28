"use client";

import { useState, useEffect, useRef } from "react";
import { ChevronDown, ChevronRight, Brain } from "lucide-react";
import { formatElapsedTime } from "@/lib/chat/tool-state";

interface ThinkingStepsProps {
  content: string;
  isStreaming?: boolean;
}

export function ThinkingSteps({ content, isStreaming }: ThinkingStepsProps) {
  const [open, setOpen] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const startRef = useRef(Date.now());
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    startRef.current = Date.now();
    setElapsed(0);
    if (isStreaming) {
      timerRef.current = setInterval(() => {
        setElapsed(Math.floor((Date.now() - startRef.current) / 1000));
      }, 1000);
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [isStreaming]);

  const hasContent = content.length > 0;

  return (
    <details
      className="mb-3 border border-border/60 rounded-lg bg-muted/20 overflow-hidden group"
      onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
    >
      <summary className="flex items-center gap-2 px-3 py-2 cursor-pointer text-xs text-muted-foreground hover:text-foreground select-none">
        {open ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0" />
        )}
        <Brain className="h-3.5 w-3.5 shrink-0" />
        <span className="min-w-0 tabular-nums">
          {isStreaming
            ? `Thinking${elapsed > 0 ? ` · ${formatElapsedTime(elapsed)}` : ""}`
            : hasContent
              ? `Thought for ${formatElapsedTime(elapsed)}`
              : "Thought for a moment"}
        </span>
        {isStreaming && (
          <span className="flex gap-0.5 ml-1 shrink-0">
            <span className="w-1 h-1 rounded-full bg-muted-foreground/50 animate-bounce" style={{ animationDelay: "0ms" }} />
            <span className="w-1 h-1 rounded-full bg-muted-foreground/50 animate-bounce" style={{ animationDelay: "150ms" }} />
            <span className="w-1 h-1 rounded-full bg-muted-foreground/50 animate-bounce" style={{ animationDelay: "300ms" }} />
          </span>
        )}
      </summary>
      {hasContent && (
        <div className="px-3 pb-3 text-xs text-muted-foreground whitespace-pre-wrap leading-relaxed border-t border-border/30 pt-2">
          {content}
        </div>
      )}
    </details>
  );
}
