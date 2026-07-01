"use client";

import { useState } from "react";
import type { SliceSummary } from "@/hooks/use-timeline";
import { getSliceContent, type SliceContent } from "@/lib/episodic/actions";
import { Loader2, ChevronUp, ChevronDown } from "lucide-react";
import { Message, MessageContent } from "@/components/ui/message";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import dayjs from "dayjs";

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

// ─── Time distance helper (dayjs) ────────────────────────────────────────

export function formatSliceDate(start: string): string {
  const d = dayjs(start);
  const now = dayjs();
  if (d.isSame(now, "day")) return "今天";
  if (d.isSame(now.subtract(1, "day"), "day")) return "昨天";
  if (d.isSame(now, "year")) return d.format("M月D日");
  return d.format("YYYY年M月D日");
}

// ─── Main component ──────────────────────────────────────────────────────

interface TimeSliceRowProps {
  slice: SliceSummary;
}

export function TimeSliceRow({ slice }: TimeSliceRowProps) {
  const [expanded, setExpanded] = useState(false);
  const [content, setContent] = useState<SliceContent | null>(null);
  const [loadingContent, setLoadingContent] = useState(false);
  const [showAllTurns, setShowAllTurns] = useState(false);

  const handleToggle = async () => {
    if (expanded) {
      setExpanded(false);
      setShowAllTurns(false);
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

  const totalChars = content?.totalChars ?? 0;
  const isMedium = totalChars >= 500 && totalChars <= 3000;
  const isLarge = totalChars > 3000;
  const allTurns = content?.turns ?? [];
  const lastTurn = allTurns[allTurns.length - 1];
  const olderTurns = allTurns.slice(0, -1); // everything except the last

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

        {/* Older turns — shown when expanded, ABOVE the last turn */}
        {expanded && !loadingContent && content && (
          <>
            {!isLarge && olderTurns.map((t, i) => (
              <MemoryTurn key={i} content={t.content} role={t.role} />
            ))}
            {isLarge && showAllTurns &&
              allTurns.map((t, i) => (
                <MemoryTurn key={i} content={t.content} role={t.role} />
              ))}
          </>
        )}

        {/* Last turn — always visible */}
        {!loadingContent && lastTurn && (
          <MemoryTurn content={lastTurn.content} role={lastTurn.role} />
        )}

        {/* Large slice: collapsed state */}
        {!expanded && isLarge && content && (
          <div className="text-center py-1 text-[0.65rem] text-muted-foreground/40">
            {content.totalTurns} 轮 · {Math.round(totalChars / 1000)}k 字
          </div>
        )}
      </div>

      {/* Toggle + summary */}
      <div className="flex items-center gap-2 mt-1">
        <button
          onClick={handleToggle}
          className="inline-flex items-center gap-1 text-[0.65rem] text-muted-foreground/40 hover:text-muted-foreground/60 transition-colors"
        >
          {expanded ? (
            <><ChevronUp className="h-3 w-3" /> 收起</>
          ) : (
            <><ChevronDown className="h-3 w-3" /> 展开{slice.turnCount ? ` ${slice.turnCount} 轮` : ""}</>
          )}
        </button>

        {/* Show more within slice (medium) */}
        {expanded && isMedium && !showAllTurns && content && (
          <button
            onClick={() => setShowAllTurns(true)}
            className="text-[0.65rem] text-muted-foreground/40 hover:text-muted-foreground/60 ml-auto"
          >
            查看更多
          </button>
        )}

        {/* Show all within slice (large) */}
        {expanded && isLarge && !showAllTurns && content && (
          <button
            onClick={() => setShowAllTurns(true)}
            className="text-[0.65rem] text-muted-foreground/40 hover:text-muted-foreground/60 ml-auto"
          >
            展开全部 {content.totalTurns} 轮
          </button>
        )}
      </div>

      {/* Summary caption — always at bottom */}
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
