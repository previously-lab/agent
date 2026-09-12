"use client";

import { Clock } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { relativeBetween } from "./relative-time";
import type { SeamKind } from "@/lib/chat/seam";
import { dateTimeFormat } from "@/lib/time/formatter-cache";

/** Localized short date for seam headings / banners ("2月10日" / "Feb 10"). */
export function formatSeamDate(iso: string, locale: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return dateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  }).format(d);
}

/**
 * The seam's time-spine marker (v0.11 §3.1): how long passed since the
 * previous slice — "6 天" / "6 days", "12 minutes", "just now". Every turn's
 * own timestamp is hover/focus-only, so this is the ONE place the stream
 * states time; without it the conversation reads as evenly spaced and
 * timeless.
 *
 * The interval runs from the OLDER slice's last activity to the NEWER slice's
 * start — the silence between two conversations, i.e. "距上一次过了多久". The
 * ladder + thresholds come from `relativeBetween` (the time-travel readout's
 * humanizer) rather than a second one grown here.
 *
 * HONEST OR NOTHING: nothing recorded on the older side, an unparseable bound,
 * or a backwards delta (interleaved/overlapping slices in the stored data)
 * renders no marker at all — a fabricated interval is worse than a gap in the
 * spine.
 *
 * The visible text is the bare interval (mono, tabular-nums — the app's time
 * face); the full phrase rides an sr-only label, so the marker is real content
 * for assistive tech, not a decorative glyph.
 */
function SeamGap({
  fromIso,
  toIso,
  className = "",
}: {
  fromIso?: string;
  toIso: string;
  className?: string;
}) {
  const t = useTranslations("chat.seam");
  const rel = fromIso ? relativeBetween(fromIso, toIso) : null;
  // "before" = the newer slice starts at or before the older one's last
  // activity — no forward interval exists, so there is nothing honest to say.
  if (!rel || rel.dir === "before") return null;
  const gap =
    rel.kind === "moments"
      ? t("gap.justNow")
      : t(`gap.${rel.unit}`, { count: rel.count });

  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 font-mono tabular-nums ${className}`}
    >
      <Clock className="h-2.5 w-2.5 shrink-0" aria-hidden />
      <span className="sr-only">{t("gapLabel", { gap })}</span>
      <span aria-hidden>{gap}</span>
    </span>
  );
}

/**
 * The seam between two slices in the unified stream (design §1.4).
 *
 * - `checkpoint` (time_cap / capacity close): a hairline with a whisper of
 *   text — the same conversation continued across an autosave boundary, so
 *   the seam must not interrupt reading.
 * - `boundary` (idle_gap / context_lost / unknown): a strong divider with a
 *   date heading — a genuine new conversation and a natural time bookmark.
 *
 * Both carry the interval marker (v0.11 §3.1): the checkpoint's is the whisper
 * restated in time ("just now"), the boundary's is the bookmark's companion
 * ("Feb 10 · New conversation · 6 days").
 */
export function SliceSeam({
  seam,
  dateIso,
  prevActivityIso,
}: {
  seam: SeamKind;
  dateIso: string;
  /** Last activity of the OLDER slice — the interval marker measures from here
   *  to `dateIso` (v0.11 §3.1). Absent when the older slice recorded none. */
  prevActivityIso?: string;
}) {
  const t = useTranslations("chat.seam");
  const locale = useLocale();

  if (seam === "checkpoint") {
    return (
      <div className="my-3 flex items-center gap-3">
        <span className="h-px flex-1 bg-border/40" aria-hidden />
        <span className="inline-flex shrink-0 items-center gap-2 text-[0.6rem] text-muted-foreground/50">
          <span aria-hidden>{t("checkpoint")}</span>
          <SeamGap
            fromIso={prevActivityIso}
            toIso={dateIso}
            className="self-stretch border-l border-border/40 pl-2 text-muted-foreground/70"
          />
        </span>
        <span className="h-px flex-1 bg-border/40" aria-hidden />
      </div>
    );
  }

  return (
    <div className="my-6 flex items-center gap-3">
      <span className="h-px flex-1 bg-border" aria-hidden />
      <span className="inline-flex shrink-0 items-center gap-2 rounded-full border border-border/60 bg-muted/40 px-3 py-1 text-[0.65rem] font-medium text-muted-foreground">
        {t("newConversation", { date: formatSeamDate(dateIso, locale) })}
        <SeamGap
          fromIso={prevActivityIso}
          toIso={dateIso}
          className="self-stretch border-l border-border/60 pl-2 font-medium text-muted-foreground/70"
        />
      </span>
      <span className="h-px flex-1 bg-border" aria-hidden />
    </div>
  );
}
