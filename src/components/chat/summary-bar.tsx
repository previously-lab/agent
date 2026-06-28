"use client";

import { useState, useEffect, useRef } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { getStatusWord, formatElapsedTime } from "@/lib/chat/tool-state";

interface SummaryBarProps {
  messageId: string;
  toolCount: number;
  isStreaming: boolean;
  startedAt?: number;
}

export function SummaryBar({ messageId, toolCount, isStreaming, startedAt }: SummaryBarProps) {
  const [collapsed, setCollapsed] = useState(true);
  const [elapsed, setElapsed] = useState(0);
  const startRef = useRef(startedAt ?? Date.now());
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    if (startedAt) startRef.current = startedAt;
    if (isStreaming) {
      timerRef.current = setInterval(() => {
        setElapsed(Math.floor((Date.now() - startRef.current) / 1000));
      }, 1000);
    } else if (timerRef.current) {
      clearInterval(timerRef.current);
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [isStreaming, startedAt]);

  const statusWord = getStatusWord(messageId);

  if (toolCount === 0) return null;

  return (
    <button
      onClick={() => setCollapsed(!collapsed)}
      className="w-full flex items-center gap-2 mb-2 px-3 py-1.5 rounded-lg bg-muted/30 border border-border/40 text-xs text-muted-foreground hover:bg-muted/50 transition-colors group"
    >
      <span className="flex items-center gap-1.5">
        {isStreaming && (
          <span className="flex gap-0.5">
            <span className="w-1 h-1 rounded-full bg-muted-foreground/60 animate-bounce" style={{ animationDelay: "0ms" }} />
            <span className="w-1 h-1 rounded-full bg-muted-foreground/60 animate-bounce" style={{ animationDelay: "150ms" }} />
            <span className="w-1 h-1 rounded-full bg-muted-foreground/60 animate-bounce" style={{ animationDelay: "300ms" }} />
          </span>
        )}
        <span className="font-medium">{statusWord}</span>
      </span>

      <span className="tabular-nums">{formatElapsedTime(elapsed)}</span>
      <span>·</span>
      <span>{toolCount} tool{toolCount !== 1 ? "s" : ""}</span>

      <span className="ml-auto opacity-0 group-hover:opacity-100 transition-opacity">
        {collapsed ? <ChevronRight className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
      </span>
    </button>
  );
}
