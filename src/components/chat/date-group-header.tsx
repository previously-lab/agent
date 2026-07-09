"use client";

import { useLocale, useTranslations } from "next-intl";
import { NumberTicker } from "@/components/ui/number-ticker";
import { cn } from "@/lib/utils";

interface DateGroupHeaderProps {
  yearNumber?: number;
  monthNumber: number;
  monthName: string;
  day: number;
  className?: string;
}

const ITEM_CLASS =
  "text-xs font-bold font-mono text-foreground";

function yearStart(v: number) {
  return Math.max(0, v - 20);
}

export function DateGroupHeader({
  yearNumber,
  monthNumber,
  monthName,
  day,
  className,
}: DateGroupHeaderProps) {
  const locale = useLocale();
  const t = useTranslations("common.date");

  if (locale === "zh") {
    return (
      <div className={cn("flex items-baseline gap-1 pt-6 pb-2 font-mono", className)}>
        {yearNumber != null && (
          <span className="inline-flex items-baseline gap-0.5">
            <NumberTicker
              value={yearNumber}
              startValue={yearStart(yearNumber)}
              className={ITEM_CLASS}
            />
            <span className={ITEM_CLASS}>{t("year")}</span>
          </span>
        )}
        <span className="inline-flex items-baseline gap-0.5">
          <NumberTicker value={monthNumber} className={ITEM_CLASS} />
          <span className={ITEM_CLASS}>{t("month")}</span>
        </span>
        <span className="inline-flex items-baseline gap-0.5">
          <NumberTicker value={day} className={ITEM_CLASS} />
          <span className={ITEM_CLASS}>{t("day")}</span>
        </span>
      </div>
    );
  }

  // English / other locales
  return (
    <div className={cn("flex items-baseline gap-2 pt-6 pb-2 font-mono", className)}>
      <span className={ITEM_CLASS}>{monthName}</span>
      <NumberTicker value={day} className={ITEM_CLASS} />
      {yearNumber != null && (
        <NumberTicker
          value={yearNumber}
          startValue={yearStart(yearNumber)}
          className={ITEM_CLASS}
        />
      )}
    </div>
  );
}

interface SliceTimeMarkerProps {
  hour: number;
  minute: number;
}

/**
 * A slice's time-of-day (HH:MM) rendered with the same animated NumberTicker
 * style as DateGroupHeader — the "dynamic time" family extended to minutes.
 */
export function SliceTimeMarker({ hour, minute }: SliceTimeMarkerProps) {
  return (
    <span className="inline-flex items-baseline font-mono tabular-nums leading-none">
      <NumberTicker value={hour} minIntegerDigits={2} className={ITEM_CLASS} />
      <span className={ITEM_CLASS}>:</span>
      <NumberTicker value={minute} minIntegerDigits={2} className={ITEM_CLASS} />
    </span>
  );
}
