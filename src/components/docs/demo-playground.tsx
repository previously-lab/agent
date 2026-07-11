"use client";

import { useState } from "react";
import { CodeBlock } from "@/components/chat/code-block";
import { getDemoEntry } from "./demo-registry";

/**
 * Live component demo card. Renders the real component on top and its source
 * code below (with a copy button via CodeBlock). No editable editor — the
 * intent is "see it rendered + see the code that produced it," which is the
 * right trade-off for v0.1.0. An editable react-live mode can replace the
 * bottom panel in a follow-up.
 */
export function DemoPlayground({ id }: { id: string }): React.ReactElement {
  const [expanded, setExpanded] = useState(true);
  const entry = getDemoEntry(id);

  if (!entry) {
    return (
      <div className="my-4 rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
        Unknown demo: <code className="font-mono">{id}</code>
      </div>
    );
  }

  return (
    <div className="my-4 overflow-hidden rounded-lg border border-border">
      {/* Header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center justify-between border-b border-border bg-muted/50 px-4 py-2 text-left"
      >
        <span className="text-xs font-medium text-foreground/80">{entry.label}</span>
        <span className="text-xs text-muted-foreground">{expanded ? "▲" : "▼"} code</span>
      </button>
      {/* Live preview */}
      <div className="border-b border-border bg-background p-4">
        <div className="text-xs text-muted-foreground mb-2 font-medium uppercase tracking-wide">
          Preview
        </div>
        <div className="max-w-full">{entry.render()}</div>
      </div>
      {/* Source code */}
      {expanded && (
        <div className="bg-muted/20 p-4">
          <div className="text-xs text-muted-foreground mb-2 font-medium uppercase tracking-wide">
            Source
          </div>
          <CodeBlock language="tsx" code={entry.code} />
        </div>
      )}
    </div>
  );
}
