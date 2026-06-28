"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight, Brain } from "lucide-react";

interface ThinkingStepsProps {
  content: string;
}

export function ThinkingSteps({ content }: ThinkingStepsProps) {
  const [open, setOpen] = useState(false);

  return (
    <details
      className="mb-3 border border-border rounded-md bg-muted/30"
      onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
    >
      <summary className="flex items-center gap-2 px-3 py-2 cursor-pointer text-xs text-muted-foreground hover:text-foreground select-none">
        {open ? (
          <ChevronDown className="h-3.5 w-3.5" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5" />
        )}
        <Brain className="h-3.5 w-3.5" />
        <span>Thinking</span>
      </summary>
      <div className="px-3 pb-2 text-xs text-muted-foreground whitespace-pre-wrap leading-relaxed border-t border-border/50 pt-2">
        {content}
      </div>
    </details>
  );
}
