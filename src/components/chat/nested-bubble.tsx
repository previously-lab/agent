"use client";

/**
 * NestedBubble — one episode instance's answer (v0.31 §4.3).
 *
 * Seats directly after the user message it replied to (the merge view in
 * stream-items.ts puts it there), rendered in the assistant message's own
 * clothes (bare text, serif, MarkdownRenderer) so the episode reads as ONE
 * voice. The chip row above is the mechanical identity — every word on it
 * comes from the frame's fields and the i18n table (who it answers, queued /
 * answering / done-at / failed), never from a model.
 *
 * v0.31: while the instance runs, the answer streams LIVE from the child
 * run's own durable stream (`/api/chat/[runId]/stream`) — the orchestrator's
 * stream carries only the lifecycle frames, so a slow sibling never blocks
 * anyone else's pixels. The done frame's settled text takes over the moment
 * it lands (and is what a replayed-after-completion stream provides).
 *
 * The data attributes are the screenshot/e2e contract (§4.6):
 * `data-nested-bubble` (count), `data-reply-to` (pairing), `data-bubble-status`
 * (lifecycle). Narrow screens need nothing new: the chip is its own row above
 * the answer at every width, and the list is single-column already.
 */
import { useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { CornerDownRight } from "lucide-react";
import { ConversationTurn } from "./conversation-turn";
import { MarkdownRenderer } from "./markdown";
import type { NestedBubbleFrame } from "@/lib/chat/nested-bubble";

/**
 * The child run's live answer text, read off its OWN durable stream. The
 * route replays from index 0, so a mid-answer attach (or a reload) renders
 * the whole text-so-far. Only text blocks are accumulated — the bubble is the
 * answer's face; tool calls stay mechanical (the chip states the lifecycle).
 * Returns null until the first delta lands. The reader stops at the stream's
 * end (the child's closeChildStream tail) or on abort; every failure degrades
 * silently to the done frame's settled text when it arrives.
 */
function useChildStreamText(runId: string | undefined, active: boolean): string | null {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    if (!runId || !active) return;
    const ac = new AbortController();
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(
          `/api/chat/${encodeURIComponent(runId)}/stream?startIndex=0`,
          { cache: "no-store", signal: ac.signal },
        );
        if (!res.ok || !res.body) return;
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        const order: string[] = [];
        const blocks = new Map<string, string>();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            // SSE frames are `data: {json}\n\n`; the terminator is `data: [DONE]`.
            let sep: number;
            let dirty = false;
            while ((sep = buffer.indexOf("\n\n")) >= 0) {
              const rawEvent = buffer.slice(0, sep);
              buffer = buffer.slice(sep + 2);
              for (const line of rawEvent.split("\n")) {
                if (!line.startsWith("data: ")) continue;
                const payload = line.slice(6).trim();
                if (!payload || payload === "[DONE]") continue;
                let chunk: unknown;
                try {
                  chunk = JSON.parse(payload);
                } catch {
                  continue; // a corrupt chunk is skipped, never fatal
                }
                const c = chunk as { type?: unknown; id?: unknown; delta?: unknown };
                if (
                  c.type === "text-start" &&
                  typeof c.id === "string" &&
                  !blocks.has(c.id)
                ) {
                  blocks.set(c.id, "");
                  order.push(c.id);
                  continue;
                }
                if (
                  c.type === "text-delta" &&
                  typeof c.id === "string" &&
                  typeof c.delta === "string"
                ) {
                  if (!blocks.has(c.id)) {
                    blocks.set(c.id, "");
                    order.push(c.id);
                  }
                  blocks.set(c.id, (blocks.get(c.id) ?? "") + c.delta);
                  dirty = true;
                }
              }
            }
            // One state write per network batch — a heavy delta burst inside
            // a single read() must not storm the list's re-render.
            if (dirty && !cancelled) {
              setText(
                order
                  .map((id) => blocks.get(id) ?? "")
                  .filter(Boolean)
                  .join("\n\n"),
              );
            }
          }
        } finally {
          try {
            reader.releaseLock();
          } catch {
            /* already released */
          }
        }
      } catch {
        // Aborted (unmount / the settled frame arrived) or the network dropped
        // — the done frame's settled text is the fallback, so silence is right.
      }
    })();
    return () => {
      cancelled = true;
      ac.abort();
    };
  }, [runId, active]);
  return text;
}

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
  // Live while the child runs (the running frame carries its runId); the
  // settled frame text takes over the moment it lands — `active` flips off,
  // the reader aborts, and the done text is the same answer.
  const liveText = useChildStreamText(
    frame.runId,
    frame.status === "running" && !!frame.runId,
  );
  const shownText = frame.status === "done" ? (frame.text ?? null) : liveText;
  const doneTime = frame.doneAt
    ? new Intl.DateTimeFormat(locale, {
        hour: "2-digit",
        minute: "2-digit",
      }).format(new Date(frame.doneAt))
    : null;

  return (
    <div
      data-nested-bubble
      data-reply-to={frame.replyTo}
      data-bubble-status={frame.status}
    >
      <ConversationTurn role="assistant">
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
          {/* The answer — live from the child stream while running, the
              settled frame text once done. A failed instance shows nothing
              beyond the chip: the episode's closing summary states the
              failure plainly (§3.6), the chip stays the mechanical record. */}
          {shownText && (
            <div className="conversation-prose">
              <MarkdownRenderer content={shownText} />
            </div>
          )}
      </ConversationTurn>
    </div>
  );
}
