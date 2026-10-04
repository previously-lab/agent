"use client";

import type { ToolRenderState } from "@/lib/chat/tool-state";
import { Search } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { ToolLayout } from "../tool-layout";

interface MemoryToolRendererProps {
  toolName: string;
  input?: unknown;
  output?: unknown;
  state: ToolRenderState;
}

/** Extract a human-friendly timestamp from a slice path like
 *  "memory/episodic/slices/2025/07/25/1430.md" → "Jul 25 14:30" (locale-aware). */
function extractDateFromPath(
  rawPath: string,
  locale: string,
): string | null {
  const stripped = rawPath.replace("memory/episodic/slices/", "").replace(/\.md$/, "");
  const parts = stripped.split("/");
  // Expect YYYY/MM/DD or YYYY/MM/DD/HHMM
  if (parts.length < 3) return null;
  const [y, m, d, hhmm] = parts;
  const year = parseInt(y, 10);
  const month = parseInt(m, 10);
  const day = parseInt(d, 10);
  if (isNaN(year) || isNaN(month) || isNaN(day)) return null;

  const date = new Date(year, month - 1, day);
  const dateStr = date.toLocaleString(locale, { month: "short", day: "numeric" });

  if (hhmm && hhmm.length === 4) {
    const hour = parseInt(hhmm.slice(0, 2), 10);
    const min = hhmm.slice(2);
    return `${dateStr} ${hour}:${min}`;
  }
  return dateStr;
}

/**
 * Display name for memory-read tools — static for internal reads
 * (readPreviously, readAgentTimeline), content-aware for readSlice.
 * (The readTimeline / readTimelineWindow / readStrand cases left with the
 * retired tools; the dispatcher never routes those names here anymore.)
 */
function resolveName(
  toolName: string,
  input: Record<string, unknown> | undefined,
  running: boolean,
  t: ReturnType<typeof useTranslations>,
  locale: string,
): string {
  const rawPath = typeof input?.path === "string" ? input.path : null;

  switch (toolName) {
    case "readSlice": {
      if (!rawPath) return running ? t("readSliceRunning", { date: "…" }) : t("readSliceDone", { date: "…" });
      const dateStr = extractDateFromPath(rawPath, locale) ?? rawPath;
      return running
        ? t("readSliceRunning", { date: dateStr })
        : t("readSliceDone", { date: dateStr });
    }
    case "readPreviously":
    case "readAgentTimeline":
      return t(toolName);
    default:
      return toolName;
  }
}

export function MemoryToolRenderer({
  toolName,
  input,
  output,
  state,
}: MemoryToolRendererProps) {
  const t = useTranslations("chat.tool");
  const locale = useLocale();

  const inp = input as Record<string, unknown> | undefined;
  const rawPath = typeof inp?.path === "string" ? inp.path : null;
  const shortPath = rawPath?.replace("memory/episodic/slices/", "") ?? null;

  const displayName = resolveName(toolName, inp, state.running, t, locale);

  const summary = shortPath ? (
    <span className="font-mono text-muted-foreground text-xs truncate max-w-xs">
      {shortPath}
    </span>
  ) : null;

  // Build expanded content
  const hasOutput = output != null;
  const expandedContent = hasOutput ? (
    <div>
      {typeof output === "string" ? (
        <pre className="font-mono text-xs leading-relaxed text-muted-foreground whitespace-pre-wrap">
          {output.length > 3000 ? output.slice(0, 3000) + "\n…" : output}
        </pre>
      ) : output && typeof output === "object" ? (
        <div className="font-mono text-xs leading-relaxed text-muted-foreground">
          {Array.isArray(output)
            ? (output as Array<{ name?: string; type?: string }>).map((item, i) => (
                <div key={i} className="flex items-center gap-2">
                  <span className="text-muted-foreground">
                    {item.type === "dir" ? "📁" : "📄"}
                  </span>
                  <span>{item.name ?? JSON.stringify(item)}</span>
                </div>
              ))
            : JSON.stringify(output, null, 2).slice(0, 2000)}
        </div>
      ) : null}
    </div>
  ) : undefined;

  return (
    <ToolLayout
      name={displayName}
      icon={<Search className="h-3.5 w-3.5" />}
      summary={summary}
      summaryClassName="font-mono"
      state={state}
      expandedContent={expandedContent}
    />
  );
}
