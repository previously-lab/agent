"use client";

import { History } from "lucide-react";
import { useLocale } from "next-intl";
import type { ToolRenderState } from "@/lib/chat/tool-state";
import { parseRecordRef } from "@/lib/archive/refs";
import { recallEntryDocumentTarget } from "@/lib/documents/tool-document";
import { DocumentToolActions } from "@/components/documents/document-actions";
import { formatSliceIdLabel } from "@/lib/chat/slice-id-time";
import { ToolLayout } from "../tool-layout";

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

export function ScenarioRecallRenderer({ input, output, state, streamingText }: {
  input?: unknown; output?: unknown; state: ToolRenderState; streamingText?: string;
}) {
  const locale = useLocale();
  const zh = locale === "zh";
  const question = object(input).question;
  const result = object(output);
  const evidence = (Array.isArray(result.evidence) ? result.evidence : [])
    .map(object).filter(item => typeof item.ref === "string" && parseRecordRef(item.ref) && typeof item.quote === "string");
  const gaps = (Array.isArray(result.uncertainty) ? result.uncertainty : [])
    .filter((gap): gap is string => typeof gap === "string");
  const pending = state.running && output === undefined;
  const readError = typeof result.error === "string" && result.error.trim() ? result.error : null;
  const summary = pending
    ? streamingText || (typeof question === "string" ? question : zh ? "正在回想相关对话…" : "Recollecting the conversation…")
    : readError ?? (evidence.length > 0
      ? zh ? `${evidence.length} 段原文依据` : `${evidence.length} verified excerpt(s)`
      : zh ? "尚无足够的原文依据" : "Insufficient original evidence");
  return (
    <ToolLayout name={zh ? "回忆" : "Recollection"} icon={<History className="h-3.5 w-3.5" />}
      summary={<span className="line-clamp-1">{summary}</span>} state={state}
      meta={result.truncated ? zh ? "有限范围" : "Bounded coverage" : undefined}
      expandedContent={output === undefined ? undefined : (
        <div className="space-y-3 text-sm">
          {typeof result.answer === "string" && result.answer && <p className="whitespace-pre-wrap">{result.answer}</p>}
          {evidence.map((item, index) => {
            const ref = item.ref as string;
            const record = parseRecordRef(ref)!;
            const label = formatSliceIdLabel(record.sliceId, locale) || record.sliceId;
            return <div key={`${ref}:${String(item.turnId ?? index)}`} className="border-l-2 border-border pl-3">
              <p className="text-xs text-muted-foreground">
                {label}
                {item.role === "user" ? zh ? " · 用户" : " · User" : item.role === "assistant" ? " · Previously" : ""}
              </p>
              <blockquote className="mt-1 whitespace-pre-wrap">{item.quote as string}</blockquote>
              <DocumentToolActions
                target={recallEntryDocumentTarget(ref, label)}
                location={{
                  ...(typeof item.turnId === "string" ? { turnId: item.turnId } : {}),
                  ...(item.role === "user" || item.role === "assistant" ? { role: item.role } : {}),
                }}
                quote={item.quote as string}
                className="mt-2"
              />
            </div>;
          })}
          {gaps.length > 0 && <ul className="list-disc space-y-1 pl-4 text-xs text-muted-foreground">{gaps.map((gap, i) => <li key={i}>{gap}</li>)}</ul>}
          {typeof result.error === "string" && <p className="text-xs text-muted-foreground">{result.error}</p>}
        </div>
      )} />
  );
}
