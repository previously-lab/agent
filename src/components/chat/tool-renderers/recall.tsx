"use client";

import type { ToolRenderState } from "@/lib/chat/tool-state";
import { History } from "lucide-react";
import { useTranslations } from "next-intl";
import { ToolLayout } from "../tool-layout";

interface RecallToolRendererProps {
  displayName: string;
  input?: unknown;
  output?: unknown;
  state: ToolRenderState;
}

interface RecallHit {
  slice_id: string;
  relevance: number;
  reason: string;
  key_turns?: number[];
}

interface RecallOutput {
  hits?: RecallHit[];
  rawContents?: Record<string, string>;
  confidence?: number;
  reasoning?: string;
}

export function RecallToolRenderer({
  displayName,
  input,
  output,
  state,
}: RecallToolRendererProps) {
  const t = useTranslations("chat.tool");

  const inp = input as Record<string, unknown> | undefined;
  const query = typeof inp?.query === "string" ? inp.query : "";

  const out = output as RecallOutput | undefined;
  const hits = Array.isArray(out?.hits) ? out.hits : [];
  const rawContents = out?.rawContents ?? {};
  const confidence = typeof out?.confidence === "number" ? out.confidence : null;
  const reasoning = typeof out?.reasoning === "string" ? out.reasoning : "";

  const hasHits = hits.length > 0;
  const isRunning = state.running;

  // Summary for collapsed state
  const summary = isRunning
    ? query || ""
    : hasHits
      ? t("recallHits", { count: hits.length })
      : t("recallNone");

  // Expanded content — recall hits + raw content
  const expandedContent = hasHits ? (
    <div className="space-y-3">
      {/* Reasoning */}
      {reasoning && (
        <p className="text-[10px] text-muted-foreground italic leading-relaxed">
          {reasoning}
        </p>
      )}

      {/* Hits table */}
      <div className="space-y-1.5">
        {hits.map((hit, i) => (
          <div key={i} className="rounded-md border border-border bg-muted/40 px-3 py-2 space-y-1">
            <div className="flex items-start justify-between gap-2">
              <span className="font-mono text-xs text-muted-foreground">
                {hit.slice_id}
              </span>
              <span className="text-[10px] text-muted-foreground shrink-0">
                {Math.round(hit.relevance * 100)}%
              </span>
            </div>
            <p className="text-xs text-muted-foreground leading-relaxed">
              {hit.reason}
            </p>
            {hit.key_turns && hit.key_turns.length > 0 && (
              <p className="text-[10px] text-muted-foreground">
                Key turns: {hit.key_turns.join(", ")}
              </p>
            )}
            {/* Raw content for this slice */}
            {rawContents[hit.slice_id] && (
              <details className="mt-1">
                <summary className="cursor-pointer text-[10px] text-muted-foreground hover:text-foreground transition-colors">
                  Raw content
                </summary>
                <pre className="mt-1 max-h-48 overflow-auto rounded border border-border/50 bg-muted/30 p-2 font-mono text-[10px] leading-relaxed text-muted-foreground whitespace-pre-wrap">
                  {rawContents[hit.slice_id]}
                </pre>
              </details>
            )}
          </div>
        ))}
      </div>

      {/* Confidence */}
      {confidence !== null && (
        <p className="text-[10px] text-muted-foreground">
          Confidence: {Math.round(confidence * 100)}%
        </p>
      )}
    </div>
  ) : reasoning ? (
    <p className="text-xs text-muted-foreground leading-relaxed">{reasoning}</p>
  ) : undefined;

  return (
    <ToolLayout
      name={displayName}
      icon={<History className="h-3.5 w-3.5" />}
      summary={summary}
      state={state}
      defaultExpanded
      expandedContent={expandedContent}
    />
  );
}
