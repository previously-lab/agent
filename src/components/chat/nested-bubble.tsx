"use client";

/**
 * NestedBubble — one inner episode instance's answer (v0.30 §4.3, batch C).
 *
 * Seats directly after the user message it replied to (the merge view in
 * stream-items.ts puts it there), rendered in the assistant message's own
 * clothes (bare text, serif, MarkdownRenderer) so the episode reads as ONE
 * voice. The chip row above is the mechanical identity — every word on it
 * comes from the frame's fields and the i18n table (who it answers, queued /
 * answering / done-at / failed), never from a model.
 *
 * The data attributes are the screenshot/e2e contract (§4.6):
 * `data-nested-bubble` (count), `data-reply-to` (pairing), `data-bubble-status`
 * (lifecycle). Narrow screens need nothing new: the chip is its own row above
 * the answer at every width, and the list is single-column already.
 */
import { useLocale, useTranslations } from "next-intl";
import { CornerDownRight } from "lucide-react";
import { Message, MessageContent } from "@/components/ui/message";
import { MarkdownRenderer } from "./markdown";
import type { NestedBubbleFrame } from "@/lib/chat/nested-bubble";

export function NestedBubble({
  frame,
  excerpt,
}: {
  frame: NestedBubbleFrame;
  /** Mechanical excerpt of the replied-to user message (client-derived). */
  excerpt: string;
}) {
  const t = useTranslations("chat.nested");
  const locale = useLocale();
  const doneTime = frame.doneAt
    ? new Intl.DateTimeFormat(locale, {
        hour: "2-digit",
        minute: "2-digit",
      }).format(new Date(frame.doneAt))
    : null;

  return (
    <div
      className="py-1"
      data-nested-bubble
      data-reply-to={frame.replyTo}
      data-bubble-status={frame.status}
    >
      <Message align="start" className="gap-1">
        <MessageContent className="min-w-0">
          <div className="mb-1 flex items-center gap-1.5 text-xs text-muted-foreground">
            <CornerDownRight className="size-3 shrink-0" />
            <span className="min-w-0 truncate">{t("replyTo", { excerpt })}</span>
            <span aria-hidden>·</span>
            {frame.status === "queued" && (
              <span className="shrink-0">{t("queued")}</span>
            )}
            {frame.status === "running" && (
              <span className="inline-flex shrink-0 items-center gap-1">
                <span className="size-1.5 animate-pulse rounded-full bg-brand-500/70" />
                {t("running")}
              </span>
            )}
            {frame.status === "failed" && (
              <span className="shrink-0 text-destructive">{t("failed")}</span>
            )}
            {frame.status === "done" && doneTime && (
              <span className="shrink-0">{t("doneAt", { time: doneTime })}</span>
            )}
          </div>
          {/* The answer itself — done frames only. A failed instance shows
              nothing beyond the chip: the episode's merged summary states the
              failure plainly (§3.6), the chip stays the mechanical record. */}
          {frame.status === "done" && frame.text && (
            <div className="border-l-2 border-paper-line pl-3 font-serif font-light">
              <MarkdownRenderer content={frame.text} />
            </div>
          )}
        </MessageContent>
      </Message>
    </div>
  );
}
