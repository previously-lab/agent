"use client";

import { useTranslations } from "next-intl";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

const DOCS_URL = "https://previously.ldwid.com/docs/deployment";

export function DemoBadge() {
  const t = useTranslations("demo");

  return (
    <Popover>
      <PopoverTrigger className="inline-flex items-center gap-1 rounded-full bg-primary px-2.5 py-0.5 text-[11px] font-medium text-primary-foreground hover:bg-primary/90 transition-colors cursor-pointer">
        {t("badgeLabel")}
      </PopoverTrigger>
      <PopoverContent className="w-72 text-sm">
        <div className="space-y-2">
          <p className="font-medium">{t("badgeTitle")}</p>
          <p className="text-muted-foreground text-xs">{t("badgeDesc")}</p>
          <a
            href={DOCS_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
          >
            {t("setupAction")}
          </a>
        </div>
      </PopoverContent>
    </Popover>
  );
}
