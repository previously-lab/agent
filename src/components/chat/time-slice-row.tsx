"use client";

import { useState } from "react";
import type { SliceSummary } from "@/hooks/use-timeline";
import { getSliceContent, type SliceContent } from "@/lib/episodic/actions";
import { Loader2, ChevronDown, ChevronUp } from "lucide-react";
import dayjs from "dayjs";

// ─── Memory turn preview — reuses ChatMessage bubble styles ───────────────

function MemoryTurn({ content, role }: { content: string; role: string }) {
  const isUser = role === "user";
  const display = content.length > 300 ? content.slice(0, 300) + "…" : content;
  return (
    <div className={`flex min-w-0 py-1 ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[85%] sm:max-w-[75%] min-w-0 rounded-3xl px-4 py-2 text-sm leading-relaxed
          ${isUser
            ? "bg-secondary text-foreground/80 rounded-br-md"
            : "bg-card/70 border rounded-bl-md text-foreground/80"
          }`}
      >
        <span className="whitespace-pre-wrap">{display}</span>
      </div>
    </div>
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

  const handleExpand = async () => {
    if (content) {
      setExpanded(!expanded);
      return;
    }
    setExpanded(true);
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
  const isSmall = totalChars > 0 && totalChars < 500;
  const isMedium = totalChars >= 500 && totalChars <= 3000;
  const isLarge = totalChars > 3000;
  const lastTurn = content?.turns[content.turns.length - 1];

  return (
    <div className="px-4 py-2">
      {/* Clickable area to expand/collapse */}
      <div
        className="cursor-pointer"
        onClick={handleExpand}
      >
        {/* Expanded content */}
        {expanded && (
          <div className="opacity-90">
            {loadingContent ? (
              <div className="flex items-center justify-center gap-1.5 py-4 text-xs text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" />
                加载中…
              </div>
            ) : content ? (
              <>
                {isSmall &&
                  content.turns.map((t, i) => (
                    <MemoryTurn key={i} content={t.content} role={t.role} />
                  ))}

                {isMedium && !showAllTurns && lastTurn && (
                  <MemoryTurn content={lastTurn.content} role={lastTurn.role} />
                )}
                {isMedium && showAllTurns &&
                  content.turns.map((t, i) => (
                    <MemoryTurn key={i} content={t.content} role={t.role} />
                  ))}

                {isLarge && !showAllTurns && (
                  <div className="text-center py-2 text-xs text-muted-foreground/50">
                    {content.totalTurns} 轮 · {Math.round(totalChars / 1000)}k 字
                  </div>
                )}
                {isLarge && showAllTurns &&
                  content.turns.map((t, i) => (
                    <MemoryTurn key={i} content={t.content} role={t.role} />
                  ))}
              </>
            ) : null}
          </div>
        )}

        {/* Expand/collapse indicator + summary at bottom */}
        <div className="flex items-center gap-2 mt-1">
          {!expanded && (
            <button
              onClick={handleExpand}
              className="text-[0.65rem] text-muted-foreground/40 hover:text-muted-foreground/60 transition-colors"
            >
              {content ? "收起" : `展开${slice.turnCount ? ` ${slice.turnCount} 轮` : ""}`}
            </button>
          )}
          {expanded && (
            <button
              onClick={(e) => { e.stopPropagation(); setExpanded(false); }}
              className="text-[0.65rem] text-muted-foreground/40 hover:text-muted-foreground/60"
            >
              收起
            </button>
          )}
          {/* "load more within slice" for medium slices */}
          {expanded && isMedium && !showAllTurns && content && (
            <button
              onClick={(e) => { e.stopPropagation(); setShowAllTurns(true); }}
              className="text-[0.65rem] text-muted-foreground/40 hover:text-muted-foreground/60 ml-auto"
            >
              展开更多 {content.totalTurns} 轮
            </button>
          )}
          {/* "load more within slice" for large slices */}
          {expanded && isLarge && !showAllTurns && content && (
            <button
              onClick={(e) => { e.stopPropagation(); setShowAllTurns(true); }}
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
    </div>
  );
}
