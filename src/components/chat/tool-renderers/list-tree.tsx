"use client";

import type { ToolRenderState } from "@/lib/chat/tool-state";
import { ListTree } from "lucide-react";
import { useTranslations } from "next-intl";
import { ToolLayout } from "../tool-layout";

interface ListTreeOutput {
  truncated?: boolean;
  tree?: Record<string, string[]>;
}

interface ListTreeRendererProps {
  toolName: string;
  input?: unknown;
  output?: ListTreeOutput;
  state: ToolRenderState;
}

/**
 * listTree renderer — the whole memory tree in one grouped listing
 * (v0.19 §A.2.1, transitional placeholder). Groups by top-level category,
 * paths ascending; the truncated flag renders as a visible warning row.
 */
export function ListTreeRenderer({ toolName: _toolName, output, state }: ListTreeRendererProps) {
  const t = useTranslations("chat.tool");
  const groups = output?.tree ?? {};
  const entries = Object.entries(groups);
  const totalPaths = entries.reduce((n, [, paths]) => n + paths.length, 0);
  const truncated = output?.truncated === true;

  const displayName = state.running
    ? t("listTreeRunning")
    : t("listTreeDone", { count: totalPaths });

  const expandedContent = entries.length > 0 || truncated ? (
    <div className="space-y-2">
      {entries.map(([category, paths]) => (
        <div key={category}>
          <p className="text-xs font-semibold text-foreground/80">{category}/</p>
          <div className="font-mono text-xs leading-relaxed text-muted-foreground">
            {paths.map((p, i) => (
              <div key={i}>{p}</div>
            ))}
          </div>
        </div>
      ))}
      {truncated && (
        <p className="text-xs leading-relaxed text-muted-foreground italic">
          {t("listTreeTruncated")}
        </p>
      )}
    </div>
  ) : undefined;

  return (
    <ToolLayout
      name={displayName}
      icon={<ListTree className="h-3.5 w-3.5" />}
      summary={
        <span className="font-mono text-muted-foreground text-xs">
          memory/
          {entries.length > 0 && (
            <span className="ml-1.5">
              ({t("items", { count: totalPaths })})
            </span>
          )}
        </span>
      }
      meta={entries.length > 0 ? t("items", { count: totalPaths }) : undefined}
      state={state}
      expandedContent={expandedContent}
    />
  );
}
