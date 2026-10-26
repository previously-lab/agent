"use client";

import { useLocale, useTranslations } from "next-intl";
import { History } from "lucide-react";
import type { RecallReferenceAnchor } from "@/lib/chat/build-stream";
import { DocumentOpenButton } from "@/components/documents/document-navigation";
import { formatSliceIdLabel } from "@/lib/chat/slice-id-time";

/** How many slice chips render before the rest collapse into the count. */
const MAX_CHIPS = 3;

/** Recall evidence opens the source manuscript itself, whether or not the
 *  conversation's currently loaded page contains that slice. */
export function RecallReferencesBar({
  references,
}: {
  references: RecallReferenceAnchor[];
}) {
  const t = useTranslations("chat.references");
  const locale = useLocale();
  if (references.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 px-3 pt-1 text-xs text-muted-foreground">
      <History className="h-3 w-3 shrink-0" />
      <span>{t("title", { count: references.length })}</span>
      {references.slice(0, MAX_CHIPS).map((r) => (
        <DocumentOpenButton
          key={r.slice_id}
          documentRef={`records/${r.slice_id}`}
          title={r.note || undefined}
          className="rounded-full border border-border/60 bg-muted/40 px-2 py-0.5 font-mono text-[0.65rem] text-muted-foreground transition-colors hover:border-brand-500/40 hover:text-brand-600 dark:hover:text-brand-400"
        >
          {formatSliceIdLabel(r.slice_id, locale) || r.slice_id}
        </DocumentOpenButton>
      ))}
    </div>
  );
}
