"use client";

import { useMemo } from "react";
import { useTranslations } from "next-intl";
import { NumberTicker } from "@/components/ui/number-ticker";
import { relativeBetween } from "@/lib/time/relative-between";
import { TimeDisplay } from "./time-display";

// ─── Types ──────────────────────────────────────────────────────────────

interface RelativeTimeReadoutProps {
  /** The destination time — shown as the subtitle, and the label's target. */
  timestamp?: string;
  /** Roll start — the label + subtitle are computed as the delta FROM this
   *  time (the slice the viewer is currently on) TO `timestamp`. */
  from?: string;
  /** Fired once the from→to roll settles. */
  onRollComplete?: () => void;
  className?: string;
}

// ─── Component ──────────────────────────────────────────────────────────

/**
 * The relative phrase on its own — "12 分钟之前" / "3 天之后" / "12 mins ago".
 *
 * The distance from `fromIso` to `toIso`, in the app's one relative-time
 * vocabulary (`relativeBetween`), rendered as prefix + rolling count + suffix.
 * The noun is WHOLE, not a count: an earlier version of this idea composed
 * numbers by hand, which is how "12分钟" and "12 mins" end up as two code
 * paths. Here the ICU string carries the plural and the ticker carries only
 * the number that moves.
 *
 * `fallback` is what to say when the two ends cannot be compared at all — an
 * unparseable timestamp on either side. A boundary that has nothing honest to
 * say about its distance should still say something.
 *
 * NOT ANCHORED TO NOW. The travel clock is (arriving somewhere reads as "3
 * days ago" because you are coming from the present), but a boundary between
 * two conversations is a distance between THOSE two, and it is the same
 * number read in either direction — "12 minutes earlier" one way, "12 minutes
 * later" the other.
 */
export function RelativeStamp({
  fromIso,
  toIso,
  fallback,
  className = "",
}: {
  fromIso: string;
  toIso: string;
  fallback: React.ReactNode;
  className?: string;
}) {
  const t = useTranslations("relative");
  const rel = useMemo(
    () => relativeBetween(fromIso, toIso),
    [fromIso, toIso],
  );
  if (!rel) return <span className={className}>{fallback}</span>;
  if (rel.kind === "moments")
    return <span className={className}>{t(`moments.${rel.dir}`)}</span>;
  return (
    <span className={`inline-flex items-baseline gap-1 ${className}`}>
      {rel.dir === "after" && t("prefixAfter")}
      <NumberTicker value={rel.count} className="![color:inherit]" />
      {t(`${rel.unit}.${rel.dir}`, { count: rel.count })}
    </span>
  );
}

/**
 * The time-travel readout shown during slice navigation: a big relative label
 * (anchored to wall-clock NOW — yesterday reads "昨天", 3 days ago reads
 * "3天前") as the title, with the actual time as a smaller rolling subtitle
 * that rolls from `from` (the viewer's current position) to the target. The
 * label's count rolls via NumberTicker — the shared time component, in
 * monospace — straight from 0 on entry.
 */
export function RelativeTimeReadout({
  timestamp,
  from,
  onRollComplete,
  className = "",
}: RelativeTimeReadoutProps) {
  const t = useTranslations("relative");
  // The LABEL is anchored to wall-clock NOW — yesterday reads "昨天", 3 days
  // ago reads "3天前", no matter where the viewer sits in the timeline. Only
  // the subtitle's roll is anchored to `from` (the viewer's current position).
  const rel = timestamp ? relativeBetween(new Date().toISOString(), timestamp) : null;

  // The title. `moments` stays static text; a counted label is rendered as
  //  prefix + <rolling count> + suffix  (the suffix carries the ICU plural for
  //  the target count; zh needs neither a prefix nor plural forms).
  const title = (() => {
    if (!rel) return "";
    if (rel.kind === "moments") return t(`moments.${rel.dir}`);
    const prefix = rel.dir === "after" ? t("prefixAfter") : "";
    const suffix = t(`${rel.unit}.${rel.dir}`, { count: rel.count });
    // The count rolls straight from 0 the moment it enters. Unlike the
    // subtitle it has no meaningful initial value (nothing to hold a beat
    // for), so no delay — it just counts up as the readout fades in.
    return (
      <>
        {prefix}
        <NumberTicker value={rel.count} className="![color:inherit]" />
        {suffix}
      </>
    );
  })();

  return (
    <div data-testid="relative-time" className={`flex flex-col items-center gap-2 ${className}`}>
      <span className="inline-flex items-baseline gap-px text-4xl font-light tracking-tight text-foreground sm:text-5xl">
        {title}
      </span>
      {timestamp && (
        <TimeDisplay
          timestamp={timestamp}
          from={from}
          size="md"
          className="font-medium text-muted-foreground"
          onRollComplete={onRollComplete}
        />
      )}
    </div>
  );
}
