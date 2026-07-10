"use client";

import { useTranslations } from "next-intl";
import { Info } from "lucide-react";

/**
 * Persistent top banner shown only when DEMO_MODE is on. The public demo has no
 * auth and is strictly read-only, so this tells everyone plainly that nothing
 * they write is saved.
 */
export function DemoBanner() {
  const t = useTranslations("demo");
  return (
    <div className="fixed inset-x-0 top-0 z-50 flex items-center justify-center gap-2 bg-foreground/90 px-4 py-1.5 text-center text-xs font-medium text-background backdrop-blur">
      <Info className="h-3.5 w-3.5 shrink-0" />
      <span>{t("banner")}</span>
    </div>
  );
}
