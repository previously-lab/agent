"use client";

/**
 * SliceGate — the region between two slices, where the conversation changes
 * hands. It is the ONE place in the field that is not content: a slice is
 * over, the next has not started, and the reader is crossing between them.
 *
 * WHY IT IS TALL. It used to be a hairline divider, which left the band
 * un-twisting over a region with nothing in it — the release looked like a
 * rendering gap rather than a place. Giving the crossing real height gives the
 * release an anchor: the braid opens exactly where the conversation has a
 * seam, and closes again on the other side.
 *
 * WHY IT SHOWS TWO TIMES. The gate reports where the reader is GOING, and
 * that depends on which way they are moving through it — scroll up and it
 * offers the older slice (back into the past), scroll down and it offers the
 * newer one (forward to now). Both times are rendered and CSS picks one from a
 * `data-dir` attribute the field writes on a shared ancestor.
 *
 * That is deliberately NOT React state. The direction flips while scrolling,
 * and a state change would re-render every mounted block — each of which is a
 * separate `<Html>` React root with its own provider — to swap two words.
 * An attribute on an ancestor costs a style recalculation of this element and
 * nothing else.
 *
 * `hhmm` is local time in the reader's zone, matching every other time readout
 * in the app; the date rides along for gates that cross a day, because
 * "back to 08:24" is ambiguous when 08:24 was last week.
 */

import { useLocale, useTranslations } from "next-intl";
import { hhmm } from "@/components/timeline-3d/cards";
import { formatSeamDate } from "./slice-seam";

export interface SliceGateProps {
  /** The newer slice's start — what "back to now" means at this gate. */
  dateIso: string;
  /** Last activity of the OLDER slice — what "back to the past" means. Absent
   *  on a slice that recorded none, in which case the past side falls back to
   *  the newer time rather than rendering an empty readout. */
  prevActivityIso?: string;
}

export function SliceGate({ dateIso, prevActivityIso }: SliceGateProps) {
  const t = useTranslations("chat.gate");
  const locale = useLocale();

  const newerTime = hhmm(dateIso);
  const olderIso = prevActivityIso ?? dateIso;
  const olderTime = hhmm(olderIso);

  return (
    <div
      className="my-2 flex h-24 items-center gap-3"
      role="separator"
      aria-label={t("label")}
    >
      <span className="h-px flex-1 bg-border/40" aria-hidden />

      <span className="host-past flex flex-col items-center gap-1">
        <span className="font-mono text-xl leading-none tracking-tight tabular-nums text-foreground/85">
          {olderTime}
        </span>
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground/70">
          {t("past", { date: formatSeamDate(olderIso, locale) })}
        </span>
      </span>

      <span className="host-future flex flex-col items-center gap-1">
        <span className="font-mono text-xl leading-none tracking-tight tabular-nums text-foreground/85">
          {newerTime}
        </span>
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground/70">
          {t("future", { date: formatSeamDate(dateIso, locale) })}
        </span>
      </span>

      <span className="h-px flex-1 bg-border/40" aria-hidden />
    </div>
  );
}
