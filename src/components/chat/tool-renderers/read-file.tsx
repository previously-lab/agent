"use client";

import type { ToolRenderState } from "@/lib/chat/tool-state";
import { FileText } from "lucide-react";
import { useTranslations } from "next-intl";
import { ToolLayout } from "../tool-layout";
import { FileNamePill } from "../file-name-pill";

interface ReadFileRendererProps {
  input?: { path?: string };
  output?: string;
  state: ToolRenderState;
}

export function ReadFileRenderer({ input, output, state }: ReadFileRendererProps) {
  const t = useTranslations("chat.tool");
  const filePath = input?.path ?? "...";
  const content = typeof output === "string" ? output : undefined;
  const lines = content?.split("\n").length ?? 0;

  const expandedContent = content ? (
    <div className="max-h-96 overflow-auto rounded-md border border-border">
      <pre className="p-3 font-mono text-xs leading-relaxed text-muted-foreground whitespace-pre-wrap">
        {content.slice(0, 5000)}
      </pre>
    </div>
  ) : undefined;

  return (
    <ToolLayout
      name={t("readFile")}
      icon={<FileText className="h-3.5 w-3.5" />}
      summary={
        <FileNamePill filePath={filePath} error={state.error != null} />
      }
      meta={lines > 0 ? t("lines", { count: lines }) : undefined}
      errorMeta={state.error ? t("failed") : undefined}
      state={state}
      expandedContent={expandedContent}
    />
  );
}
