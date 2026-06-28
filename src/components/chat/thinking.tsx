"use client";

import { useState, useEffect, useRef } from "react";
import { ChevronDown, ChevronRight, Brain } from "lucide-react";

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
    if (isStreaming) {
      timerRef.current = setInterval(() => {
        setElapsed(Math.floor((Date.now() - startRef.current) / 1000));
      }, 1000);
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [isStreaming]);

  const formatTime = (s: number) => {
    if (s < 60) return `${s}s`;
    return `${Math.floor(s / 60)}m ${s % 60}s`;
  };

  return (
    <details
      className="mb-3 border border-border/60 rounded-lg bg-muted/20 overflow-hidden group"
      onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
    >
      <summary className="flex items-center gap-2 px-3 py-2 cursor-pointer text-xs text-muted-foreground hover:text-foreground select-none">
        {open ? (
          <ChevronDown className="h-3.5 w-3.5" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5" />
        )}
        <Brain className="h-3.5 w-3.5" />
        <span>
          {isStreaming ? "Thinking..." : `Thought${content.length > 100 ? " for a moment" : ""}`}
        </span>
        {isStreaming && elapsed > 0 && (
          <span className="text-xs text-muted-foreground/70 tabular-nums">
            {formatTime(elapsed)}
          </span>
        )}
        {isStreaming && (
          <span className="flex gap-0.5 ml-1">
            <span className="w-1 h-1 rounded-full bg-muted-foreground/50 animate-bounce" style={{ animationDelay: "0ms" }} />
            <span className="w-1 h-1 rounded-full bg-muted-foreground/50 animate-bounce" style={{ animationDelay: "150ms" }} />
            <span className="w-1 h-1 rounded-full bg-muted-foreground/50 animate-bounce" style={{ animationDelay: "300ms" }} />
          </span>
        )}
      </summary>
      <div className="px-3 pb-2 text-xs text-muted-foreground whitespace-pre-wrap leading-relaxed border-t border-border/30 pt-2">
        {content}
      </div>
    </details>
  );
}
