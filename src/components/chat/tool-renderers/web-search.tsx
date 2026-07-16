"use client";

import type { ToolRenderState } from "@/lib/chat/tool-state";
import { Globe } from "lucide-react";
import { useTranslations } from "next-intl";
import { ToolLayout } from "../tool-layout";
import { MarkdownRenderer } from "../markdown";

interface WebSearchRendererProps {
  displayName: string;
  input?: unknown;
  output?: unknown;
  state: ToolRenderState;
}

/**
 * webSearch tool: Globe icon, the query as the collapsed summary, and the
 * cited answer + source links in the expanded view. Sources render as real
 * anchors so the user can verify what Flash found.
 */
export function WebSearchRenderer({
  displayName,
  input,
  output,
  state,
}: WebSearchRendererProps) {
  const t = useTranslations("chat.tool");

  const query =
    typeof (input as { query?: unknown } | undefined)?.query === "string"
      ? ((input as { query: string }).query)
      : null;

  const out = output as
    | { answer?: string; sources?: Array<{ title?: string; url?: string }>; error?: string }
    | undefined;
  const sources = Array.isArray(out?.sources)
    ? out.sources.filter((s): s is { title: string; url: string } => typeof s?.url === "string")
    : [];

  const summary = query ? (
    <span className="text-muted-foreground text-xs truncate max-w-xs">{query}</span>
  ) : null;

  const meta =
    sources.length > 0 ? t("sources", { count: sources.length }) : undefined;

  const expandedContent = out ? (
    out.error ? (
      <p className="text-xs text-destructive">{out.error}</p>
    ) : (
      // One scrollable container: the answer and its sources belong together —
      // sources are part of the search result, so they scroll with it.
      <div className="max-h-80 overflow-auto rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground leading-relaxed space-y-2">
        {out.answer ? <MarkdownRenderer content={out.answer} /> : null}
        {sources.length > 0 ? (
          <ul
            className={
              out.answer
                ? "space-y-1 border-t border-border pt-2"
                : "space-y-1"
            }
          >
            {sources.map((s, i) => (
              <li key={i} className="flex items-start gap-2 text-xs">
                <span className="text-muted-foreground shrink-0">[{i + 1}]</span>
                <a
                  href={s.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-600 dark:text-blue-400 underline underline-offset-2 truncate"
                >
                  {s.title || s.url}
                </a>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    )
  ) : undefined;

  return (
    <ToolLayout
      name={displayName}
      icon={<Globe className="h-3.5 w-3.5" />}
      summary={summary}
      meta={meta}
      state={state}
      expandedContent={expandedContent}
    />
  );
}
