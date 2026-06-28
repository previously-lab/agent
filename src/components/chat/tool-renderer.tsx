"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight, Loader2, Check, AlertCircle } from "lucide-react";
import { extractRenderState, getStatusColor } from "@/lib/chat/tool-state";
import { ReadFileRenderer } from "./tool-renderers/read-file";
import { WriteFileRenderer } from "./tool-renderers/write-file";
import { ListFilesRenderer } from "./tool-renderers/list-files";
import { DefaultRenderer } from "./tool-renderers/default";

interface ToolRendererProps {
  toolName: string;
  state: string;
  input?: unknown;
  output?: unknown;
  isStreaming: boolean;
}

export function ToolRenderer({ toolName, state, input, output, isStreaming }: ToolRendererProps) {
  const [open, setOpen] = useState(false);
  const renderState = extractRenderState(state, isStreaming);
  const statusColor = getStatusColor(renderState);

  const isExpandable = renderState === "done" || renderState === "error";

  return (
    <div className="-mx-1.5 rounded-md border border-transparent bg-transparent">
      <button
        onClick={() => isExpandable && setOpen(!open)}
        className="group flex min-w-0 select-none items-center gap-2 rounded-md px-1.5 py-1 text-sm cursor-pointer transition-colors hover:bg-muted/50 w-full text-left"
      >
        {/* Status icon */}
        <span className={`flex size-4 shrink-0 items-center justify-center ${renderState === "error" ? "text-red-500" : statusColor}`}>
          {renderState === "running" ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : renderState === "error" ? (
            <AlertCircle className="h-3.5 w-3.5 text-red-500" />
          ) : (
            <Check className="h-3.5 w-3.5" />
          )}
        </span>

        {/* Tool name */}
        <span className={`min-w-0 shrink truncate font-medium leading-none ${renderState === "error" ? "text-red-500" : "text-muted-foreground/70"}`}>
          {toolName}
        </span>

        {/* Summary */}
        <span className={`min-w-0 shrink truncate font-mono text-[13px] leading-none ${renderState === "error" ? "text-red-400/80" : "text-muted-foreground"}`}>
          {getSummary(toolName, input, output)}
        </span>

        {/* Chevron — only on expandable states */}
        {isExpandable && (
          <span className={`shrink-0 transition-transform duration-200 ease-out ${open ? "rotate-90" : ""}`}>
            <ChevronRight className="size-3 text-muted-foreground/50" />
          </span>
        )}
      </button>

      {/* Expanded content */}
      {open && (
        <div className="pl-[22px] overflow-hidden"
          style={{
            display: "grid",
            gridTemplateRows: "1fr",
            transition: "grid-template-rows 200ms ease",
          }}
        >
          <div className="overflow-hidden py-1">
            {renderState === "error" ? (
              <div className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-md border border-red-500/20 bg-red-500/5 px-3 py-2 font-mono text-xs leading-relaxed text-red-400">
                {typeof output === "string" ? output : JSON.stringify(output, null, 2)}
              </div>
            ) : (
              renderToolContent(toolName, input, output)
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function getSummary(toolName: string, input?: unknown, output?: unknown): string {
  const path = (input as { path?: string })?.path;
  switch (toolName) {
    case "readFile": return path ?? "";
    case "writeFile": return path ?? "";
    case "listFiles": {
      const count = Array.isArray(output) ? output.length : 0;
      return path ? `${path} (${count} items)` : "";
    }
    default: return "";
  }
}

function renderToolContent(toolName: string, input?: unknown, output?: unknown) {
  switch (toolName) {
    case "readFile":
      return <ReadFileRenderer input={input} output={output} />;
    case "writeFile":
      return <WriteFileRenderer input={input} output={output} />;
    case "listFiles":
      return <ListFilesRenderer input={input} output={output} />;
    default:
      return <DefaultRenderer toolName={toolName} input={input} />;
  }
}
