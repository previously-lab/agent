"use client";

import type { ToolRenderState } from "@/lib/chat/tool-state";
import { FilePlus, FilePen } from "lucide-react";
import { ToolLayout } from "../tool-layout";
import { FileNamePill } from "../file-name-pill";

interface WriteFileRendererProps {
  input?: { path?: string; content?: string };
  output?: string;
  state: ToolRenderState;
}

export function WriteFileRenderer({ input, output, state }: WriteFileRendererProps) {
  const filePath = input?.path ?? "...";
  const content = input?.content ?? "";
  const isUpdate = typeof output === "string" && output.includes("updated");
  const totalLines = content.split("\n").length;

  const showCode = !state.running && !state.error && !state.denied;

  const expandedContent = showCode && content ? (
    <div className="max-h-96 overflow-auto rounded-md border border-border">
      <pre className="p-3 font-mono text-xs leading-relaxed text-muted-foreground whitespace-pre-wrap">
        {content.slice(0, 5000)}
      </pre>
    </div>
  ) : undefined;

  const meta = showCode ? (
    <span className="inline-flex items-center gap-1.5">
      <span className="text-green-500">+{totalLines}</span>
      <span className="text-red-500">-0</span>
    </span>
  ) : undefined;

  return (
    <ToolLayout
      name={isUpdate ? "Update" : "Create"}
      icon={isUpdate ? <FilePen className="h-3.5 w-3.5" /> : <FilePlus className="h-3.5 w-3.5" />}
      summary={
        <FileNamePill filePath={filePath} error={state.error != null} />
      }
      meta={meta}
      errorMeta={state.error ? "failed" : undefined}
      state={state}
      expandedContent={expandedContent}
    />
  );
}
