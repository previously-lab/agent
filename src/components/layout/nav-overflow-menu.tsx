"use client";

/**
 * The right-island "···" overflow menu (v0.12 floating header) — the rest of
 * the chrome, behind one trigger:
 *
 *   Settings          → /settings
 *   Docs ↗
 *   ─────────────
 *   GitHub ↗
 *   ── Theme ──      Light / Dark / System (radio)
 *   ── Language ──   English / 中文 (radio)
 *   ── Version vX.Y.Z (+ release-notes / sync links when an update exists)
 *
 * SETTINGS AND DOCS CAME OUT OF THE BAR. They were two more glyphs in a row of
 * four, and a row of four is a toolbar: every one of them aimed at on every
 * screen, when the only one a reader reaches for mid-thought is search. Behind
 * the trigger they also get their WORDS back — a menu row has room for a label
 * and the icon row never did, which is why the bar had to be tooltips-only.
 *
 * Built on the project's Base UI dropdown-menu primitives. Radio selections
 * keep the menu open (Base UI radio items default closeOnClick=false); the
 * version rows come from VersionBadge's menu variant.
 */
import { useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useTheme } from "@teispace/next-themes";
import { BookOpen, MoreHorizontal, Settings } from "lucide-react";
import { Link, usePathname, useRouter } from "@/i18n/navigation";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { VersionBadge } from "@/components/layout/version-badge";
import { useTurnBusy } from "@/components/chat/turn-busy";

const GITHUB_URL = "https://github.com/previously-lab/agent";
const THEME_ORDER = ["light", "dark", "system"] as const;

export function NavOverflowMenu() {
  const t = useTranslations("nav");
  const tTheme = useTranslations("theme");
  const locale = useLocale();
  const pathname = usePathname();
  const router = useRouter();
  const { theme, setTheme } = useTheme();
  // Engine/model settings saved mid-turn would hot-apply to the next call, so
  // the entry is shielded until the current reply finishes. `SettingsLink`
  // owned this rule while the entry was an icon; the row owns it now.
  const busy = useTurnBusy();
  // Pre-mount the theme value is unknown (localStorage) — fall back to
  // "system" until mounted to avoid a hydration mismatch, same guard as
  // ThemeToggle.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const currentTheme = (theme ?? "system") as (typeof THEME_ORDER)[number];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        data-testid="nav-overflow-trigger"
        aria-label={t("overflow")}
        className="flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
      >
        <MoreHorizontal className="h-3.5 w-3.5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        side="bottom"
        sideOffset={8}
        className="w-44"
      >
        <DropdownMenuGroup>
          {/* Disabled, not hidden: the entry is where the reader left it, and
              the hint under it says why. A row that disappears mid-turn reads
              as a bug; one that is visibly unavailable reads as a rule. */}
          <DropdownMenuItem
            disabled={busy}
            render={busy ? undefined : <Link href="/settings" />}
          >
            <Settings />
            {t("settings")}
            {busy && (
              <span className="ml-auto pl-3 text-[10px] font-light text-muted-foreground">
                {t("settingsBusy")}
              </span>
            )}
          </DropdownMenuItem>
          <DropdownMenuItem
            render={
              <a
                href={`https://previously.ldwid.com/${locale}/docs`}
                target="_blank"
                rel="noopener noreferrer"
              />
            }
          >
            <BookOpen />
            {t("docs")}
          </DropdownMenuItem>
        </DropdownMenuGroup>

        <DropdownMenuSeparator />

        <DropdownMenuGroup>
          <DropdownMenuItem
            render={
              <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer" />
            }
          >
            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z"/></svg>
            GitHub
          </DropdownMenuItem>
        </DropdownMenuGroup>

        <DropdownMenuSeparator />

        <DropdownMenuGroup>
          <DropdownMenuLabel>{t("themeLabel")}</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={mounted ? currentTheme : "system"}
            onValueChange={(value) =>
              setTheme(value as (typeof THEME_ORDER)[number])
            }
          >
            {THEME_ORDER.map((value) => (
              <DropdownMenuRadioItem key={value} value={value}>
                {tTheme(value)}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>

        <DropdownMenuSeparator />

        <DropdownMenuGroup>
          <DropdownMenuLabel>{t("languageLabel")}</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={locale}
            onValueChange={(value) =>
              router.replace(pathname, { locale: value })
            }
          >
            <DropdownMenuRadioItem value="en">
              {t("english")}
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="zh">
              {t("chinese")}
            </DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>

        <VersionBadge variant="menu" />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
