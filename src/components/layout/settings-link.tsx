"use client";

import { Settings } from "lucide-react";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useTurnBusy } from "@/components/chat/turn-busy";

/**
 * Header entry to /settings. Disabled while a chat turn is in flight —
 * engine/model settings saved mid-turn would hot-apply to the next call, so
 * the entry is shielded until the current reply finishes.
 */
export function SettingsLink() {
  const t = useTranslations("nav");
  const busy = useTurnBusy();

  if (busy) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              aria-disabled="true"
              aria-label={t("settings")}
              className="flex size-7 cursor-not-allowed items-center justify-center rounded-full text-muted-foreground/50"
            >
              <Settings className="h-3.5 w-3.5 shrink-0" />
            </span>
          }
        />
        <TooltipContent side="bottom">{t("settingsBusy")}</TooltipContent>
      </Tooltip>
    );
  }

  return (
    <Link
      href="/settings"
      aria-label={t("settings")}
      title={t("settings")}
      className="flex size-7 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
    >
      <Settings className="h-3.5 w-3.5 shrink-0" />
    </Link>
  );
}
