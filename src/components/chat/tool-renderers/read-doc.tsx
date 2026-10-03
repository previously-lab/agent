"use client";

import type { ToolRenderState } from "@/lib/chat/tool-state";
import { FileText } from "lucide-react";
import { useTranslations } from "next-intl";
import { ToolLayout } from "../tool-layout";

interface ReadDocOutput {
  fileName?: string;
  kind?: string;
  status?: string;
  opened?: string;
  updated?: string;
  content?: string;
  warnings?: string[];
  error?: string;
}

interface ReadDocRendererProps {
  toolName: string;
  input?: { fileName?: string };
  output?: ReadDocOutput;
  state: ToolRenderState;
}

/**
 * readDoc renderer — point-read of one document by file name (v0.15 §4.2).
 * The summary is the file name (identity); the expanded view shows the
 * machine header (status/opened/updated — the freshness material the reader
 * judges by eye) plus the full document text, or the visible dead-link error.
 */
export function ReadDocRenderer({ toolName: _toolName, input, output, state }: ReadDocRendererProps) {
  const t = useTranslations("chat.tool");
  const fileName =
    (typeof output?.fileName === "string" && output.fileName) ||
    (typeof input?.fileName === "string" && input.fileName) ||
    "…";
  const error = typeof output?.error === "string" ? output.error : null;

  const displayName = state.running
    ? t("readDocRunning", { name: fileName })
    : t("readDocDone", { name: fileName });

  const expandedContent = error ? (
    <p className="text-xs leading-relaxed text-muted-foreground">{error}</p>
  ) : output?.content ? (
    <div className="space-y-2">
      {(output.status || output.updated) && (
        <p className="font-mono text-xs text-muted-foreground">
          {output.kind && <span>{output.kind} · </span>}
          {output.status && <span>status: {output.status} · </span>}
          {output.opened && <span>opened: {output.opened} · </span>}
          {output.updated && <span>updated: {output.updated}</span>}
        </p>
      )}
      <pre className="font-mono text-xs leading-relaxed text-muted-foreground whitespace-pre-wrap">
        {output.content.length > 6000
          ? output.content.slice(0, 6000) + "\n…"
          : output.content}
      </pre>
      {Array.isArray(output.warnings) && output.warnings.length > 0 && (
        <ul className="space-y-0.5">
          {output.warnings.map((w, i) => (
            <li key={i} className="text-xs text-muted-foreground italic">
              {w}
            </li>
          ))}
        </ul>
      )}
    </div>
  ) : undefined;

  return (
    <ToolLayout
      name={displayName}
      icon={<FileText className="h-3.5 w-3.5" />}
      summary={
        <span className="font-mono text-muted-foreground text-xs truncate max-w-xs">
          {fileName}
        </span>
      }
      state={state}
      expandedContent={expandedContent}
    />
  );
}
