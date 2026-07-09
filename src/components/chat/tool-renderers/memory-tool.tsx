"use client";

import type { ToolRenderState } from "@/lib/chat/tool-state";
import { Search } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { ToolLayout } from "../tool-layout";

interface MemoryToolRendererProps {
  toolName: string;
  displayName: string;
  input?: unknown;
  output?: unknown;
  state: ToolRenderState;
}

export function MemoryToolRenderer({
  toolName,
  displayName,
  input,
  output,
  state,
}: MemoryToolRendererProps) {
  const t = useTranslations("chat.tool");
  const locale = useLocale();
  const showToolName = toolName !== displayName.toLowerCase().replace(/\s+/g, "-");

  // Extract short summary for collapsed display
  const inp = input as Record<string, unknown> | undefined;
  const rawPath = typeof inp?.path === "string" ? inp.path : null;
  const shortPath = rawPath?.replace("memory/episodic/slices/", "") ?? null;
  const year = typeof inp?.year === "number" ? inp.year : null;
  const month = typeof inp?.month === "number" ? inp.month : null;
  const indexLabel = year && month
    ? new Date(year, month - 1, 1).toLocaleString(locale, { month: "long", year: "numeric" })
    : null;

  const summary = shortPath ? (
    <span className="font-mono text-muted-foreground text-xs truncate max-w-xs">
      {shortPath}
    </span>
  ) : indexLabel ? (
    <span className="text-muted-foreground text-xs">{indexLabel}</span>
  ) : null;

  // Build expanded content — show real tool name + output
  const hasOutput = output != null;
  const expandedContent = hasOutput ? (
    <div className="space-y-2">
      <p className="text-[10px] text-muted-foreground">
        {t("expandedLabel")} <span className="font-mono">{toolName}</span>
      </p>
      {typeof output === "string" ? (
        <div className="max-h-80 overflow-auto rounded-md border border-border">
          <pre className="p-3 font-mono text-xs leading-relaxed text-muted-foreground whitespace-pre-wrap">
            {output.length > 3000 ? output.slice(0, 3000) + "\n…" : output}
          </pre>
        </div>
      ) : output && typeof output === "object" ? (
        <div className="max-h-64 overflow-auto rounded-md border border-border bg-muted/50 p-3 font-mono text-xs leading-relaxed text-muted-foreground">
          {Array.isArray(output)
            ? (output as Array<{ name?: string; type?: string }>).map((item, i) => (
                <div key={i} className="flex items-center gap-2">
                  <span className="text-muted-foreground">
                    {item.type === "dir" ? "📁" : "📄"}
                  </span>
                  <span>{item.name ?? JSON.stringify(item)}</span>
                </div>
              ))
            : "slices" in (output as Record<string, unknown>) && "month" in (output as Record<string, unknown>)
              ? (() => {
                  const d = output as { month: string; slices: Array<{ id: string; focus: string }> };
                  const [y, m] = (d.month || "").split("-");
                  const name = new Date(parseInt(y), parseInt(m) - 1, 1).toLocaleString(locale, { month: "long", year: "numeric" });
                  return `${name} · ${t("conversations", { count: d.slices?.length ?? 0 })}`;
                })()
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
