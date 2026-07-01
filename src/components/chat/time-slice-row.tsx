"use client";

import { useState } from "react";
import type { SliceSummary } from "@/hooks/use-timeline";
import { getSliceContent, type SliceContent } from "@/lib/episodic/actions";
import { Loader2, ChevronDown, ChevronUp } from "lucide-react";

function getTimeDistance(start: string): {
  label: string;
  saturation: number;
  fontSize: string;
  opacity: number;
} {
  const now = Date.now();
  const then = new Date(start).getTime();
  const days = (now - then) / (1000 * 60 * 60 * 24);

  if (days < 1) return { label: "今天", saturation: 1, fontSize: "0.875rem", opacity: 1 };
  if (days < 3) return { label: `${Math.round(days)} 天前`, saturation: 0.7, fontSize: "0.875rem", opacity: 0.85 };
  if (days < 7) return { label: `${Math.round(days)} 天前`, saturation: 0.5, fontSize: "0.8125rem", opacity: 0.7 };
  if (days < 30) return { label: `${Math.round(days / 7)} 周前`, saturation: 0.35, fontSize: "0.8125rem", opacity: 0.6 };
  return { label: `${Math.round(days / 30)} 月前`, saturation: 0.25, fontSize: "0.75rem", opacity: 0.5 };
}

interface TimeSliceRowProps {
  slice: SliceSummary;
}

function TurnPreview({ content, role }: { content: string; role: string }) {
  const display = content.length > 200 ? content.slice(0, 200) + "..." : content;
  return (
    <div className="text-xs text-muted-foreground/60 mt-1 leading-relaxed">
      <span className="font-medium text-muted-foreground/40">
        {role === "user" ? "我" : "A"}：
      </span>
      {display}
    </div>
  );
}

export function TimeSliceRow({ slice }: TimeSliceRowProps) {
  const dist = getTimeDistance(slice.start);
  const isActive = slice.status === "active";
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

  // Determine rendering tier by total chars
  const totalChars = content?.totalChars ?? 0;
  const isSmall = totalChars > 0 && totalChars < 500;
  const isMedium = totalChars >= 500 && totalChars <= 3000;
  const isLarge = totalChars > 3000;

  const lastTurn = content?.turns[content.turns.length - 1];
  const firstTurn = content?.turns[0];

  return (
    <div
      className="group px-4 py-3 transition-opacity cursor-pointer hover:bg-muted/30"
      style={{
        opacity: isActive ? 1 : dist.opacity,
        filter: isActive ? "none" : `saturate(${dist.saturation})`,
        fontSize: isActive ? "0.875rem" : dist.fontSize,
      }}
      onClick={handleExpand}
    >
      {/* Header */}
      <div className="flex items-center gap-2 text-muted-foreground mb-1">
        <span className="text-xs">
          {isActive ? "🔥" : "○"} {slice.focus || slice.slice_id}
        </span>
        <span className="text-[0.65rem] opacity-50">
          {isActive ? "当前" : dist.label}
        </span>
        {slice.turnCount && (
          <span className="text-[0.65rem] opacity-40">
            · {slice.turnCount} 轮
          </span>
        )}
        {!isActive && (
          <span className="ml-auto text-[0.65rem] opacity-30">
            {expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
          </span>
        )}
      </div>

      {/* Summary caption */}
      {slice.summary && (
        <p className="text-muted-foreground leading-relaxed mt-1 italic" style={{ fontSize: "0.75rem", opacity: 0.7 }}>
          {slice.summary}
        </p>
      )}

      {/* Expanded content */}
      {expanded && (
        <div className="mt-2 pl-3 border-l-2 border-border/20">
          {loadingContent ? (
            <div className="flex items-center gap-1.5 py-2 text-xs text-muted-foreground/50">
              <Loader2 className="h-3 w-3 animate-spin" />
              加载中...
            </div>
          ) : content ? (
            <>
              {/* Small: show all turns */}
              {isSmall &&
                content.turns.map((t, i) => (
                  <TurnPreview key={i} content={t.content} role={t.role} />
                ))}

              {/* Medium: show last turn + expand more */}
              {isMedium && !showAllTurns && lastTurn && (
                <>
                  <TurnPreview content={lastTurn.content} role={lastTurn.role} />
                  <button
                    onClick={(e) => { e.stopPropagation(); setShowAllTurns(true); }}
                    className="text-[0.65rem] text-muted-foreground/40 hover:text-muted-foreground/60 mt-1"
                  >
                    展开更多 {content.totalTurns} 轮
                  </button>
                </>
              )}
              {isMedium && showAllTurns &&
                content.turns.map((t, i) => (
                  <TurnPreview key={i} content={t.content} role={t.role} />
                ))}

              {/* Large: summary + open_loops/decisions only, expand for full */}
              {isLarge && !showAllTurns && (
                <button
                  onClick={(e) => { e.stopPropagation(); setShowAllTurns(true); }}
                  className="text-xs text-muted-foreground/50 hover:text-muted-foreground/70 mt-1"
                >
                  展开全部 {content.totalTurns} 轮 ({Math.round(totalChars / 1000)}k 字)
                </button>
              )}
              {isLarge && showAllTurns &&
                content.turns.map((t, i) => (
                  <TurnPreview key={i} content={t.content} role={t.role} />
                ))}
            </>
          ) : null}
        </div>
      )}

      {/* Open loops & decisions (always visible) */}
      {slice.open_loops.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-1.5">
          {slice.open_loops.map((loop, i) => (
            <span key={i} className="inline-flex items-center rounded-full bg-red-500/10 px-2 py-0.5 text-[0.65rem] text-red-400">
              🔴 {loop}
            </span>
          ))}
        </div>
      )}
      {slice.decisions.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-1">
          {slice.decisions.map((d, i) => (
            <span key={i} className="inline-flex items-center rounded-full bg-green-500/10 px-2 py-0.5 text-[0.65rem] text-green-400">
              ✅ {d}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
