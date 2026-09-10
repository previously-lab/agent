"use client";

/**
 * Floating-island chrome (v0.12) — the app is one infinite canvas with no
 * page boundaries, so the header is no longer a full-width bar. Three
 * detached pills hover over the canvas instead:
 *
 *   LEFT   brand wordmark + status badges (demo / client mode)
 *   CENTER the 「对话 · 时间线」 mode switcher pill
 *   RIGHT  high-frequency actions (search, settings, docs) + a "···"
 *          overflow menu (GitHub, theme, language, version)
 *
 * The <header> element itself is pointer-transparent; each island re-enables
 * pointer events, so canvas content underneath the gaps stays interactive
 * and scrolls beneath the frosted pills.
 */
import { Suspense } from "react";
import { Link } from "@/i18n/navigation";
import { BookOpen } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { DemoBadge } from "@/components/layout/demo-badge";
import { ClientBadge } from "@/components/layout/client-badge";
import { SettingsLink } from "@/components/layout/settings-link";
import { SearchPalette } from "@/components/layout/search-palette";
import { ModeSwitcher } from "@/components/layout/mode-switcher";
import { NavOverflowMenu } from "@/components/layout/nav-overflow-menu";

/** Shared frosted-pill shell for every island. */
const ISLAND =
  "pointer-events-auto rounded-full bg-background/75 ring-1 ring-border/60 backdrop-blur-md shadow-md";

export function AppHeader({ isDemo = false }: { isDemo?: boolean }) {
  const locale = useLocale();
  const t = useTranslations("nav");

  return (
    <header className="pointer-events-none fixed inset-x-0 top-0 z-50 flex items-start justify-between gap-2 p-2 sm:p-3 md:p-4">
      {/* LEFT — brand mark + status badges (status, not actions). */}
      <div className={`${ISLAND} flex items-center gap-1.5 py-1 pr-1.5 pl-3`}>
        <Link
          href="/"
          className="text-sm font-semibold tracking-tight hover:text-foreground/80 transition-colors"
        >
          Previously
        </Link>
        {isDemo && <DemoBadge />}
        <ClientBadge />
      </div>

      {/* CENTER — mode switcher pill. The active segment follows the
          `?view=timeline` search param. Suspense boundary required because it
          reads useSearchParams. */}
      <div className="absolute top-2 left-1/2 -translate-x-1/2 sm:top-3 md:top-4">
        <div className={`${ISLAND} p-0.5`}>
          <Suspense
            fallback={<div className="h-7 w-16 rounded-full bg-muted/40 sm:w-32" />}
          >
            <ModeSwitcher />
          </Suspense>
        </div>
      </div>

      {/* RIGHT — actions. Search / settings / docs stay exposed (icon-only on
          small screens); the rest folds into the "···" overflow menu so the
          pill survives phone widths. */}
      <nav className={`${ISLAND} flex items-center gap-0.5 py-1 pr-1 pl-1.5`}>
        <SearchPalette />
        <SettingsLink />
        <a
          href={`https://previously.ldwid.com/${locale}/docs`}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
        >
          <BookOpen className="h-3.5 w-3.5 shrink-0" />
          <span className="hidden sm:inline">{t("docs")}</span>
        </a>
        <NavOverflowMenu />
      </nav>
    </header>
  );
}
