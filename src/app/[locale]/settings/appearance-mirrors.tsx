"use client";

/**
 * Appearance mirrors (v0.25 §3.6) — the theme and language switches, given
 * a second door inside /settings. These are MIRRORS, not a second
 * implementation: the header's More menu (`NavOverflowMenu`) owns the
 * controls' logic — `useTheme().setTheme` for the theme, and
 * `router.replace(pathname, { locale })` for the language — and this
 * section calls exactly the same hooks, so both doors drive one state.
 * Labels reuse the same message keys the menu renders (nav + theme
 * namespaces), which is what keeps the two doors word-for-word identical.
 */
import { useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useTheme } from "@teispace/next-themes";
import { usePathname, useRouter } from "@/i18n/navigation";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const THEME_ORDER = ["light", "dark", "system"] as const;

export function AppearanceMirrors() {
  const tNav = useTranslations("nav");
  const tTheme = useTranslations("theme");
  const locale = useLocale();
  const pathname = usePathname();
  const router = useRouter();
  const { theme, setTheme } = useTheme();
  // Pre-mount the theme value is unknown (localStorage) — same mounted
  // guard as NavOverflowMenu, so SSR and the first client render agree.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const currentTheme = (theme ?? "system") as (typeof THEME_ORDER)[number];

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Label className="block space-y-1">
        <span className="text-xs font-normal text-muted-foreground">
          {tNav("themeLabel")}
        </span>
        <Select
          value={mounted ? currentTheme : "system"}
          onValueChange={(value) =>
            setTheme(value as (typeof THEME_ORDER)[number])
          }
        >
          <SelectTrigger className="w-full max-w-xs">
            <SelectValue>
              {(v: string) =>
                (THEME_ORDER as readonly string[]).includes(v)
                  ? tTheme(v as (typeof THEME_ORDER)[number])
                  : tTheme("system")
              }
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {THEME_ORDER.map((value) => (
              <SelectItem key={value} value={value}>
                {tTheme(value)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Label>
      <Label className="block space-y-1">
        <span className="text-xs font-normal text-muted-foreground">
          {tNav("languageLabel")}
        </span>
        <Select
          value={locale}
          onValueChange={(value) => {
            if (!value) return;
            router.replace(pathname, { locale: value });
          }}
        >
          <SelectTrigger className="w-full max-w-xs">
            {/* Items unmount with the popup — resolve the label from the raw
                value explicitly, same pattern as client-section. */}
            <SelectValue>
              {(v: string) => (v === "zh" ? tNav("chinese") : tNav("english"))}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="en">{tNav("english")}</SelectItem>
            <SelectItem value="zh">{tNav("chinese")}</SelectItem>
          </SelectContent>
        </Select>
      </Label>
    </div>
  );
}
