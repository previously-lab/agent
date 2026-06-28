"use client";

import { useState, useEffect, useRef } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

const STATUS_WORD_PAIRS = [
  { present: "Pondering", past: "Pondered" },
  { present: "Crafting", past: "Crafted" },
  { present: "Analyzing", past: "Analyzed" },
  { present: "Processing", past: "Processed" },
  { present: "Reasoning", past: "Reasoned" },
  { present: "Computing", past: "Computed" },
  { present: "Working", past: "Worked" },
];

function hashString(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  }
  return hash;
}

function getStatusWordPair(seed: string | null) {
  if (!seed) return STATUS_WORD_PAIRS[0];
  return STATUS_WORD_PAIRS[hashString(seed) % STATUS_WORD_PAIRS.length];
}

function formatElapsedTime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (secs === 0) return `${mins}m`;
  return `${mins}m ${secs}s`;
}

interface SummaryBarProps {
  messageId: string;
  toolCallCount: number;
  isStreaming: boolean;
  isExpanded: boolean;
  onToggle: () => void;
  durationMs?: number | null;
  startedAt?: string | null;
}

export function SummaryBar({
  messageId,
  toolCallCount,
  isStreaming,
  isExpanded,
  onToggle,
  durationMs,
  startedAt,
}: SummaryBarProps) {
  const startMs = startedAt ? new Date(startedAt).getTime() : null;
  const computeLiveElapsed = () =>
    startMs != null ? Math.max(0, Math.floor((Date.now() - startMs) / 1000)) : 0;

  const [liveElapsed, setLiveElapsed] = useState(computeLiveElapsed);

  useEffect(() => {
    if (!isStreaming) return;
    setLiveElapsed(computeLiveElapsed());
    const interval = setInterval(() => setLiveElapsed(computeLiveElapsed()), 1000);
    return () => clearInterval(interval);
  }, [isStreaming, startMs]);

  const elapsedSeconds = isStreaming
    ? liveElapsed
    : durationMs != null
      ? Math.max(0, Math.round(durationMs / 1000))
      : liveElapsed;

  const statusWordPair = getStatusWordPair(messageId);
  const statusLabel = isStreaming ? `${statusWordPair.present}...` : statusWordPair.past;

  const segments: string[] = [];
  if (elapsedSeconds > 0) segments.push(formatElapsedTime(elapsedSeconds));
  if (toolCallCount > 0) {
    segments.push(`${toolCallCount} tool call${toolCallCount !== 1 ? "s" : ""}`);
  }

  const fullSummary = [statusLabel, ...segments].join(" · ");

  if (toolCallCount === 0 && !isStreaming) return null;

  return (
    <div className="my-1.5 border border-transparent py-0.5">
      <button
        type="button"
        onClick={onToggle}
        aria-label={fullSummary}
        title={fullSummary}
        className={cn(
          "group flex w-full max-w-full items-center gap-2 rounded-md py-px text-left text-sm text-muted-foreground tabular-nums transition-colors hover:text-foreground sm:inline-flex sm:w-auto",
          isStreaming && "text-foreground/90",
        )}
      >
        <span className="flex size-3.5 shrink-0 items-center justify-center">
          <span
            className={cn(
              "inline-block size-2 rounded-full",
              isStreaming ? "animate-pulse bg-muted-foreground" : "bg-muted-foreground/50",
            )}
          />
        </span>
        <span
          className={cn(
            "min-w-0 overflow-hidden whitespace-nowrap leading-none",
            isStreaming && "animate-pulse motion-reduce:animate-none",
          )}
        >
          {statusLabel}
          {segments.length > 0 && (
            <span className="hidden sm:inline">
              {segments.map((s, i) => (
                <span key={i}>
                  <span className="text-muted-foreground/40"> · </span>
                  {s}
                </span>
              ))}
            </span>
          )}
        </span>
        <ChevronRight
          className={cn(
            "size-3 shrink-0 text-muted-foreground/50 transition-transform duration-200 ease-out",
            isExpanded && "rotate-90",
          )}
        />
      </button>
    </div>
  );
}
