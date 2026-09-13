"use client";

/**
 * DateStamp / TimeStamp — the app's ANIMATED date and time faces.
 *
 * REVIVED, not invented. These are the retired `DateGroupHeader` and
 * `SliceTimeMarker` (deleted with the historical view), rebuilt as shared
 * components because the app is stating dates and times in more places now and
 * they should all read the same: the slice gate's intertitle, the window's
 * head, and anything that follows.
 *
 * WHY IT IS NOT `RollingField`. The odometer family next door rolls one digit
 * at a time from a fixed-width number, which is right for a clock face and
 * wrong for a date: "Aug 2" and "8月2日" are not the same shape, and a date is
 * not zero-padded. `NumberTicker` springs the whole value, so the LOCALE
 * decides the structure and the parts that happen to be numeric animate. The
 * month is a word in English and a digit in Chinese and neither is a special
 * case — the two branches below are the two shapes, nothing more.
 *
 * THE YEAR ROLLS UP FROM TWENTY YEARS BACK. A spring from 0 to 2026 spends its
 * whole visible run in the low thousands, counting through numbers that were
 * never a year; starting twenty years earlier makes the roll read as "recent
 * history ticking forward". That trick is the old component's, kept because it
 * is the difference between an animation and a slot machine.
 *
 * The year is only carried when the date is NOT this year — the same rule
 * `formatSeamDate` uses, so a stamp and a seam never disagree about whether the
 * year is worth saying.
 */

import { useMemo } from "react";
import { useLocale, useTranslations } from "next-intl";
import { NumberTicker } from "@/components/ui/number-ticker";
import { dateTimeFormat } from "@/lib/time/formatter-cache";
import { cn } from "@/lib/utils";

export interface DateStampParts {
  /** Present only when the date is outside the current year. */
  yearNumber?: number;
  monthNumber: number;
  /** The localized month NAME — used by the branches that print words. */
  monthName: string;
  day: number;
}

/** A date, decomposed for animated rendering. Pure — unit-tested. */
export function dateStampParts(
  iso: string,
  locale: string,
  now: Date = new Date(),
): DateStampParts | null {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return {
    monthNumber: d.getMonth() + 1,
    monthName: dateTimeFormat(locale, { month: "long" }).format(d),
    day: d.getDate(),
    ...(d.getFullYear() === now.getFullYear()
      ? {}
      : { yearNumber: d.getFullYear() }),
  };
}

/** A time of day in the reader's own zone, as raw numbers for the ticker. */
export function timeStampParts(
  iso: string,
): { hour: number; minute: number } | null {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return { hour: d.getHours(), minute: d.getMinutes() };
}

/** Where a year's roll STARTS — see the header note. */
function yearStart(v: number): number {
  return Math.max(0, v - 20);
}

export function DateStamp({
  timestamp,
  className,
}: {
  timestamp: string;
  className?: string;
}) {
  const locale = useLocale();
  const t = useTranslations("common.date");
  const parts = useMemo(
    () => dateStampParts(timestamp, locale),
    [timestamp, locale],
  );
  if (!parts) return null;

  const year = parts.yearNumber;
  if (locale === "zh") {
    return (
      <span className={cn("inline-flex items-baseline gap-1", className)}>
        {year != null && (
          <span className="inline-flex items-baseline">
            <NumberTicker value={year} startValue={yearStart(year)} />
            <span>{t("year")}</span>
          </span>
        )}
        <span className="inline-flex items-baseline">
          <NumberTicker value={parts.monthNumber} />
          <span>{t("month")}</span>
        </span>
        <span className="inline-flex items-baseline">
          <NumberTicker value={parts.day} />
          <span>{t("day")}</span>
        </span>
      </span>
    );
  }

  return (
    <span className={cn("inline-flex items-baseline gap-1", className)}>
      <span>{parts.monthName}</span>
      <NumberTicker value={parts.day} />
      {year != null && <NumberTicker value={year} startValue={yearStart(year)} />}
    </span>
  );
}

export function TimeStamp({
  timestamp,
  className,
}: {
  timestamp: string;
  className?: string;
}) {
  const parts = useMemo(() => timeStampParts(timestamp), [timestamp]);
  if (!parts) return null;
  return (
    <span
      className={cn(
        "inline-flex items-baseline font-mono leading-none tabular-nums",
        className,
      )}
    >
      <NumberTicker value={parts.hour} minIntegerDigits={2} />
      <span>:</span>
      <NumberTicker value={parts.minute} minIntegerDigits={2} />
    </span>
  );
}
