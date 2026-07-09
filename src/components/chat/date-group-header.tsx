"use client";

import { useLocale } from "next-intl";
import { NumberTicker } from "@/components/ui/number-ticker";

interface DateGroupHeaderProps {
  yearNumber?: number;
  monthNumber: number;
  monthName: string;
  day: number;
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
}: DateGroupHeaderProps) {
  const locale = useLocale();

  if (locale === "zh") {
    return (
      <div className="flex items-baseline gap-1 pt-6 pb-2 font-mono">
        {yearNumber != null && (
          <span className="inline-flex items-baseline gap-0.5">
            <NumberTicker
              value={yearNumber}
              startValue={yearStart(yearNumber)}
              className={ITEM_CLASS}
            />
            <span className={ITEM_CLASS}>年</span>
          </span>
        )}
        <span className="inline-flex items-baseline gap-0.5">
          <NumberTicker value={monthNumber} className={ITEM_CLASS} />
          <span className={ITEM_CLASS}>月</span>
        </span>
        <span className="inline-flex items-baseline gap-0.5">
          <NumberTicker value={day} className={ITEM_CLASS} />
          <span className={ITEM_CLASS}>日</span>
        </span>
      </div>
    );
  }

  // English / other locales
  return (
    <div className="flex items-baseline gap-2 pt-6 pb-2 font-mono">
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
