"use client";

import type { ToolRenderState } from "@/lib/chat/tool-state";
import { FileText } from "lucide-react";
import { useTranslations } from "next-intl";
import { ToolLayout } from "../tool-layout";

interface ReadDocOutput {
  path?: string;
  opened?: string;
  updated?: string;
  closed?: string | null;
  content?: string;
  warnings?: string[];
  error?: string;
}

interface ReadDocRendererProps {
  toolName: string;
  input?: { ref?: string };
  output?: ReadDocOutput;
  state: ToolRenderState;
}

/** Compact identity label for the summary line: category/case[/piece]. */
function refLabel(input: { ref?: string } | undefined, output: ReadDocOutput | undefined): string {
  const fromOutput = output?.path?.replace(/^memory\//, "").replace(/\.md$/, "");
  const raw = input?.ref ?? fromOutput ?? "…";
  return raw.length > 48 ? raw.slice(0, 48) + "…" : raw;
}

/**
 * readDoc renderer — two-segment case-document point-read (v0.19 §B.2).
 * The summary is the reference (identity); the expanded view shows the
 * opened date and the updated stamp (v0.21 — the freshness material the
 * reader judges by eye), the full document text, and the dead-link error
 * when the reference resolved nowhere.
 */
export function ReadDocRenderer({ toolName: _toolName, input, output, state }: ReadDocRendererProps) {
  const t = useTranslations("chat.tool");
  const label = refLabel(input, output);
  const error = typeof output?.error === "string" ? output.error : null;

  const displayName = state.running
    ? t("readDocRunning", { name: label })
    : t("readDocDone", { name: label });

  const expandedContent = error ? (
    <p className="text-xs leading-relaxed text-muted-foreground">{error}</p>
  ) : output?.content ? (
    <div className="space-y-2">
      {(output.opened || output.updated) && (
        <p className="font-mono text-xs text-muted-foreground">
          opened: {output.opened || "?"}
          {output.updated ? ` · updated: ${output.updated}` : ""}
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
          {label}
        </span>
      }
      state={state}
      expandedContent={expandedContent}
    />
  );
}
