"use client";

import { useEffect, useRef, useState } from "react";
import { Search, ChevronDown, ChevronRight } from "lucide-react";
import type { ToolRenderState } from "@/lib/chat/tool-state";
import { ToolLayout } from "./tool-layout";

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
  const [expanded, setExpanded] = useState(false);
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
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [isStreaming]);

  const hasContent = text.trim().length > 0;
  const hasHits = recallHits && recallHits.length > 0;
  const hasReasoning = reasoning && reasoning.trim().length > 0;
  const hasDetails = hasContent || hasHits || hasReasoning;

  const name = isStreaming ? "Recalling..." : "Recalled";
  const summary = !isStreaming && elapsed > 0
    ? `${elapsed}s`
    : (tags && tags.length > 0 ? tags.slice(0, 3).join(", ") : "");

  const expandedContent = (
    <div className="space-y-2">
      {/* Summary text */}
      {hasContent && (
        <div className="rounded-md border border-border/40 bg-muted/20 px-3 py-2">
          <p className="text-xs text-muted-foreground leading-relaxed">
            {text}
          </p>
        </div>
      )}

      {/* Recall hits — timeline of matched slices */}
      {hasHits && (
        <div className="space-y-1">
          <p className="text-[10px] font-medium text-muted-foreground/60 uppercase tracking-wider px-0.5">
            Matched conversations
          </p>
          {recallHits!.map((hit, i) => (
            <div
              key={i}
              className="rounded-md border border-border/30 bg-muted/10 px-3 py-1.5 flex items-start gap-2"
            >
              <span className="text-[10px] font-mono text-muted-foreground/50 mt-0.5 shrink-0">
                {hit.slice_id}
              </span>
              <span className="text-xs text-muted-foreground/80 leading-relaxed">
                {hit.reason}
              </span>
              <span className="text-[10px] text-muted-foreground/40 ml-auto shrink-0">
                {Math.round(hit.relevance * 100)}%
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Flash reasoning */}
      {hasReasoning && (
        <div className="rounded-md border border-border/30 bg-muted/10 px-3 py-1.5">
          <p className="text-[10px] text-muted-foreground/50 leading-relaxed italic">
            {reasoning}
          </p>
        </div>
      )}

      {/* Tags */}
      {tags && tags.length > 0 && (
        <div className="flex flex-wrap gap-1 px-0.5">
          {tags.map((tag, i) => (
            <span
              key={i}
              className="inline-flex items-center rounded-full bg-muted/40 px-2 py-0.5 text-[10px] text-muted-foreground/60"
            >
              {tag}
            </span>
          ))}
        </div>
      )}
    </div>
  );

  const showExpandToggle = hasDetails && !isStreaming;

  return (
    <div>
      <ToolLayout
        name={name}
        icon={<Search className="h-3.5 w-3.5" />}
        summary={summary}
        state={isStreaming ? STREAMING_STATE : COMPLETED_STATE}
        expandedContent={expanded ? expandedContent : undefined}
      />
      {showExpandToggle && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-1 px-2 py-0.5 text-[10px] text-muted-foreground/40 hover:text-muted-foreground/60 transition-colors"
        >
          {expanded ? (
            <><ChevronDown className="h-3 w-3" /> Hide details</>
          ) : (
            <><ChevronRight className="h-3 w-3" /> Show details</>
          )}
        </button>
      )}
    </div>
  );
}
