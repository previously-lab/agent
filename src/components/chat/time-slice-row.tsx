"use client";

import type { SliceSummary } from "@/hooks/use-timeline";

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

export function TimeSliceRow({ slice }: TimeSliceRowProps) {
  const dist = getTimeDistance(slice.start);
  const isActive = slice.status === "active";

  return (
    <div
      className="group px-4 py-3 transition-opacity cursor-pointer"
      style={{
        opacity: isActive ? 1 : dist.opacity,
        filter: isActive ? "none" : `saturate(${dist.saturation})`,
        fontSize: isActive ? "0.875rem" : dist.fontSize,
      }}
    >
      <div className="flex items-center gap-2 text-muted-foreground mb-1">
        <span className="text-xs">
          {isActive ? "🔥" : "○"} {slice.focus || "Untitled"}
        </span>
        <span className="text-[0.65rem] opacity-50">{dist.label}</span>
        {slice.turnCount && (
          <span className="text-[0.65rem] opacity-40">
            · {slice.turnCount} 轮
          </span>
        )}
      </div>

      {slice.summary && (
        <p
          className="text-muted-foreground leading-relaxed mt-1 italic"
          style={{ fontSize: "0.75rem", opacity: 0.7 }}
        >
          {slice.summary}
        </p>
      )}

      {slice.open_loops.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-1.5">
          {slice.open_loops.map((loop, i) => (
            <span
              key={i}
              className="inline-flex items-center rounded-full bg-red-500/10 px-2 py-0.5 text-[0.65rem] text-red-400"
            >
              🔴 {loop}
            </span>
          ))}
        </div>
      )}

      {slice.decisions.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-1">
          {slice.decisions.map((d, i) => (
            <span
              key={i}
              className="inline-flex items-center rounded-full bg-green-500/10 px-2 py-0.5 text-[0.65rem] text-green-400"
            >
              ✅ {d}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
