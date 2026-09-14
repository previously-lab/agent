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
import { NavOverflowMenu } from "@/components/layout/nav-overflow-menu";
import { BAR_CONTROL, ISLAND_BAR, ISLAND_CONTROL } from "./island";

export function AppHeader({ isDemo = false }: { isDemo?: boolean }) {
  const locale = useLocale();
  const t = useTranslations("nav");

  return (
    // THE PHONE ARRANGEMENT IS THE READER'S, and it is a wrap rather than a
    // breakpoint dance: the brand keeps the first line's left and the BOARD BAR
    // (which the shell renders, and which sits over this layout) takes its
    // right, then `w-full` forces the settings onto the second line where
    // `ml-auto` holds it to the same right edge. From `sm` up the spacer is
    // gone, all three islands share one line, and `justify-between` puts the
    // brand at the start and the settings at the end with the board bar
    // between them.
    <header className="pointer-events-none fixed inset-x-0 top-0 z-40 flex flex-wrap items-center justify-between gap-2 p-2 sm:flex-nowrap sm:p-3 md:p-4">
      {/* LEFT — brand mark + status badges (status, not actions). */}
      <div className={`pointer-events-auto ${ISLAND_BAR} gap-1.5 pr-1.5 pl-3`}>
        <Link
          href="/"
          className="text-sm font-semibold tracking-tight hover:text-foreground/80 transition-colors"
        >
          Previously
        </Link>
        {isDemo && <DemoBadge />}
        <ClientBadge />
      </div>

      {/* CENTER — the board bar (zoom lens + strand selector), which the SHELL
          renders (`shell/board-bar.tsx`). It cannot live here: the strand
          selection is shell state, and the layout's header has no access to
          it. `top-14` under `sm`, `top-3`/`top-4` above — see that file. The
          「对话 · 时间线」 pill that used to sit here is gone: it was the
          coarse half of the same axis the lens already offered. */}

      {/* RIGHT — actions, and NO WORDS. Every item here is a glyph with a
          tooltip and an accessible name; the labels were the widest thing in
          the bar and the least load-bearing, and three islands on one line at
          phone width only fit once they went. The rest folds into the "···"
          overflow menu, which keeps its own labels because it is a list a
          reader reads rather than a row of controls they aim at. */}
      <div aria-hidden className="w-full sm:hidden" />

      <nav className={`pointer-events-auto ${ISLAND_BAR} ml-auto gap-0.5 p-1 sm:ml-0`}>
        <SearchPalette />
        <SettingsLink />
        <a
          href={`https://previously.ldwid.com/${locale}/docs`}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={t("docs")}
          title={t("docs")}
          className={`${ISLAND_CONTROL} ${BAR_CONTROL}`}
        >
          <BookOpen className="h-3.5 w-3.5 shrink-0" />
        </a>
        <NavOverflowMenu />
      </nav>
    </header>
  );
}
