"use client";

import type { ToolRenderState } from "@/lib/chat/tool-state";
import { deriveWriteCaseStatus } from "@/lib/chat/recall-output";
import { writeCaseDocumentTarget } from "@/lib/documents/tool-document";
import { DocumentToolActions } from "@/components/documents/document-actions";
import { CircleX, FilePen, Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { ToolLayout } from "../tool-layout";

interface WriteCaseRendererProps {
  input?: unknown;
  output?: unknown;
  state: ToolRenderState;
}

/**
 * The field agent's active write (v0.42 §2 [11279]): one call, one commit —
 * the executor flushes the batch before the call returns, so the card's
 * states are "queued" (the call is in flight, its write rides this turn's
 * commit), "committed" (ok — written, with the path), and "refused" (the
 * server's own reason, verbatim). "Written" is claimed only on the
 * committed state, never while queued.
 */
export function WriteCaseRenderer({
  input,
  output,
  state,
}: WriteCaseRendererProps) {
  const t = useTranslations("chat.tool");

  const inp = (input ?? {}) as Record<string, unknown>;
  const category =
    typeof inp.category === "string" && inp.category ? inp.category : "research";
  const caseName = typeof inp.caseName === "string" ? inp.caseName : "";
  const pieceTitle =
    typeof inp.pieceTitle === "string" && inp.pieceTitle ? inp.pieceTitle : null;
  const target = `${category}/${caseName}`;

  const status = deriveWriteCaseStatus(state.running, output);
  const documentTarget = status.kind === "committed" ? writeCaseDocumentTarget(output) : null;

  const actionLabel = (action: string): string =>
    t(`writeCase.action.${action}`, { defaultValue: action });

  const displayName =
    status.kind === "queued"
      ? t("writeCase.queuedVerb")
      : status.kind === "committed"
        ? actionLabel(status.action)
        : t("writeCase.verb");

  const summary =
    status.kind === "queued" ? (
      <span className="inline-flex items-center gap-1.5">
        <Loader2 className="h-3 w-3 animate-spin motion-reduce:animate-none" />
        {t("writeCase.queued", { target })}
      </span>
    ) : status.kind === "committed" ? (
      t("writeCase.committed", { target: documentTarget?.title ?? target })
    ) : status.kind === "refused" ? (
      t("writeCase.refused")
    ) : (
      t("writeCase.verb")
    );

  const summaryClassName =
    status.kind === "refused"
      ? "text-red-500 dark:text-red-400"
      : status.kind === "committed"
        ? undefined
        : "text-muted-foreground";

  const expandedContent =
    status.kind === "refused" ? (
      <p className="flex items-start gap-1.5 text-xs leading-relaxed text-red-500 dark:text-red-400">
        <CircleX className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span className="break-words">{status.reason}</span>
      </p>
    ) : status.kind === "committed" ? (
      <div className="space-y-2">
        {pieceTitle && (
          <p className="text-xs leading-relaxed text-foreground/90">
            {t("writeCase.piece", { title: pieceTitle })}
          </p>
        )}
        <code className="block break-all font-mono text-[10px] leading-tight text-muted-foreground">
          {status.path}
        </code>
        <DocumentToolActions target={documentTarget} />
      </div>
    ) : status.kind === "unknown" && status.raw ? (
      <pre className="font-mono text-xs leading-relaxed whitespace-pre-wrap text-muted-foreground">
        {status.raw.length > 1000 ? status.raw.slice(0, 1000) + "\n…" : status.raw}
      </pre>
    ) : undefined;

  return (
    <ToolLayout
      name={displayName}
      icon={<FilePen className="h-3.5 w-3.5" />}
      summary={summary}
      summaryClassName={summaryClassName}
      state={state}
      expandedContent={expandedContent}
    />
  );
}
