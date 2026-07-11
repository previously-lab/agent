"use client";

import { usePathname } from "@/i18n/navigation";
import { Link } from "@/i18n/navigation";
import { BookOpen, Settings } from "lucide-react";
import { useScrollPosition } from "@/hooks/use-scroll-position";
import { cn } from "@/lib/utils";

const NAV_ITEMS = [
  { href: "/docs", label: "Docs", icon: BookOpen },
  { href: "/settings", label: "Settings", icon: Settings },
] as const;

/**
 * Fixed header that appears on scroll — and is always visible on non-home
 * routes (docs, settings). On the home page it's transparent until the user
 * scrolls past the hero, then fades in a solid background and the compact
 * logo + nav.
 */
export function AnimatedHeader() {
  const pathname = usePathname();
  const isHome = pathname === "/";
  const { scrolled, mounted } = useScrollPosition();

  // Not home (docs / settings / etc.) → always show solid header
  const visible = !isHome || scrolled;

  if (!mounted) {
    // Plain static render before hydration — avoid layout shift
    return (
      <header className="fixed top-0 inset-x-0 z-50 h-12 border-b border-border/0 bg-background/0" />
    );
  }

  return (
    <header
      className={cn(
        "fixed top-0 inset-x-0 z-50 flex items-center justify-between h-12 px-4 sm:px-6 transition-all duration-300",
        visible
          ? "border-b border-border/80 bg-background/90 backdrop-blur-md shadow-sm"
          : "border-b border-transparent bg-transparent pointer-events-none"
      )}
    >
      {/* Left: logo — always in the DOM for layout, only visible when header is */}
      <Link
        href="/"
        className={cn(
          "text-sm font-semibold tracking-tight transition-opacity duration-300",
          visible ? "opacity-100" : "opacity-0"
        )}
      >
        Previously
      </Link>

      {/* Right: nav — same visibility rule */}
      <nav
        className={cn(
          "flex items-center gap-1 transition-opacity duration-300",
          visible ? "opacity-100" : "opacity-0"
        )}
      >
        {NAV_ITEMS.map(({ href, label, icon: Icon }) => {
          const active = pathname.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                "flex items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors",
                active
                  ? "bg-sidebar-active font-medium text-sidebar-accent-foreground"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
              )}
            >
              <Icon className="h-3.5 w-3.5 shrink-0" />
              <span className="hidden sm:inline">{label}</span>
            </Link>
          );
        })}
      </nav>
    </header>
  );
}
