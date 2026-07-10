"use client";

import { useTranslations } from "next-intl";
import { History } from "lucide-react";
import type { ToolRenderState } from "@/lib/chat/tool-state";
import { ToolLayout } from "./tool-layout";
import { ToolRenderer } from "./tool-renderer";

const COMPLETED_STATE: ToolRenderState = {
  running: false,
  interrupted: false,
  denied: false,
  approvalRequested: false,
  isActiveApproval: false,
};

const STREAMING_STATE: ToolRenderState = {
  running: true,
  interrupted: false,
  denied: false,
  approvalRequested: false,
  isActiveApproval: false,
};

export type RecallCategory = "timeline" | "browse";

export interface RecallToolPart {
  toolCallId?: string;
  toolName: string;
  state: string;
  input?: unknown;
  output?: unknown;
}

interface RecallGroupProps {
  category: RecallCategory;
  parts: RecallToolPart[];
  isStreaming?: boolean;
}

/**
 * Collapses a run of consecutive memory-read tool calls into a single "act of
 * recall" — one line with a count (e.g. "Read 12 timeline records"), expandable
 * to the individual reads. Keeps a dozen readMemory calls from reading like a
 * mechanical log.
 */
export function RecallGroup({ category, parts, isStreaming = false }: RecallGroupProps) {
  const t = useTranslations("chat.recall.group");
  const running =
    isStreaming &&
    parts.some((p) => p.state === "input-streaming" || p.state === "input-available");

  const expandedContent = (
    <div className="space-y-1 rounded-md border border-border bg-muted/40 px-2 py-1.5">
      {parts.map((p, i) => (
        <ToolRenderer
          key={p.toolCallId ?? `recall-${i}`}
          toolName={p.toolName}
          state={p.state}
          input={p.input}
          output={p.output}
          isStreaming={isStreaming}
        />
      ))}
    </div>
  );

  return (
    <ToolLayout
      name={t(category, { count: parts.length })}
      icon={<History className="h-3.5 w-3.5" />}
      summary=""
      state={running ? STREAMING_STATE : COMPLETED_STATE}
      expandedContent={expandedContent}
    />
  );
}
