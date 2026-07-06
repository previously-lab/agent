"use client";

import { useEffect, useRef, useState } from "react";
import { Search } from "lucide-react";
import type { ToolRenderState } from "@/lib/chat/tool-state";
import { ToolLayout } from "./tool-layout";

interface RecallPhaseProps {
  text: string;
  tags?: string[];
  timeRange?: string;
  isStreaming?: boolean;
}

const COMPLETED_STATE: ToolRenderState = {
  running: false,
  interrupted: false,
  denied: false,
  approvalRequested: false,
  isActiveApproval: false,
};

const STREAMING_STATE: ToolRenderState = {
  running: true,
  interrupted: false,
  denied: false,
  approvalRequested: false,
  isActiveApproval: false,
};

export function RecallPhase({ text, tags, timeRange, isStreaming = false }: RecallPhaseProps) {
  const [elapsed, setElapsed] = useState(0);
  const startTimeRef = useRef<number | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!isStreaming) {
      if (startTimeRef.current !== null) {
        setElapsed(Math.floor((Date.now() - startTimeRef.current) / 1000));
      }
      if (intervalRef.current) clearInterval(intervalRef.current);
      return;
    }

    if (startTimeRef.current === null) startTimeRef.current = Date.now();

    intervalRef.current = setInterval(() => {
      setElapsed(Math.floor((Date.now() - (startTimeRef.current ?? Date.now())) / 1000));
    }, 1000);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [isStreaming]);

  const hasContent = text.trim().length > 0;
  const name = isStreaming ? "Recalling..." : "Recalled";
  const summary = !isStreaming && elapsed > 0
    ? `${elapsed}s`
    : (tags && tags.length > 0 ? tags.slice(0, 3).join(", ") : "");

  const expandedContent = hasContent ? (
    <div className="space-y-2">
      <div className="rounded-md border border-border/50 bg-muted/30 px-3 py-2">
        <p className="whitespace-pre-wrap break-words text-xs text-muted-foreground leading-relaxed">
          {text}
        </p>
      </div>
      {tags && tags.length > 0 && (
        <div className="flex flex-wrap gap-1 px-1">
          {tags.map((tag, i) => (
            <span
              key={i}
              className="inline-flex items-center rounded-full bg-muted/50 px-2 py-0.5 text-[10px] text-muted-foreground/70"
            >
              {tag}
            </span>
          ))}
        </div>
      )}
    </div>
  ) : undefined;

  return (
    <ToolLayout
      name={name}
      icon={<Search className="h-3.5 w-3.5" />}
      summary={summary}
      state={isStreaming ? STREAMING_STATE : COMPLETED_STATE}
      expandedContent={expandedContent}
    />
  );
}
