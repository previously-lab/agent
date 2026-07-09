"use client";

import { useEffect, useRef, useState } from "react";
import { History } from "lucide-react";
import type { ToolRenderState } from "@/lib/chat/tool-state";
import { ToolLayout } from "./tool-layout";
import { MarkdownRenderer } from "./markdown";

interface RecallHit {
  slice_id: string;
  relevance: number;
  reason: string;
}

interface RecallPhaseProps {
  text: string;
  tags?: string[];
  reasoning?: string;
  recallHits?: RecallHit[];
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

export function RecallPhase({
  text,
  tags,
  reasoning,
  recallHits,
  isStreaming = false,
}: RecallPhaseProps) {
  const [elapsed, setElapsed] = useState(0);
  const startTimeRef = useRef<number | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!isStreaming) {
      if (startTimeRef.current !== null) {
        setElapsed(Math.floor((Date.now() - startTimeRef.current) / 1000));
      }
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      return () => {
        if (intervalRef.current) clearInterval(intervalRef.current);
      };
    }

    if (startTimeRef.current === null) {
      startTimeRef.current = Date.now();
    }

    intervalRef.current = setInterval(() => {
      setElapsed(
        Math.floor((Date.now() - (startTimeRef.current ?? Date.now())) / 1000),
      );
    }, 1000);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [isStreaming]);

  const hasContent = text.trim().length > 0;
  const hasHits = recallHits && recallHits.length > 0;
  const hasReasoning = reasoning && reasoning.trim().length > 0;
  const hasDetails = hasContent || hasHits || hasReasoning;

  const name = isStreaming ? "Recalling..." : "Recalled";
  const summary =
    !isStreaming && elapsed > 0 ? `${elapsed}s` : "";

  const expandedContent = hasDetails ? (
    <div className="rounded-md border border-border bg-muted/40 px-3 py-2 space-y-2 text-xs text-muted-foreground leading-relaxed">
      {hasContent && <MarkdownRenderer content={text} />}
      {hasHits && (
        <div className="space-y-1.5">
          {recallHits!.map((hit, i) => (
            <div key={i} className="flex items-start gap-2 text-xs">
              <span className="font-mono text-[10px] text-muted-foreground mt-0.5 shrink-0">
                {hit.slice_id}
              </span>
              <span className="text-muted-foreground leading-relaxed">{hit.reason}</span>
              <span className="text-[10px] text-muted-foreground ml-auto shrink-0">
                {Math.round(hit.relevance * 100)}%
              </span>
            </div>
          ))}
        </div>
      )}
      {hasReasoning && (
        <p className="text-[10px] text-muted-foreground italic leading-relaxed">
          {reasoning}
        </p>
      )}
      {tags && tags.length > 0 && (
        <div className="flex flex-wrap gap-1 pt-1 border-t border-border/30">
          {tags.map((tag, i) => (
            <span
              key={i}
              className="inline-flex items-center rounded-full bg-muted/40 px-2 py-0.5 text-[10px] text-muted-foreground"
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
      icon={<History className="h-3.5 w-3.5" />}
      summary={summary}
      state={isStreaming ? STREAMING_STATE : COMPLETED_STATE}
      expandedContent={expandedContent}
    />
  );
}
