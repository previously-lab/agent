"use client";

import { useState } from "react";
import type { SliceSummary } from "@/hooks/use-timeline";
import { getSliceContent, type SliceContent } from "@/lib/episodic/actions";
import { Loader2, ChevronUp, ChevronDown } from "lucide-react";
import { Message, MessageContent } from "@/components/ui/message";
import { Bubble, BubbleContent } from "@/components/ui/bubble";

// ─── Memory turn — reuses shadcn Message + Bubble ───────────────────────

function MemoryTurn({ content, role }: { content: string; role: string }) {
  const isUser = role === "user";
  const display = content.length > 300 ? content.slice(0, 300) + "…" : content;
  return (
    <Message align={isUser ? "end" : "start"} className="gap-1 py-0.5">
      <MessageContent className="min-w-0">
        <Bubble variant={isUser ? "default" : "secondary"}>
          <BubbleContent>
            <span className="whitespace-pre-wrap text-sm">{display}</span>
          </BubbleContent>
        </Bubble>
      </MessageContent>
    </Message>
  );
}

// ─── Date formatting ────────────────────────────────────────────────────

export function formatSliceDate(start: string): string {
  const now = new Date();
  const d = new Date(start);
  const diffDays = Math.floor(
    (now.getTime() - d.getTime()) / (1000 * 60 * 60 * 24)
  );
  if (diffDays === 0) return "今天";
  if (diffDays === 1) return "昨天";
  const year = d.getFullYear();
  const month = d.getMonth() + 1;
  const day = d.getDate();
  if (year === now.getFullYear()) return `${month}月${day}日`;
  return `${year}年${month}月${day}日`;
}

// ─── Main component ──────────────────────────────────────────────────────

interface TimeSliceRowProps {
  slice: SliceSummary;
}

export function TimeSliceRow({ slice }: TimeSliceRowProps) {
  const [expanded, setExpanded] = useState(false);
  const [content, setContent] = useState<SliceContent | null>(null);
  const [loadingContent, setLoadingContent] = useState(false);

  const handleToggle = async () => {
    if (expanded) {
      setExpanded(false);
      return;
    }
    setExpanded(true);
    if (content) return;
    setLoadingContent(true);
    try {
      const data = await getSliceContent(slice.slice_id);
      setContent(data);
    } catch {
      // silently fail
    } finally {
      setLoadingContent(false);
    }
  };

  const allTurns = content?.turns ?? [];
  const lastTurn = allTurns[allTurns.length - 1];
  const olderTurns = allTurns.slice(0, -1);
  const hasMore = olderTurns.length > 0;
  const totalChars = content?.totalChars ?? 0;

  return (
    <div className="px-4 py-2">
      <div className="opacity-80">
        {/* Loading */}
        {loadingContent && (
          <div className="flex items-center justify-center gap-1.5 py-4 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            加载中…
          </div>
        )}

        {/* "查看更多" — at top, above older turns */}
        {!loadingContent && hasMore && (
          <button
            onClick={handleToggle}
            className="w-full text-center py-1 text-[0.65rem] text-muted-foreground/40 hover:text-muted-foreground/60 transition-colors"
          >
            {expanded ? (
              <span className="inline-flex items-center gap-1">
                <ChevronUp className="h-3 w-3" />
                收起
              </span>
            ) : (
              <span className="inline-flex items-center gap-1">
                <ChevronDown className="h-3 w-3" />
                查看更多
              </span>
            )}
          </button>
        )}

        {/* Older turns — appear above when expanded */}
        {expanded && !loadingContent && olderTurns.length > 0 &&
          olderTurns.map((t, i) => (
            <MemoryTurn key={i} content={t.content} role={t.role} />
          ))
        }

        {/* Last turn — always visible */}
        {!loadingContent && lastTurn && (
          <MemoryTurn content={lastTurn.content} role={lastTurn.role} />
        )}

        {/* Large slice: collapsed hint */}
        {!expanded && !loadingContent && totalChars > 3000 && content && (
          <div className="text-center py-1 text-[0.65rem] text-muted-foreground/40">
            {content.totalTurns} 轮 · {Math.round(totalChars / 1000)}k 字
          </div>
        )}
      </div>

      {/* Summary caption — at bottom */}
      {slice.summary && (
        <p className="text-[0.7rem] text-muted-foreground/50 italic mt-0.5 leading-relaxed">
          {slice.summary}
        </p>
      )}

      {/* Open loops */}
      {slice.open_loops.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-1">
          {slice.open_loops.map((loop, i) => (
            <span key={i} className="inline-flex items-center rounded-full bg-red-500/5 px-1.5 py-0.5 text-[0.6rem] text-red-400/60">
              🔴 {loop}
            </span>
          ))}
        </div>
      )}

      {/* Decisions */}
      {slice.decisions.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-0.5">
          {slice.decisions.map((d, i) => (
            <span key={i} className="inline-flex items-center rounded-full bg-green-500/5 px-1.5 py-0.5 text-[0.6rem] text-green-400/60">
              ✅ {d}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
