"use client";

import { useState, useEffect, useRef } from "react";
import { ChevronRight } from "lucide-react";
import { getStatusWord, formatElapsedTime } from "@/lib/chat/tool-state";

interface SummaryBarProps {
  messageId: string;
  toolCount: number;
  isStreaming: boolean;
  startedAt?: number;
}

export function SummaryBar({ messageId, toolCount, isStreaming, startedAt }: SummaryBarProps) {
  const [collapsed, setCollapsed] = useState(false);
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
    <div className="my-1.5 border border-transparent py-0.5">
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="group flex w-full max-w-full items-center gap-2 rounded-md py-px text-left text-sm text-muted-foreground tabular-nums transition-colors hover:text-foreground sm:inline-flex sm:w-auto"
      >
        {/* Status dot — OA style */}
        <span className={`inline-block size-2 rounded-full ${isStreaming ? "animate-pulse bg-muted-foreground" : "bg-muted-foreground/50"}`} />

        <span className={`font-medium ${isStreaming ? "text-foreground/90" : ""}`}>
          {statusWord}
        </span>

        <span className="tabular-nums">{formatElapsedTime(elapsed)}</span>

        <span className="text-muted-foreground/40">·</span>

        <span>{toolCount} tool{toolCount !== 1 ? "s" : ""}</span>

        {/* Collapse chevron */}
        <span className={`shrink-0 transition-transform duration-200 ease-out ${collapsed ? "" : "rotate-90"}`}>
          <ChevronRight className="size-3 text-muted-foreground/50" />
        </span>
      </button>
    </div>
  );
}
