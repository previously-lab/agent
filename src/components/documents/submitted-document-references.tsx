"use client";

import { AtSign } from "lucide-react";
import { useTranslations } from "next-intl";
import {
  documentContextFromMetadata,
  parseDocumentContext,
  type DocumentContextReference,
  type DocumentContextSnapshot,
} from "@/lib/chat/document-context";
import { documentLabelFallback } from "@/lib/documents/document-link";
import { DocumentOpenButton } from "./document-navigation";

function referenceKey(reference: DocumentContextReference): string {
  return JSON.stringify([
    reference.ref,
    reference.edition,
    reference.turnId,
    reference.role,
    reference.quote,
    reference.observedRevision,
  ]);
}

export function SubmittedDocumentReferences({
  references,
  className = "",
}: {
  references: DocumentContextSnapshot;
  className?: string;
}): React.JSX.Element | null {
  const t = useTranslations("chat.input.references");
  const parsed = parseDocumentContext(references);
  if (parsed.length === 0) return null;
  return (
    <div className={`mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 ${className}`} data-submitted-document-references>
      <span className="text-xs text-muted-foreground">{t("selected")}</span>
      <ul className="m-0 flex min-w-0 list-none flex-wrap gap-1 p-0">
        {parsed.map((reference) => {
          const title = reference.title ?? documentLabelFallback(reference.ref) ?? reference.ref;
          return (
            <li key={referenceKey(reference)} className="flex min-w-0 max-w-full flex-col items-start">
              <DocumentOpenButton
                documentRef={reference.ref}
                location={{
                  ...(reference.turnId ? { turnId: reference.turnId } : {}),
                  ...(reference.role ? { role: reference.role } : {}),
                  ...(reference.edition ? { edition: reference.edition } : {}),
                }}
                className="inline-flex min-h-6 max-w-full items-center gap-1 rounded-full border border-border/60 bg-muted/40 px-2 py-0.5 text-left text-xs text-muted-foreground transition-colors hover:border-brand-500/40 hover:text-brand-600 focus-visible:outline-2 focus-visible:outline-offset-2 dark:hover:text-brand-400"
              >
                <AtSign className="size-3 shrink-0" aria-hidden />
                <span className="max-w-60 truncate">{title}</span>
              </DocumentOpenButton>
              {reference.quote && (
                <details className="min-w-0 max-w-full text-xs text-muted-foreground">
                  <summary className="cursor-pointer rounded px-1 py-0.5">{t("excerpt", { title })}</summary>
                  <p className="mt-1 max-w-prose whitespace-pre-wrap border-l border-border pl-2">{reference.quote}</p>
                </details>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function SubmittedDocumentReferencesFromMetadata({
  metadata,
  className,
}: {
  metadata: unknown;
  className?: string;
}): React.JSX.Element | null {
  return (
    <SubmittedDocumentReferences
      references={documentContextFromMetadata(metadata)}
      className={className}
    />
  );
}
