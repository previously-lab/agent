"use client";

import type { ToolRenderState } from "@/lib/chat/tool-state";
import { Wrench } from "lucide-react";
import { ToolLayout } from "../tool-layout";

interface DefaultRendererProps {
  toolName: string;
  input?: unknown;
  state: ToolRenderState;
}

export function DefaultRenderer({ toolName, input, state }: DefaultRendererProps) {
  const name = toolName.charAt(0).toUpperCase() + toolName.slice(1);
  const summary =
    input && typeof input === "object"
      ? JSON.stringify(input).slice(0, 40)
      : "...";

  return (
    <ToolLayout
      name={name}
      icon={<Wrench className="h-3.5 w-3.5" />}
      summary={summary}
      summaryClassName="font-mono"
      state={state}
    />
  );
}
