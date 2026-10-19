"use client";

import type { ToolRenderState } from "@/lib/chat/tool-state";
import { Search } from "lucide-react";
import { useTranslations } from "next-intl";
import { ToolLayout } from "../tool-layout";

interface RecallToolRendererProps {
  toolName: string;
  input?: unknown;
  output?: unknown;
  state: ToolRenderState;
}

/**
 * The v0.36 memory-read verbs (recallRecent / recallFind / recallSearch /
 * recallRead) — one renderer for the whole family. The verb name is the
 * display name (the four verbs are the vocabulary the user sees); a short
 * detail line carries the locating input (category/name/query/ref), and the
 * expanded card shows the fixed-render text the model received.
 */
export function RecallToolRenderer({
  toolName,
  input,
  output,
  state,
}: RecallToolRendererProps) {
  const t = useTranslations("chat.tool");

  const inp = (input ?? {}) as Record<string, unknown>;
  const detail =
    (typeof inp.ref === "string" && inp.ref) ||
    (typeof inp.name === "string" && inp.name) ||
    (typeof inp.query === "string" && inp.query) ||
    (Array.isArray(inp.query) ? inp.query.join(" ") : "") ||
    (typeof inp.category === "string" && inp.category) ||
    null;

  const displayName = t(`recall.${toolName}`, { defaultValue: toolName });

  const summary = detail ? (
    <span className="font-mono text-muted-foreground text-xs truncate max-w-xs">
      {detail}
    </span>
  ) : null;

  const hasOutput = output != null && typeof output === "string";
  const expandedContent = hasOutput ? (
    <pre className="font-mono text-xs leading-relaxed text-muted-foreground whitespace-pre-wrap">
      {output.length > 3000 ? output.slice(0, 3000) + "\n…" : output}
    </pre>
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
