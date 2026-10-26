"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { BookOpen, AtSign, Check } from "lucide-react";
import { useDocumentContext } from "@/components/chat/document-context-provider";
import type { DocumentContextReference } from "@/lib/chat/document-context";
import type { DocumentLinkLocation } from "@/lib/documents/document-link";
import type { ToolDocumentTarget } from "@/lib/documents/tool-document";
import { cn } from "@/lib/utils";
import { DocumentOpenButton } from "./document-navigation";

export function AddDocumentReferenceAction({
  reference,
  label,
  className,
}: {
  reference: DocumentContextReference;
  label?: string;
  className?: string;
}): React.JSX.Element {
  const t = useTranslations("chat.tool.documents");
  const { references, addReference } = useDocumentContext();
  const referenceKey = JSON.stringify(reference);
  const [outcome, setOutcome] = useState<{ key: string; accepted: boolean } | null>(null);
  const current = outcome?.key === referenceKey ? outcome : null;
  const selected = references.some((candidate) =>
    candidate.ref === reference.ref &&
    candidate.edition === reference.edition &&
    candidate.turnId === reference.turnId &&
    candidate.role === reference.role &&
    candidate.quote === reference.quote &&
    candidate.observedRevision === reference.observedRevision,
  );
  const rejected = current?.accepted === false && !selected;
  return (
    <span className="inline-flex min-w-0 items-center gap-1">
      <button
        type="button"
        className={cn(
          "inline-flex min-h-6 items-center gap-1 whitespace-nowrap rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-60",
          className,
        )}
        disabled={selected}
        onClick={() => {
          const result = addReference(reference);
          setOutcome({ key: referenceKey, accepted: result });
        }}
      >
        {selected ? <Check className="size-3" aria-hidden /> : <AtSign className="size-3" aria-hidden />}
        {selected ? t("added") : label ?? t("add")}
      </button>
      {rejected && (
        <span role="status" className="text-xs text-muted-foreground">
          {t("rejected")}
        </span>
      )}
    </span>
  );
}

export function DocumentToolActions({
  target,
  location,
  quote,
  className,
}: {
  target: ToolDocumentTarget | null;
  location?: DocumentLinkLocation;
  quote?: string;
  className?: string;
}): React.JSX.Element {
  const t = useTranslations("chat.tool.documents");
  if (!target) {
    return (
      <span className="text-xs text-muted-foreground" data-document-unavailable>
        {t("unavailable")}
      </span>
    );
  }
  const openLocation: DocumentLinkLocation = {
    edition: target.edition,
    ...location,
  };
  return (
    <div className={cn("flex flex-wrap items-center gap-x-2 gap-y-1", className)}>
      <DocumentOpenButton
        documentRef={target.ref}
        location={openLocation}
        className="inline-flex min-h-6 items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground underline decoration-border/60 underline-offset-4 transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2"
      >
        <BookOpen className="size-3" aria-hidden />
        {t("open")}
      </DocumentOpenButton>
      <AddDocumentReferenceAction
        reference={{
          ref: target.ref,
          title: target.title,
          edition: target.edition,
          ...(target.observedRevision ? { observedRevision: target.observedRevision } : {}),
          ...(quote ? { quote } : {}),
          ...(location?.turnId ? { turnId: location.turnId } : {}),
          ...(location?.role ? { role: location.role } : {}),
        }}
      />
    </div>
  );
}
