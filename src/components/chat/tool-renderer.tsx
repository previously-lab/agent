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

  return (
    <div className="my-2">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2.5 rounded-lg border border-border/60 bg-muted/20 hover:bg-muted/40 px-3 py-2 text-xs transition-colors group"
      >
        {/* Status */}
        <span className={`shrink-0 ${statusColor}`}>
          {renderState === "running" ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : renderState === "error" ? (
            <AlertCircle className="h-3.5 w-3.5" />
          ) : (
            <Check className="h-3.5 w-3.5" />
          )}
        </span>

        {/* Tool name + summary */}
        <span className="font-medium text-muted-foreground">{toolName}</span>
        <span className="flex-1 text-left text-muted-foreground truncate">
          {getSummary(toolName, input, output)}
        </span>

        {/* Expand toggle */}
        <span className="text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity">
          {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        </span>
      </button>

      {/* Expanded content */}
      {open && (
        <div
          className="mt-1 ml-6 pl-4 border-l-2 border-border/60 overflow-hidden"
          style={{
            display: "grid",
            gridTemplateRows: open ? "1fr" : "0fr",
            transition: "grid-template-rows 200ms ease",
          }}
        >
          <div className="overflow-hidden">
            <div className="py-1">
              {renderToolContent(toolName, input, output)}
            </div>
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
