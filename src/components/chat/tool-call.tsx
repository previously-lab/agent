"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight, FileText, FilePlus, FolderOpen, Check, Loader2, AlertCircle } from "lucide-react";

interface ToolCallProps {
  toolName: string;
  state: string;
  output?: unknown;
  input?: unknown;
}

export function ToolCall({ toolName, state, output, input }: ToolCallProps) {
  const [open, setOpen] = useState(false);

  const isRunning = state === "input-streaming" || state === "input-available";
  const isDone = state === "output-available";
  const isError = state === "output-error";

  const icon = getToolIcon(toolName);
  const summary = getToolSummary(toolName, input, output);

  return (
    <div className="my-2">
      <button
        onClick={() => setOpen(!open)}
        className={`w-full flex items-center gap-2.5 rounded-lg border px-3 py-2 text-xs transition-colors ${
          isError
            ? "border-destructive/30 bg-destructive/5"
            : "border-border/60 bg-muted/30 hover:bg-muted/50"
        }`}
      >
        {/* Status icon */}
        <span className="shrink-0">
          {isRunning ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-500" />
          ) : isError ? (
            <AlertCircle className="h-3.5 w-3.5 text-destructive" />
          ) : isDone ? (
            <Check className="h-3.5 w-3.5 text-green-500" />
          ) : (
            <Loader2 className="h-3.5 w-3.5 text-muted-foreground" />
          )}
        </span>

        {/* Tool icon + name */}
        <span className="text-muted-foreground shrink-0">{icon}</span>
        <span className="font-medium text-muted-foreground">{toolName}</span>

        {/* Summary */}
        <span className="flex-1 text-left text-muted-foreground truncate">{summary}</span>

        {/* Expand toggle */}
        <span className="text-muted-foreground shrink-0">
          {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        </span>
      </button>

      {/* Expanded content */}
      {open && (
        <div className="mt-1 ml-6 border-l-2 border-border/60 pl-4">
          {input != null && (
            <div className="text-xs text-muted-foreground py-1">
              <span className="font-medium">Input:</span> {formatInput(input)}
            </div>
          )}
          {isDone && output != null && (
            <pre className="text-xs text-muted-foreground py-1 font-mono max-h-40 overflow-auto whitespace-pre-wrap">
              {formatOutput(output)}
            </pre>
          )}
          {isError && output != null && (
            <pre className="text-xs text-destructive py-1 font-mono max-h-40 overflow-auto whitespace-pre-wrap">
              {formatOutput(output)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

function getToolIcon(toolName: string) {
  switch (toolName) {
    case "readFile":
      return <FileText className="h-3.5 w-3.5" />;
    case "writeFile":
      return <FilePlus className="h-3.5 w-3.5" />;
    case "listFiles":
      return <FolderOpen className="h-3.5 w-3.5" />;
    default:
      return <FileText className="h-3.5 w-3.5" />;
  }
}

function getToolSummary(toolName: string, input?: unknown, output?: unknown): string {
  switch (toolName) {
    case "readFile": {
      const path = (input as { path?: string })?.path;
      const out = typeof output === "string" ? output.slice(0, 50) : "";
      return path ? `${path} → ${out}` : out;
    }
    case "writeFile": {
      const inp = input as { path?: string; content?: string };
      return inp?.path ? `${inp.path}` : "";
    }
    case "listFiles": {
      const inp = input as { path?: string };
      const arr = Array.isArray(output) ? output : [];
      return inp?.path ? `${inp.path} (${arr.length} items)` : `${arr.length} items`;
    }
    default:
      return "";
  }
}

function formatInput(input: unknown): string {
  if (typeof input === "string") return input.slice(0, 200);
  return JSON.stringify(input, null, 2).slice(0, 300);
}

function formatOutput(output: unknown): string {
  if (typeof output === "string") return output.slice(0, 500);
  return JSON.stringify(output, null, 2).slice(0, 500);
}
