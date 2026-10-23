"use client";

/** Reader and settings chrome. The scene supplies its own compact header. */
import { Link, usePathname } from "@/i18n/navigation";
import { useTranslations } from "next-intl";
import { useBriefingIdentity } from "@/hooks/use-briefing-identity";
import { DemoBadge } from "@/components/layout/demo-badge";
import { ClientBadge } from "@/components/layout/client-badge";
import { SearchPalette } from "@/components/layout/search-palette";
import { NavOverflowMenu } from "@/components/layout/nav-overflow-menu";

export function AppHeader({ isDemo = false }: { isDemo?: boolean }) {
  const t = useTranslations("nav");
  const identity = useBriefingIdentity();
  const isHome = usePathname() === "/";

  return (
    <header
      data-app-header
      className="pointer-events-none fixed inset-x-0 top-0 z-40 flex flex-wrap items-center justify-between gap-2 px-5 py-4 sm:flex-nowrap md:px-8 md:py-5"
    >
      {!isHome && (
        <div className="pointer-events-auto flex h-9 min-w-0 items-center gap-1.5">
          <Link
            href="/"
            aria-label={`${t("brand")} ${identity?.name || t("brandYou")}`}
            className="scene-wordmark inline-flex max-w-full min-w-0 items-baseline gap-3"
          >
            <span>Previously.</span>
            <span className="hidden truncate font-sans text-xs not-italic tracking-normal text-muted-foreground sm:inline">
              {identity?.name || t("brandYou")}
            </span>
          </Link>
          {isDemo && <DemoBadge />}
          <ClientBadge />
        </div>
      )}

      {!isHome && (
        <nav className="pointer-events-auto ml-auto flex h-9 items-center gap-2 sm:ml-0">
          <SearchPalette disabled={isHome} />
          <NavOverflowMenu />
        </nav>
      )}
    </header>
  );
}
