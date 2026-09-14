"use client";

/**
 * The "继续 <date> 的对话" banner — the light top hint of a resumed
 * conversation (design §2), sitting directly above the restored turns.
 *
 * Its own module because TWO renderers now use it: the Virtuoso stream and the
 * conversation field. It used to be a local function inside the stream, which
 * made the field depend on the stream file for a presentational pill.
 */
import { History } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { formatSeamDate } from "./slice-seam";

export function ResumeBanner({ startIso }: { startIso: string }) {
  const t = useTranslations("chat.resume");
  const locale = useLocale();
  return (
    <div className="my-4 flex justify-center px-3 sm:pr-6 md:pl-0 lg:pr-8">
      <span className="inline-flex items-center gap-1.5 rounded-full border border-brand-500/25 bg-brand-500/8 px-3 py-1 text-[0.65rem] font-medium text-brand-600 dark:text-brand-400">
        <History className="h-3 w-3" />
        {t("banner", { date: formatSeamDate(startIso, locale) })}
      </span>
    </div>
  );
}
