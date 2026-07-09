"use client";

import type { ToolRenderState } from "@/lib/chat/tool-state";
import { FolderOpen } from "lucide-react";
import { ToolLayout } from "../tool-layout";

interface ListFilesRendererProps {
  input?: { path?: string };
  output?: Array<{ name: string; type: string }>;
  state: ToolRenderState;
}

export function ListFilesRenderer({ input, output, state }: ListFilesRendererProps) {
  const dirPath = input?.path ?? "...";
  const files = Array.isArray(output) ? output : [];

  const expandedContent = files.length > 0 ? (
    <div className="max-h-64 overflow-auto rounded-md border border-border bg-muted/50 p-3 font-mono text-xs leading-relaxed text-muted-foreground">
      {files.map((f, i) => (
        <div key={i} className="flex items-center gap-2">
          <span className="text-muted-foreground">
            {f.type === "dir" ? "📁" : "📄"}
          </span>
          <span>{f.name}</span>
        </div>
      ))}
    </div>
  ) : undefined;

  const summary = (
    <span className="font-mono text-muted-foreground">
      {dirPath}
      {files.length > 0 && (
        <span className="ml-1.5 text-muted-foreground">
          ({files.length} items)
        </span>
      )}
    </span>
  );

  return (
    <ToolLayout
      name="List"
      icon={<FolderOpen className="h-3.5 w-3.5" />}
      summary={summary}
      meta={files.length > 0 ? `${files.length} items` : undefined}
      state={state}
      expandedContent={expandedContent}
    />
  );
}
