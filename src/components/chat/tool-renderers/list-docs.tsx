"use client";

import type { ToolRenderState } from "@/lib/chat/tool-state";
import { Library } from "lucide-react";
import { useTranslations } from "next-intl";
import { ToolLayout } from "../tool-layout";

interface ListDocsRendererProps {
  toolName: string;
  input?: { kind?: string; filter?: string };
  output?: { kind?: string; files?: string[]; note?: string; error?: string };
  state: ToolRenderState;
}

/**
 * listDocs renderer — the document-directory listing (v0.15 §4.2). The
 * output is a plain file-name list (date + title = birth order); the
 * expanded view shows the names, a dead/empty note when there is one, and
 * nothing else — there is no ranking to display.
 */
export function ListDocsRenderer({ toolName: _toolName, input, output, state }: ListDocsRendererProps) {
  const t = useTranslations("chat.tool");
  const kind = typeof input?.kind === "string" ? input.kind : "…";
  const files = Array.isArray(output?.files) ? output.files : [];
  const note = typeof output?.note === "string" ? output.note : null;
  const error = typeof output?.error === "string" ? output.error : null;

  const displayName = state.running
    ? t("listDocsRunning", { kind })
    : t("listDocsDone", { kind, count: files.length });

  const expandedContent = error ? (
    <p className="text-xs leading-relaxed text-muted-foreground">{error}</p>
  ) : files.length > 0 || note ? (
    <div>
      {files.length > 0 && (
        <div className="font-mono text-xs leading-relaxed text-muted-foreground">
          {files.map((f, i) => (
            <div key={i} className="flex items-center gap-2">
              <span className="text-muted-foreground">📄</span>
              <span>{f}</span>
            </div>
          ))}
        </div>
      )}
      {note && (
        <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground italic">
          {note}
        </p>
      )}
    </div>
  ) : undefined;

  return (
    <ToolLayout
      name={displayName}
      icon={<Library className="h-3.5 w-3.5" />}
      summary={
        <span className="font-mono text-muted-foreground text-xs">
          {kind}
          {typeof input?.filter === "string" && input.filter
            ? ` · ${input.filter}`
            : ""}
        </span>
      }
      meta={files.length > 0 ? t("items", { count: files.length }) : undefined}
      state={state}
      expandedContent={expandedContent}
    />
  );
}
